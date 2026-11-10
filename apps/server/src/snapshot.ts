import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { createGzip } from "node:zlib";
import type { LeaderboardEntry } from "@polypack/geometry";
import {
  SPACE_NAMES,
  type SpacesIndex,
  acceptsSubmissions,
  isSpaceName,
  parseSpaceId,
  problemOf,
} from "@polypack/spaces";
import { Gate } from "./limits";
import { SpaceStore, Store, StoredSpaceEntry, StoredSubmission } from "./store";

/**
 * The records snapshot: every open problem's leader with its coordinates, as one gzipped JSON file
 * per shape pair (N, M) and one per space, served at /api/snapshot. A GitHub workflow mirrors it into
 * a release (scripts/mirror-snapshot.ts).
 *
 * Since format 3 (2026-11-07) the server stores no file but a small manifest, because the files, a second
 * copy of every record's coordinates, filled the volume. Once a night it reads the leaders of every
 * pair and space (no entry, no pieces) and writes the manifest: for each file its name, counts and
 * fingerprint. A file is generated from the database when it is asked for, from the leaders at that
 * moment, which may be newer than the manifest's; the response says which in `x-snapshot-fingerprint`.
 *
 * A file depends only on its leaders' (P, id, name, found_with, verification) (a space's, on its
 * (problem, P, id, name)): every other field it holds never changes. So the fingerprint of the
 * leaders tells whether a file has changed, which lets the mirror skip it, and the manifest keeps the
 * `as_of` of a file whose fingerprint is unchanged.
 *
 * Generating reads the entries a few thousand pieces at a time and lets the event loop in between, so that
 * requests keep being answered; at most `maxConcurrent` files are generated at once, the others wait.
 */
/**
 * Format 3 (2026-11-07): the files are generated on request and the manifest has no `bytes` and `sha256`.
 * Format 2 (2026-10-27, the unit change): disk and ball pieces have diameter 1 and circle and ball containers are scored by
 * their diameter. The format number is part of every fingerprint and a manifest of another format is not read: the
 * first build after a change describes every file again.
 */
export const SNAPSHOT_FORMAT = 3;
/** The length units of the snapshot's coordinates and scores (the manifest's `units`). */
export const SNAPSHOT_UNITS = "diameter";
const MANIFEST = "manifest.json";
/** Entries read at once, at most. */
const CHUNK = 25;
/**
 * Pieces read at once, at most: the entries of a chunk are read and written in one step of the event loop, so
 * that this bounds the step. Reading, formatting and handing 1,000 pieces to the compressor take a few milliseconds
 * (a full pair of 125,250 pieces is generated in about 0.45 s with a longest event-loop gap of 10 to 15 ms, measured
 * 2026-11-07 on a Linux sandbox); the compression itself runs in zlib's own threads.
 */
export const CHUNK_PIECES = 1000;
/** Files generated at once by default. */
export const MAX_CONCURRENT = 2;
const FILE_NAME = /^(0|[1-9]\d{0,2})-(0|[1-9]\d{0,2})\.json\.gz$/;
const SPACE_FILE_NAME = /^space-[a-z][a-z0-9]{0,31}\.json\.gz$/;

export interface SnapshotFile {
  N: number;
  M: number;
  /** Name under /api/snapshot/, "{N}-{M}.json.gz". */
  file: string;
  records: number;
  pieces: number;
  /** When the leaders of the file were read. */
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
  as_of: string;
  fingerprint: string;
}

export interface SnapshotManifest {
  format: number;
  /** "diameter": disk and ball pieces have diameter 1, circle and ball containers are scored by their diameter. */
  units: string;
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
  /** One file per space with site entries. */
  spaces?: SpaceSnapshotFile[];
}

/** A file generated from the database, gzipped. */
export interface GeneratedFile {
  body: Buffer;
  /** The fingerprint of the records written, which can differ from the manifest's if they changed since. */
  fingerprint: string;
  records: number;
  pieces: number;
}

/** What /api/snapshot serves; the routes are in app.ts, which stays free of file system code. */
export interface SnapshotSource {
  manifest(): SnapshotManifest | null;
  /** Whether the current manifest lists the file. */
  has(name: string): boolean;
  /** The file as the database holds its records now; null for a name the manifest does not list. */
  generate(name: string): Promise<GeneratedFile | null>;
}

