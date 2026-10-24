import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { ProblemLeader, Store, StoredSubmission } from "./store";

/**
 * The records snapshot: every open problem's leader with its coordinates, as one gzipped JSON file
 * per shape pair (N, M), built by the server itself once a night into a directory on its disk and
 * served at /api/snapshot. A GitHub workflow mirrors it into a release (scripts/mirror-snapshot.ts).
 *
 * A pair's file depends only on its leaders' (P, id, name, found_with, verification): every other
 * field it holds never changes. So a pair whose leaders are unchanged keeps its file, which makes
 * most nights cheap, and its bytes stay the same (no timestamps inside), which lets the mirror
 * skip it too. The build reads 25 entries at a time and pauses after each pair, so that requests
 * keep being answered while it runs.
 */
export const SNAPSHOT_FORMAT = 1;
const MANIFEST = "manifest.json";
/** Entries read at once: at most 25 × 500 pieces, a few milliseconds of work. */
const CHUNK = 25;
const FILE_NAME = /^(0|[1-9]\d{0,2})-(0|[1-9]\d{0,2})\.json\.gz$/;

export interface SnapshotFile {
  N: number;
  M: number;
  /** Name under /api/snapshot/, "{N}-{M}.json.gz". */
  file: string;
  records: number;
  pieces: number;
  bytes: number;
  sha256: string;
  /** When the leaders in the file were read. */
  as_of: string;
  /** Hash of the leaders the file was built from; an unchanged one means an unchanged file. */
  fingerprint: string;
}

export interface SnapshotManifest {
  format: number;
  /** When the manifest was last written. */
  generated_at: string;
  /** When the last complete build finished; null while the first one runs. */
  completed_at: string | null;
  records: number;
  pieces: number;
  files: SnapshotFile[];
}

/** What /api/snapshot serves; the routes are in app.ts, which stays free of file system code. */
export interface SnapshotSource {
  manifest(): SnapshotManifest | null;
  /** A file the manifest lists, as a stream; null for any other name. */
  file(name: string): { stream: ReadableStream<Uint8Array>; bytes: number; sha256: string } | null;
}

export const fileName = (N: number, M: number) => `${N}-${M}.json.gz`;

export function readManifest(dir: string): SnapshotManifest | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as SnapshotManifest;
    return m.format === SNAPSHOT_FORMAT && Array.isArray(m.files) ? m : null;
  } catch {
    return null;
  }
}

function writeManifest(dir: string, m: SnapshotManifest): void {
  const tmp = join(dir, `.${MANIFEST}.tmp`);
  writeFileSync(tmp, JSON.stringify(m, null, 1) + "\n");
  renameSync(tmp, join(dir, MANIFEST));
}

export function snapshotSource(dir: string): SnapshotSource {
  return {
    manifest: () => readManifest(dir),
    file(name) {
      if (!FILE_NAME.test(name)) return null;
      const entry = readManifest(dir)?.files.find((f) => f.file === name);
      if (!entry) return null;
      try {
        const path = join(dir, name);
        const bytes = statSync(path).size;
        return { stream: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, bytes, sha256: entry.sha256 };
      } catch {
        return null;
      }
    },
  };
}

/** The line of one record in a pair's file: pieces as [x, y, theta], every number at full precision. */
function recordLine(s: StoredSubmission): string {
  return JSON.stringify({
    P: s.P,
    score: s.score,
    id: s.id,
    name: s.name,
    found_with: s.found_with,
    verification: s.verification,
    created_at: s.created_at,
    container_phi: s.container_phi,
    pieces: s.pieces.map((p) => [p.x, p.y, p.theta]),
  });
}

function fingerprint(leaders: readonly ProblemLeader[]): string {
  const h = createHash("sha256").update(`format ${SNAPSHOT_FORMAT}\n`);
  for (const l of leaders) h.update(JSON.stringify([l.P, l.id, l.name, l.found_with, l.verification]) + "\n");
  return h.digest("hex");
}

export interface BuildOptions {
  store: Store;
  dir: string;
  /** Problems whose published optimum is proven: their site entries are left out, as on the records page. */
  closed: (N: number, M: number, P: number) => boolean;
  log?: (msg: string) => void;
  /** Waits after a pair was built, given how long building it took; by default 3 times as long, at least 1 s. */
  pause?: (busyMs: number) => Promise<void>;
  now?: () => Date;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/**
 * Builds or refreshes the snapshot in `dir`. The manifest is rewritten after every pair, so that
 * it always describes the files on disk; files of pairs that no longer have a leader are removed.
 */
export async function buildSnapshot(opts: BuildOptions): Promise<{ built: number; kept: number; removed: number }> {
  const { store, dir, closed } = opts;
  const log = opts.log ?? (() => {});
  const pause = opts.pause ?? ((busy) => sleep(Math.max(1000, 3 * busy)));
  const now = opts.now ?? (() => new Date());
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) if (name.endsWith(".tmp")) rmSync(join(dir, name), { force: true });

