/**
 * Mirrors the site's records snapshot (GET /api/snapshot, a manifest the server builds every night; see
 * apps/server/src/snapshot.ts) into the GitHub release "records": one gzipped JSON file per piece
 * shape N ("n-{N}.json.gz", holding the site's file of every pair N-M as it is), one per space
 * ("space-{space}.json.gz": every kind of problem but flat polygons), and manifest.json listing them
 * with their SHA-256. Run every night by .github/workflows/records.yml, after the server's build.
 *
 *   GH_TOKEN=... node scripts/mirror-snapshot.ts
 *
 * - The site stores no file: it generates each one from its records when asked (format 3), and its
 *   manifest has a fingerprint of each file's leaders, no SHA-256. A release holds at most 1000 files, and
 *   the site has a file per pair (more than 1000 since 2026-10-27), so the pairs are gathered by piece
 *   shape: at most 99 files however many pairs fill.
 * - Only a finished snapshot is mirrored: while the server is building one, nothing is done.
 * - Changes are found by fingerprint. The release's manifest records, for each pair and space file, the
 *   fingerprint the mirror stored: the `x-snapshot-fingerprint` header of the bytes it downloaded, which
 *   are the records at that moment, possibly newer than the site's manifest. A piece shape's file is
 *   rebuilt only when one of its pairs has another fingerprint on the site's manifest than the recorded one
 *   (or is new or gone) or the release's copy is not the one its manifest lists; a space's file when its
 *   fingerprint differs or the release's copy is not the one listed. A fingerprint the release does not
 *   record (a release written before format 3) counts as changed, so the first run fetches everything.
 * - Whatever bytes the server returns are taken; the fingerprint of the header is what is recorded. A
 *   file that cannot be fetched (after a few tries) is left for the next night, with its piece shape's file.
 * - Files are fetched one at a time: the server generates each from its database and shares its CPU.
 * - The release's manifest is written last, from a fresh listing of the release, even after a
 *   failure: it lists exactly the files the release holds. Files that left the snapshot are
 *   deleted only after it; files of the old layout, one per pair, before the uploads.
 *
 * Needs the GitHub CLI (`gh`) and plain Node 24 or newer: no dependencies.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const SITE = process.env.POLYPACK_SITE ?? "https://polypack.fly.dev";
const REPO = process.env.GITHUB_REPOSITORY ?? "sinkomr/PolyPack";
const TAG = "records";
/** A pair's file on the site; in the release only in the old layout, before 2026-10-27. */
const FILE_NAME = /^(0|[1-9]\d{0,2})-(0|[1-9]\d{0,2})\.json\.gz$/;
/** The release's file of one piece shape. */
const PIECE_FILE_NAME = /^n-(0|[1-9]\d{0,2})\.json\.gz$/;
const SPACE_FILE_NAME = /^space-[a-z][a-z0-9]{0,31}\.json\.gz$/;
/** GitHub allows 1000 assets per release; the manifest is one of them. */
const MAX_FILES = 999;
/** Files of the old layout deleted in one run: a run's token may make 1000 requests an hour. */
const MAX_OLD_DELETES = 400;
/** What the release's manifest says of its layout. */
export const LAYOUT = "one file per piece shape";

/** A pair's file as the site's manifest lists it: counts and a fingerprint of its leaders, as of the night's build. */
export interface ManifestFile {
  N: number;
  M: number;
  file: string;
  records: number;
  pieces: number;
  as_of: string;
  fingerprint: string;
}

/** The file of one space's site entries. */
export interface ManifestSpaceFile {
  space: string;
  file: string;
  records: number;
  pieces: number;
  as_of: string;
  fingerprint: string;
}

/** A file of either list. */
export type ManifestEntry = ManifestFile | ManifestSpaceFile;

export interface Manifest {
  format: number;
  units?: string;
  generated_at: string;
  completed_at: string | null;
  /** Records and pieces of `files`, the shape pairs; each of `spaces` gives its own. */
  records: number;
  pieces: number;
  files: ManifestFile[];
  spaces?: ManifestSpaceFile[];
}

/** Every file a manifest lists: the pairs, then the spaces. */
export const entries = (m: Manifest | null): ManifestEntry[] => [...(m?.files ?? []), ...(m?.spaces ?? [])];