export const fileName = (N: number, M: number) => `${N}-${M}.json.gz`;
export const spaceFileName = (space: string) => `space-${space}.json.gz`;

export function readManifest(dir: string): SnapshotManifest | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as SnapshotManifest;
    return m.format === SNAPSHOT_FORMAT &&
      m.units === SNAPSHOT_UNITS &&
      Array.isArray(m.files) &&
      (m.spaces === undefined || Array.isArray(m.spaces))
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

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

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
 * fingerprint, so that a change of them describes every space's file anew.
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

/** The current leaders of a pair's open problems, by P (closed problems left out). */
async function pairLeaders(store: Store, N: number, M: number, closed: ClosedFn): Promise<Leader[]> {
  return (await store.bestPerP(N, M)).filter((e) => !closed(N, M, e.P));
}

/** The current leaders of a space's open problems with an entry, in catalogue order. */
async function spaceLeaders(spaces: SnapshotSpaces, space: string): Promise<SpaceSnapshotLeader[]> {
  const { store, place } = spaces;
  return (await store.spaceBest(space))
    .flatMap((l) => {
      const at = place(space, l.problem);
      return at ? [{ id: l.id, problem: l.problem, name: l.name, ...at }] : [];
    })
    .sort((a, b) => a.order - b.order);
}

const sumPieces = (leaders: readonly { P: number }[]) => leaders.reduce((n, l) => n + l.P, 0);

/** Problems whose published optimum is proven: their site entries are left out, as on the records page. */
type ClosedFn = (N: number, M: number, P: number) => boolean;

/** The leaders in runs of at most CHUNK entries and about CHUNK_PIECES pieces, each read and written in one step. */
function* chunked<T extends { P: number }>(leaders: readonly T[]): Generator<T[]> {
  for (let i = 0; i < leaders.length;) {
    let j = i;
    let pieces = 0;
    while (j < leaders.length && j - i < CHUNK && pieces < CHUNK_PIECES) pieces += leaders[j++].P;
    yield leaders.slice(i, j);
    i = j;
  }
}

/** The text gzipped (zlib works off the event loop), in memory, so that the answer can say what it holds before its body. */
async function gzipText(text: AsyncIterable<string>): Promise<Buffer> {
  const gz = createGzip({ level: 6 });
  const parts: Buffer[] = [];
  gz.on("data", (c: Buffer) => parts.push(c));
  const ended = new Promise<void>((resolve, reject) => {
    gz.on("end", resolve);
    gz.on("error", reject);
  });
  ended.catch(() => {});
  try {
    for await (const t of text) if (!gz.write(t)) await once(gz, "drain");
    gz.end();
    await ended;
  } catch (e) {
    gz.destroy();
    throw e;
  }
  return Buffer.concat(parts);
}

/**
 * The file of a pair as the database holds its records now. The leaders are read first and their entries a chunk at a
 * time, with the event loop let in after each; the fingerprint is of what is written, which may differ from the
 * leaders read if entries changed meanwhile.
 */
export async function generatePair(store: Store, N: number, M: number, closed: ClosedFn): Promise<GeneratedFile> {
  const leaders = await pairLeaders(store, N, M, closed);
  const written: Leader[] = [];
  async function* text(): AsyncGenerator<string> {
    yield `{"format":${SNAPSHOT_FORMAT},"N":${N},"M":${M},"records":[`;
    for (const part of chunked(leaders)) {
      const byId = new Map((await store.getMany(part.map((l) => l.id))).map((s) => [s.id, s]));
      let lines = "";
      for (const l of part) {
        // an entry overtaken since the leaders were read has been deleted: its problem's new leader is taken instead
        let s = byId.get(l.id);
        if (!s) {
          const current = await store.leader(N, M, l.P);
          s = (current && (await store.get(current.id))) || undefined;
        }
        if (!s) continue;
        lines += (written.length ? ",\n" : "\n") + recordLine(s);
        written.push(s);
      }
      if (lines) yield lines;
      await yieldNow();
    }
    yield "\n]}\n";
  }
  const body = await gzipText(text());
  return { body, fingerprint: fingerprint(written), records: written.length, pieces: sumPieces(written) };
}

