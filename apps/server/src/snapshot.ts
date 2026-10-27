import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  mkdirSync,
  openSync,
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
import type { LeaderboardEntry } from "@polypack/geometry";
import { SPACE_NAMES, type SpacesIndex, acceptsSubmissions, isSpaceName, parseSpaceId, problemOf } from "@polypack/spaces";
import { SpaceStore, Store, StoredSpaceEntry, StoredSubmission } from "./store";

/**
 * The records snapshot: every open problem's leader with its coordinates, as one gzipped JSON file
 * per shape pair (N, M), built by the server itself once a night into a directory on its disk and
 * served at /api/snapshot. A GitHub workflow mirrors it into a release (scripts/mirror-snapshot.ts).
 *
 * A pair's file depends only on its leaders' (P, id, name, found_with, verification): every other
 * field it holds never changes. So a pair whose leaders are unchanged keeps its file, which makes
 * most nights cheap, and its bytes stay the same (no timestamps inside), which lets the mirror
 * skip it too. The build reads the leaders one pair at a time and their entries 25 at a time, and
 * pauses after each pair it writes, so that requests keep being answered while it runs.
 *
 * The site entries of the spaces (every kind of problem but flat polygons; see @polypack/spaces) follow
 * in one file per space, "space-{space}.json.gz", listed apart under the manifest's `spaces`, so
 * that `files` keeps one shape pair per entry. They follow the same rules: the leader of every
 * open problem with an entry, rebuilt only when its leaders' (problem, P, id, name) changed. A
 * space's file is rebuilt whole; the build pauses inside it as it does between pairs.
 */
export const SNAPSHOT_FORMAT = 1;
const MANIFEST = "manifest.json";
/** Entries read at once: at most 25 × 500 pieces, a few milliseconds of work. */
const CHUNK = 25;
/** Pieces of a space's file between two pauses: a fifth of the largest pair's, about 60 ms of work [CALC]. */
export const SPACE_PAUSE_PIECES = 25_000;
const FILE_NAME = /^(0|[1-9]\d{0,2})-(0|[1-9]\d{0,2})\.json\.gz$/;
const SPACE_FILE_NAME = /^space-[a-z][a-z0-9]{0,31}\.json\.gz$/;
const isFileName = (name: string) => FILE_NAME.test(name) || SPACE_FILE_NAME.test(name);

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
  /** Hash of the records the file holds (see fingerprint); an unchanged one means an unchanged file. */
  fingerprint: string;
}

/** The file of one space's site entries. */
export interface SpaceSnapshotFile {
  space: string;
  /** Name under /api/snapshot/, "space-{space}.json.gz". */
  file: string;
  records: number;
  pieces: number;
  bytes: number;
  sha256: string;
  as_of: string;
  fingerprint: string;
}

export interface SnapshotManifest {
  format: number;
  /** When the manifest was last written. */
  generated_at: string;
  /**
   * When the last complete build finished; null while the first one runs. Equal to generated_at
   * once a build has finished, and earlier while the next one is under way.
   */
  completed_at: string | null;
  /** Records and pieces of `files`, the shape pairs; each of `spaces` gives its own. */
  records: number;
  pieces: number;
  files: SnapshotFile[];
  /** One file per space with site entries; missing in manifests written before the spaces were added. */
  spaces?: SpaceSnapshotFile[];
}

/** One listed file, ready to be served; `open` opens it only when its bytes are wanted. */
export interface SnapshotFileSource {
  bytes: number;
  sha256: string;
  open(): { stream: ReadableStream<Uint8Array>; bytes: number } | null;
}

/** What /api/snapshot serves; the routes are in app.ts, which stays free of file system code. */
export interface SnapshotSource {
  manifest(): SnapshotManifest | null;
  /** A file the manifest lists; null for any other name. */
  file(name: string): SnapshotFileSource | null;
}