/**
 * One pair in a piece shape's file, as the mirror fetched it: its counts as read from the bytes, when they were
 * fetched, and the `x-snapshot-fingerprint` of the response, which the site's manifest is compared with next time.
 * A release written before format 3 has no fingerprint here.
 */
export interface ReleasePair {
  M: number;
  records: number;
  pieces: number;
  as_of: string;
  fingerprint?: string;
}

/** The release's file of one piece shape N: every pair N-M of the snapshot, by M. */
export interface PieceFile {
  N: number;
  file: string;
  records: number;
  pieces: number;
  /** Size and SHA-256 of the release's file, computed by the mirror. */
  bytes: number;
  sha256: string;
  /** The latest `as_of` of its pairs. */
  as_of: string;
  pairs: ReleasePair[];
}

/** The release's file of one space: the site's file as it was fetched, with the size and SHA-256 of those bytes. */
export interface ReleaseSpaceFile extends Omit<ManifestSpaceFile, "fingerprint"> {
  bytes: number;
  sha256: string;
  /** Of the response the file was fetched in; missing in a release written before format 3. */
  fingerprint?: string;
}

/** The release's manifest.json. */
export interface ReleaseManifest {
  format: number;
  units?: string;
  layout: typeof LAYOUT;
  generated_at: string;
  completed_at: string | null;
  /** Records and pieces of `files`, the piece shapes; each of `spaces` gives its own. */
  records: number;
  pieces: number;
  files: PieceFile[];
  spaces: ReleaseSpaceFile[];
}

/** A piece shape of the site's snapshot: its file in the release, and the site's pairs it gathers. */
export interface PieceGroup {
  N: number;
  file: string;
  pairs: ManifestFile[];
}

/** The site's pairs gathered by piece shape, in order of N, each by M. */
export function pieceGroups(site: Manifest): PieceGroup[] {
  const byN = new Map<number, ManifestFile[]>();
  for (const f of site.files) byN.set(f.N, [...(byN.get(f.N) ?? []), f]);
  return [...byN.entries()]
    .sort(([a], [b]) => a - b)
    .map(([N, pairs]) => ({ N, file: `n-${N}.json.gz`, pairs: pairs.sort((a, b) => a.M - b.M) }));
}

/** The entry of a piece shape's file built from `pairs` (as fetched), whose bytes are `bytes` long with this SHA-256. */
export function pieceFile(N: number, pairs: readonly ReleasePair[], bytes: number, sha256: string): PieceFile {
  return {
    N,
    file: `n-${N}.json.gz`,
    records: pairs.reduce((n, f) => n + f.records, 0),
    pieces: pairs.reduce((n, f) => n + f.pieces, 0),
    bytes,
    sha256,
    as_of: pairs.reduce((t, f) => (f.as_of > t ? f.as_of : t), ""),
    pairs: pairs.map(({ M, records, pieces, as_of, fingerprint }) => ({ M, records, pieces, as_of, fingerprint })),
  };
}

/**
 * The gzipped file of one piece shape: `{"format": F, "N": N, "pairs": [...]}`, whose pairs are the
 * site's files of the pairs, unzipped and otherwise as they are. A pair's file is a few MB at most.
 */
export function pieceFileBytes(format: number, N: number, pairs: readonly Buffer[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`{"format":${format},"N":${N},"pairs":[\n`)];
  pairs.forEach((gz, i) => parts.push(Buffer.from(i ? ",\n" : ""), gunzipSync(gz)));
  parts.push(Buffer.from("]}\n"));
  return gzipSync(Buffer.concat(parts));
}

/** What a site file holds, read from its bytes: its number of records and of pieces. Throws if it is not a snapshot file. */
export function countRecords(gz: Buffer): { records: number; pieces: number } {
  const doc = JSON.parse(gunzipSync(gz).toString("utf8")) as { records?: { P?: unknown }[] };
  if (!Array.isArray(doc.records)) throw new Error("no list of records");
  let pieces = 0;
  for (const r of doc.records) {
    if (!Number.isInteger(r?.P)) throw new Error("a record without P");
    pieces += r.P as number;
  }
  return { records: doc.records.length, pieces };
}

export interface Asset {
  name: string;
  size: number;
  /** "sha256:<hex>", as GitHub computes it; missing on older assets or tools. */
  digest?: string | null;
}