/** The file of a space as the database holds its entries now, by the same rules as generatePair. */
export async function generateSpace(spaces: SnapshotSpaces, space: string): Promise<GeneratedFile> {
  const { store } = spaces;
  const leaders = await spaceLeaders(spaces, space);
  const written: SpaceSnapshotLeader[] = [];
  async function* text(): AsyncGenerator<string> {
    yield `{"format":${SNAPSHOT_FORMAT},"space":${JSON.stringify(space)},"records":[`;
    for (const part of chunked(leaders)) {
      let lines = "";
      for (const l of part) {
        let e = await store.spaceGet(l.id);
        if (!e) {
          const current = await store.spaceLeader(space, l.problem);
          e = current && (await store.spaceGet(current.id));
        }
        if (!e) continue;
        lines += (written.length ? ",\n" : "\n") + spaceRecordLine(e, l.P);
        written.push({ ...l, id: e.id, name: e.name });
      }
      if (lines) yield lines;
      await yieldNow();
    }
    yield "\n]}\n";
  }
  const body = await gzipText(text());
  return { body, fingerprint: spaceFingerprint(written), records: written.length, pieces: sumPieces(written) };
}

export interface SourceOptions {
  /** Where the build writes the manifest. */
  dir: string;
  store: Store;
  closed: ClosedFn;
  /** The spaces' site entries; without them the space files of the manifest are not served. */
  spaces?: SnapshotSpaces;
  /** Files generated at once, the others waiting in order of arrival; MAX_CONCURRENT by default. */
  maxConcurrent?: number;
}

/** Serves the manifest in `dir`, and generates the files it lists from the database. */
export function snapshotSource(opts: SourceOptions): SnapshotSource {
  const { dir, store, closed, spaces } = opts;
  const gate = new Gate(opts.maxConcurrent ?? MAX_CONCURRENT);
  // The manifest is read again only when its file was replaced: it can list thousands of files.
  let cache: {
    key: string;
    manifest: SnapshotManifest | null;
    byName: Map<string, SnapshotFile | SpaceSnapshotFile>;
  } | null = null;
  function current() {
    let key: string;
    try {
      const st = statSync(join(dir, MANIFEST));
      key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return (cache = null);
    }
    if (cache?.key === key) return cache;
    const manifest = readManifest(dir);
    const byName = new Map<string, SnapshotFile | SpaceSnapshotFile>(
      [...(manifest?.files ?? []), ...(manifest?.spaces ?? [])].map((f) => [f.file, f]),
    );
    return (cache = { key, manifest, byName });
  }
  return {
    manifest: () => current()?.manifest ?? null,
    has: (name) => current()?.byName.has(name) ?? false,
    async generate(name) {
      const entry = current()?.byName.get(name);
      if (!entry) return null;
      if ("space" in entry) {
        if (!spaces) return null;
        return gate.run(() => generateSpace(spaces, entry.space));
      }
      return gate.run(() => generatePair(store, entry.N, entry.M, closed));
    },
  };
}

export interface CleanResult {
  files: number;
  bytes: number;
}

/**
 * Deletes every data file in `dir` (`*.json.gz` and `*.tmp`), keeping the manifest: since format 3 the server
 * stores no file but that. A batch of files at a time, the event loop let in between.
 */
export async function cleanSnapshotDir(
  dir: string,
  log: (msg: string) => void = () => {},
  batch = 100,
): Promise<CleanResult> {
  const done: CleanResult = { files: 0, bytes: 0 };
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json.gz") || n.endsWith(".tmp"));
  } catch {
    // no directory yet: nothing to clean
  }
  for (let i = 0; i < names.length; i += batch) {
    await Promise.all(
      names.slice(i, i + batch).map(async (name) => {
        const path = join(dir, name);
        try {
          const st = await stat(path);
          if (!st.isFile()) return;
          await rm(path, { force: true });
          done.files++;
          done.bytes += st.size;
        } catch {
          // gone already, or not removable: the next clean-up tries again
        }
      }),
    );
    await yieldNow();
  }
  log(`[snapshot] ${done.files} stored file(s) removed, ${done.bytes} bytes freed`);
  return done;
}

export interface BuildOptions {
  store: Store;
  dir: string;
  closed: ClosedFn;
  /** The spaces' site entries, one file per space after the pairs; without it the snapshot holds the pairs only. */
  spaces?: SnapshotSpaces;
  log?: (msg: string) => void;
  now?: () => Date;
}