export const fileName = (N: number, M: number) => `${N}-${M}.json.gz`;
export const spaceFileName = (space: string) => `space-${space}.json.gz`;

export function readManifest(dir: string): SnapshotManifest | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as SnapshotManifest;
    return m.format === SNAPSHOT_FORMAT && Array.isArray(m.files) && (m.spaces === undefined || Array.isArray(m.spaces))
      ? m
      : null;
  } catch {
    return null;
  }
}

/** Whether the manifest describes a finished build, rather than one that is under way or was cut short. */
export const isComplete = (m: SnapshotManifest | null) => !!m?.completed_at && m.completed_at === m.generated_at;

function writeManifest(dir: string, m: SnapshotManifest): void {
  const tmp = join(dir, `.${MANIFEST}.tmp`);
  writeFileSync(tmp, JSON.stringify(m, null, 1) + "\n");
  renameSync(tmp, join(dir, MANIFEST));
}

export function snapshotSource(dir: string): SnapshotSource {
  return {
    manifest: () => readManifest(dir),
    file(name) {
      if (!isFileName(name)) return null;
      const m = readManifest(dir);
      const entry = [...(m?.files ?? []), ...(m?.spaces ?? [])].find((f) => f.file === name);
      if (!entry) return null;
      return {
        bytes: entry.bytes,
        sha256: entry.sha256,
        // Opened in the same synchronous step as the manifest was read, so the open file is the
        // one listed: the build renames a new file into place and writes the manifest without
        // anything in between. A file renamed over later keeps being served whole from this one.
        open() {
          let fd: number;
          try {
            fd = openSync(join(dir, name), "r");
          } catch {
            return null;
          }
          try {
            const bytes = fstatSync(fd).size;
            if (bytes !== entry.bytes) throw new Error("not the listed file");
            // closes the descriptor at the end, and when the client goes away early
            const stream = Readable.toWeb(createReadStream("", { fd })) as ReadableStream<Uint8Array>;
            return { stream, bytes };
          } catch {
            closeSync(fd);
            return null;
          }
        },
      };
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

type Leader = Pick<LeaderboardEntry, "id" | "name" | "found_with" | "verification"> & { P: number };

/** Hash of the fields of a pair's records that can change; the others never do. */
function fingerprint(records: readonly Leader[]): string {
  const h = createHash("sha256").update(`format ${SNAPSHOT_FORMAT}\n`);
  for (const r of records) h.update(JSON.stringify([r.P, r.id, r.name, r.found_with, r.verification]) + "\n");
  return h.digest("hex");
}

/**
 * The fields of a record in a space's file, in their order. They are part of the files'
 * fingerprint, so that a change of them rebuilds every space's file.
 */
export const SPACE_RECORD_FIELDS = [
  "problem",
  "P",
  "score",
  "id",
  "name",
  "software",
  "method",
  "created_at",
  "config",
] as const;

/**
 * The line of one record in a space's file. The configuration is the server's own JSON text (the
 * submission format of its space, as JSON.stringify wrote it), spliced in as stored, as
 * GET /api/spaces/entries/{id} does: every number at full precision, without parsing it again.
 */
function spaceRecordLine(e: StoredSpaceEntry, P: number): string {
  const head = JSON.stringify({
    problem: e.problem,
    P,
    score: e.score,
    id: e.id,
    name: e.name,
    software: e.software,
    method: e.method,
    created_at: e.created_at,
  });
  return `${head.slice(0, -1)},"config":${e.config}}`;
}

/** A space problem's leader, with its piece count and its place in the space's catalogue. */
type SpaceSnapshotLeader = { id: number; problem: string; name: string; P: number; order: number };

/** Hash of the fields of a space's records that can change (the name); the others never do. */
function spaceFingerprint(records: readonly SpaceSnapshotLeader[]): string {
  const h = createHash("sha256").update(`space format ${SNAPSHOT_FORMAT} ${SPACE_RECORD_FIELDS.join(",")}\n`);
  for (const r of records) h.update(JSON.stringify([r.problem, r.P, r.id, r.name]) + "\n");
  return h.digest("hex");
}

/** The spaces' site entries, for the snapshot. */
export interface SnapshotSpaces {
  store: SpaceStore;
  /** The spaces, in the order the manifest lists them. */
  names: readonly string[];
  /** An open problem's piece count and place in its space's catalogue; null for a closed or unlisted one, whose entry is left out. */
  place(space: string, problem: string): { P: number; order: number } | null;
}

/** The spaces' entries by their catalogues and domains: open problems only, as the listings show them, in catalogue order (domain problems without a record after the records, by P). */
export function snapshotSpaces(index: SpacesIndex, store: SpaceStore): SnapshotSpaces {
  const order = new Map<string, Map<string, number>>();
  return {
    store,
    names: SPACE_NAMES.filter((s) => index[s]),
    place(space, problem) {
      const cat = isSpaceName(space) ? index[space] : undefined;
      if (!cat || !isSpaceName(space)) return null;
      let at = order.get(space);
      if (!at) order.set(space, (at = new Map(cat.problems.map((q, i) => [q.id, i]))));
      const listed = cat.byId.get(problem);
      if (listed) return acceptsSubmissions(listed) ? { P: listed.P, order: at.get(problem)! } : null;
      // a problem of the space's domain without a record: after the records, by its piece count
      const parsed = parseSpaceId(space, problem);
      const p = typeof parsed === "string" ? null : problemOf(cat, parsed);
      return p && acceptsSubmissions(p) ? { P: p.P, order: cat.problems.length + p.P } : null;
    },
  };
}

export interface BuildOptions {
  store: Store;
  dir: string;
  /** Problems whose published optimum is proven: their site entries are left out, as on the records page. */
  closed: (N: number, M: number, P: number) => boolean;
  /** The spaces' site entries, one file per space after the pairs; without it the snapshot holds the pairs only. */
  spaces?: SnapshotSpaces;
  log?: (msg: string) => void;
  /** Waits after a pair (or a space) was built, given how long building it took; by default 3 times as long, at least 1 s. */
  pause?: (busyMs: number) => Promise<void>;
  /**
   * Pieces of a space's file written between two pauses (by default SPACE_PAUSE_PIECES). A space
   * file can be far larger than a pair's: every polyhedra problem with an entry would make about
   * 28 MB and 6 s of work on an Apple Silicon Mac [CALC], against 0.37 s for the largest pair.
   */
  pauseEveryPieces?: number;
  now?: () => Date;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/**
 * Builds or refreshes the snapshot in `dir`. The manifest is rewritten after every pair, so that
 * it always describes files on disk; it is marked complete at the end, and only then are the
 * files of pairs without leaders removed (with any other file it does not list). The spaces'
 * files follow the pairs, by the same rules. `built`, `kept` and `removed` count files of both.
 */
export async function buildSnapshot(opts: BuildOptions): Promise<{ built: number; kept: number; removed: number }> {
  const { store, dir, closed } = opts;
  const log = opts.log ?? (() => {});
  const pause = opts.pause ?? ((busy) => sleep(Math.max(1000, 3 * busy)));
  const now = opts.now ?? (() => new Date());
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) if (name.endsWith(".tmp")) rmSync(join(dir, name), { force: true });

  const before = readManifest(dir);
  const previous = new Map((before?.files ?? []).map((f) => [f.file, f]));
  // until a pair is reached, the manifest keeps its previous entry, whose file is still on disk
  const files = new Map(previous);
  const previousSpaces = new Map((before?.spaces ?? []).map((f) => [f.file, f]));
  const spaceFiles = new Map(previousSpaces);
  const names = opts.spaces?.names ?? [];
  const spaceRank = (space: string) => (names.includes(space) ? names.indexOf(space) : names.length);
  const manifest = (completed: boolean): SnapshotManifest => {
    const list = [...files.values()].sort((a, b) => a.N - b.N || a.M - b.M);
    const spaces = [...spaceFiles.values()].sort(
      (a, b) => spaceRank(a.space) - spaceRank(b.space) || (a.space < b.space ? -1 : a.space > b.space ? 1 : 0),
    );
    const at = now().toISOString();
    return {
      format: SNAPSHOT_FORMAT,
      generated_at: at,
      completed_at: completed ? at : (before?.completed_at ?? null),
      records: list.reduce((n, f) => n + f.records, 0),
      pieces: list.reduce((n, f) => n + f.pieces, 0),
      files: list,
      spaces,
    };
  };

  const listed = new Set<string>();
  let built = 0;
  let kept = 0;
  for (const { N, M } of await store.pairs()) {
    await yieldNow();
    const leaders = (await store.bestPerP(N, M)).filter((e) => !closed(N, M, e.P));
    if (!leaders.length) continue;
    const name = fileName(N, M);
    listed.add(name);
    const old = previous.get(name);
    if (old && old.fingerprint === fingerprint(leaders) && sizeOf(join(dir, name)) === old.bytes) {
      kept++;
      continue;
    }
    const started = performance.now();
    files.set(name, await writePair(store, dir, name, N, M, leaders, now().toISOString()));
    writeManifest(dir, manifest(false));
    built++;
    await pause(performance.now() - started);
  }

  if (opts.spaces) {
    const { store: spaceStore, place } = opts.spaces;
    for (const space of names) {
      await yieldNow();
      const leaders: SpaceSnapshotLeader[] = (await spaceStore.spaceBest(space))
        .flatMap((l) => {
          const at = place(space, l.problem);
          return at ? [{ id: l.id, problem: l.problem, name: l.name, ...at }] : [];
        })
        .sort((a, b) => a.order - b.order);
      if (!leaders.length) continue;
      const name = spaceFileName(space);
      listed.add(name);
      const old = previousSpaces.get(name);
      if (old && old.fingerprint === spaceFingerprint(leaders) && sizeOf(join(dir, name)) === old.bytes) {
        kept++;
        continue;
      }
      // writeSpace pauses as it goes, and after its last part
      spaceFiles.set(
        name,
        await writeSpace(spaceStore, dir, name, space, leaders, now().toISOString(), pause, opts.pauseEveryPieces),
      );
      writeManifest(dir, manifest(false));
      built++;
    }
  }

  for (const name of previous.keys()) if (!listed.has(name)) files.delete(name);
  for (const name of previousSpaces.keys()) if (!listed.has(name)) spaceFiles.delete(name);
  writeManifest(dir, manifest(true));
  let removed = 0;
  for (const name of readdirSync(dir))
    if (isFileName(name) && !files.has(name) && !spaceFiles.has(name)) {
      rmSync(join(dir, name), { force: true });
      removed++;
    }
  log(`[snapshot] ${built} file(s) built, ${kept} unchanged, ${removed} removed`);
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
  leaders: readonly Leader[],
  asOf: string,
): Promise<SnapshotFile> {
  // the fingerprint is of what is written, which may differ from `leaders` if entries changed meanwhile
  const written: Leader[] = [];
  let pieces = 0;
  async function* text(): AsyncGenerator<string> {
    yield `{"format":${SNAPSHOT_FORMAT},"N":${N},"M":${M},"records":[`;
    for (let i = 0; i < leaders.length; i += CHUNK) {
      const part = leaders.slice(i, i + CHUNK);
      const byId = new Map((await store.getMany(part.map((l) => l.id))).map((s) => [s.id, s]));
      const lines: string[] = [];
      for (const l of part) {
        // an entry overtaken since the leaders were read has been deleted: its problem's new
        // leader is taken instead
        let s = byId.get(l.id);
        if (!s) {
          const current = await store.leader(N, M, l.P);
          s = (current && (await store.get(current.id))) || undefined;
        }
        if (!s) continue;
        lines.push((written.length ? ",\n" : "\n") + recordLine(s));
        written.push(s);
        pieces += s.P;
      }
      if (lines.length) yield lines.join("");
      await yieldNow();
    }
    yield "\n]}\n";
  }
  const { bytes, sha256 } = await writeGzipped(dir, name, text());
  return {
    N,
    M,
    file: name,
    records: written.length,
    pieces,
    bytes,
    sha256,
    as_of: asOf,
    fingerprint: fingerprint(written),
  };
}

async function writeSpace(
  store: SpaceStore,
  dir: string,
  name: string,
  space: string,
  leaders: readonly SpaceSnapshotLeader[],
  asOf: string,
  pause: (busyMs: number) => Promise<void>,
  pauseEveryPieces = SPACE_PAUSE_PIECES,
): Promise<SpaceSnapshotFile> {
  // as in writePair, the fingerprint is of what is written
  const written: SpaceSnapshotLeader[] = [];
  let pieces = 0;
  let sincePause = 0;
  let busySince = performance.now();
  async function* text(): AsyncGenerator<string> {
    yield `{"format":${SNAPSHOT_FORMAT},"space":${JSON.stringify(space)},"records":[`;
    for (let i = 0; i < leaders.length; i += CHUNK) {
      const lines: string[] = [];
      for (const l of leaders.slice(i, i + CHUNK)) {
        // an entry overtaken since the leaders were read has been deleted: its problem's new
        // leader is taken instead
        let e = await store.spaceGet(l.id);
        if (!e) {
          const current = await store.spaceLeader(space, l.problem);
          e = current && (await store.spaceGet(current.id));
        }
        if (!e) continue;
        lines.push((written.length ? ",\n" : "\n") + spaceRecordLine(e, l.P));
        written.push({ ...l, id: e.id, name: e.name });
        pieces += l.P;
        sincePause += l.P;
      }
      if (lines.length) yield lines.join("");
      if (sincePause >= pauseEveryPieces && i + CHUNK < leaders.length) {
        await pause(performance.now() - busySince);
        sincePause = 0;
        busySince = performance.now();
      } else await yieldNow();
    }
    yield "\n]}\n";
  }
  const { bytes, sha256 } = await writeGzipped(dir, name, text());
  await pause(performance.now() - busySince);
  return {
    space,
    file: name,
    records: written.length,
    pieces,
    bytes,
    sha256,
    as_of: asOf,
    fingerprint: spaceFingerprint(written),
  };
}

/** Writes the text gzipped into a temporary file renamed into place as `name`; its size and SHA-256. */
async function writeGzipped(
  dir: string,
  name: string,
  text: AsyncIterable<string>,
): Promise<{ bytes: number; sha256: string }> {
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
  await pipeline(Readable.from(text), createGzip({ level: 6 }), tap, createWriteStream(tmp));
  renameSync(tmp, join(dir, name));
  return { bytes, sha256: hash.digest("hex") };
}

export interface ScheduleOptions extends BuildOptions {
  /** Hour of the day (UTC) at which the nightly build starts. */
  hourUtc: number;
  /**
   * Delay of the build at startup, when the snapshot is missing, unfinished (a restart cut the
   * last build short), more than a day old, or without the spaces' files that `spaces` asks for;
   * 5 minutes by default.
   */
  startDelayMs?: number;
}

/** Builds once a day at `hourUtc`, and soon after startup when the snapshot needs it. */
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
  // a manifest from before the space files existed lacks them: it is rebuilt soon, not the next night
  const fresh =
    isComplete(m) &&
    now().getTime() - Date.parse(m!.completed_at!) < 25 * 3600_000 &&
    (!opts.spaces || m!.spaces !== undefined);
  if (!fresh) {
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