/** The format of the site's manifest this script reads: 3, whose files are generated on request. */
export const SITE_FORMAT = 3;
/**
 * The formats of the release's manifest this script reads: 1 (radius-1 disks and balls, before 2026-10-27), 2
 * (diameter 1) and 3. A release manifest of format 1 or 2 records no fingerprints, so every file counts as changed and
 * the uploads replace it.
 */
export const RELEASE_FORMATS: readonly number[] = [1, 2, 3];

const isSha = (s: unknown) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);

/** Throws unless `m` is a snapshot manifest this script understands (format 3). */
export function checkManifest(m: unknown): Manifest {
  const x = m as Manifest;
  if (!x || x.format !== SITE_FORMAT || !Array.isArray(x.files) || (x.spaces !== undefined && !Array.isArray(x.spaces)))
    throw new Error(`not a snapshot manifest of format ${SITE_FORMAT}`);
  const fine = (f: ManifestEntry, name: RegExp) =>
    !!f && name.test(f.file) && isSha(f.fingerprint) && Number.isInteger(f.records) && Number.isInteger(f.pieces);
  for (const [list, name] of [
    [x.files, FILE_NAME],
    [x.spaces ?? [], SPACE_FILE_NAME],
  ] as const)
    for (const f of list)
      if (!fine(f, name)) throw new Error(`malformed manifest entry ${JSON.stringify(f).slice(0, 200)}`);
  const n = new Set(x.files.map((f) => f.N)).size + (x.spaces ?? []).length;
  if (n > MAX_FILES) throw new Error(`${n} files: more than a release can hold`);
  return x;
}

/** The release's manifest when it is of the current layout, else null (every file is then checked by its digest). */
export function checkRelease(m: unknown): ReleaseManifest | null {
  const x = m as ReleaseManifest;
  if (
    !x ||
    x.layout !== LAYOUT ||
    !RELEASE_FORMATS.includes(x.format) ||
    !Array.isArray(x.files) ||
    !Array.isArray(x.spaces)
  )
    return null;
  // a fingerprint is optional (older releases have none), but when there is one it is a hash
  const print = (s: unknown) => s === undefined || isSha(s);
  const fine =
    x.files.every(
      (f) =>
        !!f &&
        PIECE_FILE_NAME.test(f.file) &&
        isSha(f.sha256) &&
        Array.isArray(f.pairs) &&
        f.pairs.every((p) => !!p && print(p.fingerprint)),
    ) && x.spaces.every((f) => !!f && SPACE_FILE_NAME.test(f.file) && isSha(f.sha256) && print(f.fingerprint));
  return fine ? x : null;
}

/** Whether the release's asset is a copy of `f`: by GitHub's digest, or else by the release's manifest and the size. */
export function holds(
  f: PieceFile | ReleaseSpaceFile,
  asset: Asset | undefined,
  release: ReleaseManifest | null,
): boolean {
  if (!asset || asset.size !== f.bytes) return false;
  if (asset.digest) return asset.digest === `sha256:${f.sha256}`;
  return [...(release?.files ?? []), ...(release?.spaces ?? [])].some(
    (r) => r.file === f.file && r.sha256 === f.sha256,
  );
}

/**
 * Whether a piece shape's file in the release (by its manifest entry) gathers exactly the site's pairs now: the same
 * container shapes, each with the fingerprint the site lists. A pair the release records no fingerprint for has changed.
 */
const samePairs = (held: PieceFile, group: PieceGroup) =>
  held.pairs.length === group.pairs.length &&
  held.pairs.every((p, i) => p.M === group.pairs[i].M && p.fingerprint === group.pairs[i].fingerprint);

/**
 * What to do: the piece shapes whose file is to be rebuilt (a pair new, gone or with another fingerprint than the
 * release recorded, or the release's copy not the one its manifest lists), the space files to fetch and upload
 * (another fingerprint, or the copy not the one listed), the files of the old layout to delete first, and the
 * release's files to delete once the manifest no longer lists them.
 */