export interface BuildResult {
  /** Files new or whose fingerprint changed (their `as_of` is now). */
  changed: number;
  /** Files whose fingerprint is unchanged: their entry, `as_of` included, is kept. */
  kept: number;
  /** Files of the previous manifest that have no leaders any more. */
  dropped: number;
  /** The stored files deleted at the end. */
  cleaned: CleanResult;
}

/**
 * Builds or refreshes the manifest in `dir`: for each pair and space with open leaders, its counts and the fingerprint
 * of its leaders, read from the leaders alone (no entry, no pieces). The manifest is marked complete at the end, when
 * its `generated_at` is made equal to `completed_at`; until then it carries the previous `completed_at`, so that the
 * mirror waits. Stored files are deleted afterwards.
 */
export async function buildSnapshot(opts: BuildOptions): Promise<BuildResult> {
  const { store, dir, closed } = opts;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());
  mkdirSync(dir, { recursive: true });

  const before = readManifest(dir);
  // from here until the end the manifest says that a build is under way
  if (before) writeManifest(dir, { ...before, generated_at: now().toISOString() });
  const previous = new Map([...(before?.files ?? []), ...(before?.spaces ?? [])].map((f) => [f.file, f]));

  const files: SnapshotFile[] = [];
  const spaceFiles: SpaceSnapshotFile[] = [];
  const listed = new Set<string>();
  let changed = 0;
  let kept = 0;
  for (const { N, M } of await store.pairs()) {
    await yieldNow();
    const leaders = await pairLeaders(store, N, M, closed);
    if (!leaders.length) continue;
    const file = fileName(N, M);
    listed.add(file);
    const print = fingerprint(leaders);
    const old = previous.get(file) as SnapshotFile | undefined;
    if (old && old.fingerprint === print) {
      files.push(old);
      kept++;
    } else {
      files.push({
        N,
        M,
        file,
        records: leaders.length,
        pieces: sumPieces(leaders),
        as_of: now().toISOString(),
        fingerprint: print,
      });
      changed++;
    }
  }
  const names = opts.spaces?.names ?? [];
  for (const space of names) {
    await yieldNow();
    const leaders = await spaceLeaders(opts.spaces!, space);
    if (!leaders.length) continue;
    const file = spaceFileName(space);
    listed.add(file);
    const print = spaceFingerprint(leaders);
    const old = previous.get(file) as SpaceSnapshotFile | undefined;
    if (old && old.fingerprint === print) {
      spaceFiles.push(old);
      kept++;
    } else {
      spaceFiles.push({
        space,
        file,
        records: leaders.length,
        pieces: sumPieces(leaders),
        as_of: now().toISOString(),
        fingerprint: print,
      });
      changed++;
    }
  }

  const at = now().toISOString();
  writeManifest(dir, {
    format: SNAPSHOT_FORMAT,
    units: SNAPSHOT_UNITS,
    generated_at: at,
    completed_at: at,
    records: files.reduce((n, f) => n + f.records, 0),
    pieces: files.reduce((n, f) => n + f.pieces, 0),
    files,
    spaces: spaceFiles,
  });
  const dropped = [...previous.keys()].filter((f) => !listed.has(f)).length;
  const cleaned = await cleanSnapshotDir(dir, log);
  log(`[snapshot] ${changed} file(s) changed, ${kept} unchanged, ${dropped} dropped`);
  return { changed, kept, dropped, cleaned };
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

/** Deletes the stored files at once, then builds once a day at `hourUtc`, and soon after startup when the snapshot needs it. */
export function scheduleSnapshots(opts: ScheduleOptions): { stop: () => void; cleaned: Promise<CleanResult> } {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let running = false;
  // frees the volume now; a build waits for it, so that it does not meet files being deleted
  const cleaned = cleanSnapshotDir(opts.dir, log).catch((e) => {
    log(`[snapshot] clean-up failed: ${e instanceof Error ? e.message : String(e)}`);
    return { files: 0, bytes: 0 };
  });

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await cleaned;
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
  const fresh = isComplete(m) && now().getTime() - Date.parse(m!.completed_at!) < 25 * 3600_000;
  if (!fresh) {
    timer = setTimeout(run, opts.startDelayMs ?? 5 * 60_000);
    timer.unref();
  } else next();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    cleaned,
  };
}