  const previous = new Map((readManifest(dir)?.files ?? []).map((f) => [f.file, f]));
  const asOf = now().toISOString();
  const pairs = new Map<string, ProblemLeader[]>();
  for (const l of await store.leaders()) {
    if (closed(l.N, l.M, l.P)) continue;
    const key = fileName(l.N, l.M);
    const list = pairs.get(key);
    if (list) list.push(l);
    else pairs.set(key, [l]);
  }

  const files = new Map<string, SnapshotFile>();
  // until a pair is reached, the manifest keeps its previous entry, whose file is still on disk
  for (const [name, f] of previous) if (pairs.has(name)) files.set(name, f);
  const manifest = (completed: boolean): SnapshotManifest => {
    const list = [...files.values()].sort((a, b) => a.N - b.N || a.M - b.M);
    return {
      format: SNAPSHOT_FORMAT,
      generated_at: now().toISOString(),
      completed_at: completed ? now().toISOString() : (readManifest(dir)?.completed_at ?? null),
      records: list.reduce((n, f) => n + f.records, 0),
      pieces: list.reduce((n, f) => n + f.pieces, 0),
      files: list,
    };
  };

  let built = 0;
  let kept = 0;
  for (const [name, leaders] of pairs) {
    const { N, M } = leaders[0];
    const print = fingerprint(leaders);
    const old = previous.get(name);
    if (old && old.fingerprint === print && sizeOf(join(dir, name)) === old.bytes) {
      kept++;
      continue;
    }
    const started = performance.now();
    const entry = await writePair(store, dir, name, N, M, leaders, print, asOf);
    files.set(name, entry);
    writeManifest(dir, manifest(false));
    built++;
    await pause(performance.now() - started);
  }

  let removed = 0;
  for (const name of previous.keys())
    if (!pairs.has(name)) {
      rmSync(join(dir, name), { force: true });
      removed++;
    }
  writeManifest(dir, manifest(true));
  log(`[snapshot] ${built} pair(s) built, ${kept} unchanged, ${removed} removed`);
  return { built, kept, removed };
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

async function writePair(
  store: Store,
  dir: string,
  name: string,
  N: number,
  M: number,
  leaders: readonly ProblemLeader[],
  print: string,
  asOf: string,
): Promise<SnapshotFile> {
  let records = 0;
  let pieces = 0;
  async function* text(): AsyncGenerator<string> {
    yield `{"format":${SNAPSHOT_FORMAT},"N":${N},"M":${M},"records":[`;
    for (let i = 0; i < leaders.length; i += CHUNK) {
      const part = leaders.slice(i, i + CHUNK);
      const byId = new Map((await store.getMany(part.map((l) => l.id))).map((s) => [s.id, s]));
      const lines: string[] = [];
      for (const l of part) {
        // an entry overtaken since the leaders were read has been deleted: its problem's new
        // leader is taken instead, and the next build sees the change in the fingerprint
        let s = byId.get(l.id);
        if (!s) {
          const now = await store.leader(l.N, l.M, l.P);
          s = (now && (await store.get(now.id))) || undefined;
        }
        if (!s) continue;
        lines.push((records ? ",\n" : "\n") + recordLine(s));
        records++;
        pieces += s.P;
      }
      if (lines.length) yield lines.join("");
      await yieldNow();
    }
    yield "\n]}\n";
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  const tmp = join(dir, `.${name}.tmp`);
  await pipeline(Readable.from(text()), createGzip({ level: 6 }), tap, createWriteStream(tmp));
  renameSync(tmp, join(dir, name));
  return { N, M, file: name, records, pieces, bytes, sha256: hash.digest("hex"), as_of: asOf, fingerprint: print };
}

export interface ScheduleOptions extends BuildOptions {
  /** Hour of the day (UTC) at which the nightly build starts. */
  hourUtc: number;
  /** Delay of the build at startup, when the snapshot is missing or more than a day old; 5 minutes by default. */
  startDelayMs?: number;
}

/** Builds once a day at `hourUtc`, and soon after startup when the snapshot is missing or stale. */
export function scheduleSnapshots(opts: ScheduleOptions): { stop: () => void } {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let running = false;

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await buildSnapshot(opts);
    } catch (e) {
      log(`[snapshot] build failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
      next();
    }
  };
  const next = () => {
    if (stopped) return;
    const t = now();
    const at = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), opts.hourUtc));
    if (at.getTime() <= t.getTime()) at.setUTCDate(at.getUTCDate() + 1);
    timer = setTimeout(run, at.getTime() - t.getTime());
    timer.unref();
  };

  const m = readManifest(opts.dir);
  const done = m?.completed_at ? Date.parse(m.completed_at) : NaN;
  if (!(now().getTime() - done < 25 * 3600_000)) {
    timer = setTimeout(run, opts.startDelayMs ?? 5 * 60_000);
    timer.unref();
  } else next();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