export function plan(site: Manifest, release: ReleaseManifest | null, assets: readonly Asset[]) {
  const byName = new Map(assets.map((a) => [a.name, a]));
  const held = new Map((release?.files ?? []).map((f) => [f.file, f]));
  const heldSpaces = new Map((release?.spaces ?? []).map((f) => [f.file, f]));
  const groups = pieceGroups(site).filter((g) => {
    const h = held.get(g.file);
    return !(h && samePairs(h, g) && holds(h, byName.get(g.file), release));
  });
  const spaces = (site.spaces ?? []).filter((f) => {
    const h = heldSpaces.get(f.file);
    return !(h && h.fingerprint === f.fingerprint && holds(h, byName.get(f.file), release));
  });
  const wanted = new Set([...pieceGroups(site).map((g) => g.file), ...(site.spaces ?? []).map((f) => f.file)]);
  const names = assets.map((a) => a.name);
  const old = names.filter((n) => FILE_NAME.test(n));
  const remove = names.filter((n) => (PIECE_FILE_NAME.test(n) || SPACE_FILE_NAME.test(n)) && !wanted.has(n));
  return { groups, spaces, old, remove };
}

/**
 * The manifest the release ends with, from a fresh listing of its assets: for each file of the
 * snapshot, the entry of the copy the release now holds (the one uploaded in this run, or the release's
 * previous one), or nothing.
 */
export function releaseManifest(
  site: Manifest,
  release: ReleaseManifest | null,
  assets: readonly Asset[],
  uploaded: ReadonlyMap<string, PieceFile | ReleaseSpaceFile>,
): ReleaseManifest {
  const byName = new Map(assets.map((a) => [a.name, a]));
  const held = <F extends PieceFile | ReleaseSpaceFile>(names: readonly string[], previous: readonly F[]): F[] =>
    names.flatMap((name) => {
      const asset = byName.get(name);
      // a file keeps its name and so its kind: a piece shape's candidates are piece shapes, a space's spaces
      const candidates = [uploaded.get(name), previous.find((r) => r.file === name)] as (F | undefined)[];
      const copy = candidates.find((c): c is F => !!c && holds(c, asset, release));
      if (copy) return [copy];
      // without digests, a copy uploaded in this run is known by what was uploaded
      const now = uploaded.get(name) as F | undefined;
      return now && asset && !asset.digest && asset.size === now.bytes ? [now] : [];
    });
  const files = held(
    pieceGroups(site).map((g) => g.file),
    release?.files ?? [],
  );
  const { files: _pairs, spaces: _spaces, ...head } = site;
  return {
    ...head,
    layout: LAYOUT,
    records: files.reduce((n, f) => n + f.records, 0),
    pieces: files.reduce((n, f) => n + f.pieces, 0),
    files,
    spaces: held(
      (site.spaces ?? []).map((f) => f.file),
      release?.spaces ?? [],
    ),
  };
}

function gh(args: string[]): string {
  return execFileSync("gh", [...args, "--repo", REPO], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

async function siteManifest(): Promise<Manifest> {
  const r = await fetch(`${SITE}/api/snapshot`);
  if (!r.ok) throw new Error(`${SITE}/api/snapshot answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return checkManifest(await r.json());
}

/** A file as the site returned it: whatever its bytes, with the fingerprint of the records it holds. */
export interface Fetched {
  bytes: Buffer;
  fingerprint: string;
  records: number;
  pieces: number;
  /** When it was fetched. */
  at: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Tries at one file; a refused (429) or failed (5xx, network) request is made again after a wait. */
const TRIES = 4;

/**
 * The site's file, generated for this request. The `x-snapshot-fingerprint` header says which records the bytes hold;
 * null when it cannot be fetched (after a few tries), has no fingerprint or is not a snapshot file.
 */
export async function fetchFile(file: string, wait_: (ms: number) => Promise<void> = sleep): Promise<Fetched | null> {
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    let wait = attempt * 5000;
    try {
      const r = await fetch(`${SITE}/api/snapshot/${file}`);
      if (r.ok) {
        const bytes = Buffer.from(await r.arrayBuffer());
        const fingerprint = r.headers.get("x-snapshot-fingerprint") ?? "";
        try {
          if (!isSha(fingerprint)) throw new Error("no x-snapshot-fingerprint header");
          return { bytes, fingerprint, ...countRecords(bytes), at: new Date().toISOString() };
        } catch (e) {
          // what the site sent is not a snapshot file: another try would send the same
          console.log(`${file}: ${(e as Error).message}`);
          return null;
        }
      }
      console.log(`${file}: the site answered ${r.status}`);
      // the file left the snapshot, or the request is wrong: another try would not help
      if (r.status !== 429 && r.status < 500) return null;
      wait = Math.min(Math.max(Number(r.headers.get("retry-after")) || 0, wait / 1000), 120) * 1000;
    } catch (e) {
      console.log(`${file}: ${(e as Error).message}`);
    }
    if (attempt < TRIES) await wait_(wait);
  }
  return null;
}

function notes(m: ReleaseManifest): string {
  const count = (n: number) => n.toLocaleString("en-US");
  const spaces = m.spaces;
  const spaceRecords = spaces.reduce((n, f) => n + f.records, 0);
  const pairs = m.files.reduce((n, f) => n + f.pairs.length, 0);
  return `Every current record on ${SITE.replace(/^https?:\/\//, "")} with its coordinates: the leader of each open problem, \
one gzipped JSON file per piece shape, named \`n-{N}.json.gz\`, holding every container shape M for that N (N is the piece shape, \
M the container shape; 0 is a circle, 3 or more a regular polygon). The site lists the snapshot every night, and this release mirrors it.

As of ${m.completed_at ?? m.generated_at}: ${count(m.records)} records, ${count(m.pieces)} pieces, ${count(pairs)} shape pairs in ${count(m.files.length)} files; \
and ${count(spaceRecords)} records of the other kinds of problem in ${count(spaces.length)} files.

**Download everything** with the GitHub CLI: \`gh release download ${TAG} --repo ${REPO}\`. \`manifest.json\` lists every file with its size and SHA-256, and for each piece shape its pairs, each with the fingerprint of its records. One pair alone is at ${SITE}/api/snapshot/{N}-{M}.json.gz (the site generates it when asked, from its records at that moment).

**Units.** Since 2026-10-27 (\`"units": "diameter"\` in the manifest) disk and ball pieces have diameter 1 (they had radius 1) and a circle or ball container is scored by its diameter (it was scored by its radius). Every file was rebuilt in the new units; a file of format 1 uses the old ones.

**Format.** (Format 3, since 2026-11-07, only means that the site generates each file when it is asked; the files hold what format 2's did.) Each piece shape's file is \`{"format": 3, "N": …, "pairs": [ … ]}\`, and each of its pairs is \`{"format": 3, "N": …, "M": …, "records": [ … ]}\`, one record per line. A record has \`P\`, \`score\` (container side, or diameter for a circle container), \`id\`, \`name\`, \`found_with\`, \`verification\`, \`created_at\`, \`container_phi\` and \`pieces\` as \`[x, y, theta]\`, every number at full precision. Polygon pieces have side length 1 and circle pieces diameter 1; angles are in radians. The conventions are on the API page, ${SITE}/api#snapshot, and the full entry of a record, with how it was found, is at \`${SITE}/api/submissions/{id}\`.

**The other kinds of problem** (curved 2D in 2D, 2D on 3D, 3D in 3D and 3D on 4D) have one file per space, \
named \`space-{space}.json.gz\` (\`surface\`, \`curved\`, \`sphere\`, \`torus\`, \`boundary\`, \`polyhedra\`), listed under \`spaces\` in \`manifest.json\`. \
Each is \`{"format": 3, "space": …, "records": [ … ]}\`, one record per line in the order the site lists the problems. A record has \`problem\` (its id, such as \`boundary/tesseract/cube/12\`), \`P\`, \`score\`, \`id\`, \`name\`, \`software\`, \`method\`, \`created_at\` and \`config\`, the configuration in its space's submission format (${SITE}/api#spaces), every number at full precision. The full entry is at \`${SITE}/api/spaces/entries/{id}\`.

Published values from the literature, with their sources, are in [\`data/records.json\`](https://github.com/${REPO}/blob/main/data/records.json). Closed problems take no entries and are left out: those with a proven optimum, and for the spaces also those that are infeasible.
`;
}

function listAssets(): Asset[] {
  return (JSON.parse(gh(["release", "view", TAG, "--json", "assets"])) as { assets: Asset[] }).assets;
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "polypack-mirror-"));
  const site = await siteManifest();
  if (!site.completed_at || site.completed_at !== site.generated_at) {
    console.log(
      `the site's snapshot is being built (generated ${site.generated_at}); nothing to do until it is finished`,
    );
    return;
  }

  let assets: Asset[] = [];
  try {
    assets = listAssets();
  } catch {
    console.log(`creating the release "${TAG}"`);
    gh(["release", "create", TAG, "--title", "Records snapshot", "--notes", "Being filled.", "--latest=false"]);
  }
  let release: ReleaseManifest | null = null;
  if (assets.some((a) => a.name === "manifest.json")) {
    gh(["release", "download", TAG, "--pattern", "manifest.json", "--dir", work, "--clobber"]);
    try {
      release = checkRelease(JSON.parse(readFileSync(join(work, "manifest.json"), "utf8")));
    } catch (e) {
      console.log(`the release's manifest is unusable (${(e as Error).message})`);
    }
    if (!release)
      console.log(`the release's manifest is not of the layout "${LAYOUT}": every file is checked by its digest`);
  }

  const { groups, spaces, old, remove } = plan(site, release, assets);
  console.log(
    `${site.files.length} pairs in ${pieceGroups(site).length} piece shapes and ${(site.spaces ?? []).length} spaces on the site; ` +
      `${groups.length} piece shapes and ${spaces.length} spaces to upload; ${old.length} files of the old layout and ${remove.length} others to remove`,
  );
  // the old layout's files go first, or the new ones would not fit beside them; a run deletes a
  // limited number, and the uploads wait until they are gone
  for (const name of old.slice(0, MAX_OLD_DELETES)) gh(["release", "delete-asset", TAG, name, "--yes"]);
  if (old.length > MAX_OLD_DELETES) {
    console.log(`${old.length - MAX_OLD_DELETES} files of the old layout left for the next run`);
    process.exitCode = 1;
    return;
  }
  const uploaded = new Map<string, PieceFile | ReleaseSpaceFile>();
  let failed = 0;
  const started = Date.now();
  try {
    let batch: (PieceFile | ReleaseSpaceFile)[] = [];
    const send = () => {
      if (!batch.length) return;
      gh(["release", "upload", TAG, ...batch.map((f) => join(work, f.file)), "--clobber"]);
      for (const f of batch) {
        uploaded.set(f.file, f);
        rmSync(join(work, f.file));
      }
      batch = [];
    };
    let done = 0;
    for (const g of groups) {
      // the pairs one at a time: the site generates each from its database, sharing its CPU with the site
      const got: { pair: ReleasePair; bytes: Buffer }[] = [];
      for (const f of g.pairs) {
        const one = await fetchFile(f.file);
        if (!one) break;
        got.push({
          pair: { M: f.M, records: one.records, pieces: one.pieces, as_of: one.at, fingerprint: one.fingerprint },
          bytes: one.bytes,
        });
      }
      if (got.length < g.pairs.length) {
        failed++;
        console.log(`${g.file}: a pair could not be fetched; the release keeps what it had`);
        continue;
      }
      const bytes = pieceFileBytes(
        site.format,
        g.N,
        got.map((x) => x.bytes),
      );
      writeFileSync(join(work, g.file), bytes);
      batch.push(
        pieceFile(
          g.N,
          got.map((x) => x.pair),
          bytes.length,
          createHash("sha256").update(bytes).digest("hex"),
        ),
      );
      if (batch.length === 10) send();
      console.log(
        `${g.file}: ${g.pairs.length} pairs fetched (${++done} of ${groups.length} piece shapes, ${Math.round((Date.now() - started) / 60000)} min)`,
      );
    }
    for (const f of spaces) {
      const one = await fetchFile(f.file);
      if (one) {
        writeFileSync(join(work, f.file), one.bytes);
        batch.push({
          space: f.space,
          file: f.file,
          records: one.records,
          pieces: one.pieces,
          as_of: one.at,
          fingerprint: one.fingerprint,
          bytes: one.bytes.length,
          sha256: createHash("sha256").update(one.bytes).digest("hex"),
        });
      } else {
        failed++;
        console.log(`${f.file}: could not be fetched; the release keeps what it had`);
      }
    }
    send();
  } finally {
    // whatever happened above, the manifest describes what the release now holds
    const final = releaseManifest(site, release, listAssets(), uploaded);
    writeFileSync(join(work, "manifest.json"), JSON.stringify(final, null, 1) + "\n");
    gh(["release", "upload", TAG, join(work, "manifest.json"), "--clobber"]);
    writeFileSync(join(work, "notes.md"), notes(final));
    gh(["release", "edit", TAG, "--notes-file", join(work, "notes.md")]);
    console.log(
      `the release lists ${final.files.length} piece shape files, ${final.records} records, and ${final.spaces.length} space files`,
    );
  }
  for (const name of remove) gh(["release", "delete-asset", TAG, name, "--yes"]);
  if (failed) {
    console.log(`${failed} file(s) left for the next night`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
