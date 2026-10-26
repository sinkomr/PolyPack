/**
 * Mirrors the site's records snapshot (GET /api/snapshot, built by the server every night; see
 * apps/server/src/snapshot.ts) into the GitHub release "records": one gzipped JSON file per shape
 * pair, one per space ("space-{space}.json.gz": every kind of problem but flat polygons), and manifest.json
 * listing them with their SHA-256. Run every night by
 * .github/workflows/records.yml, after the server's build.
 *
 *   GH_TOKEN=... node scripts/mirror-snapshot.ts
 *
 * - Only a finished snapshot is mirrored: while the server is building one, nothing is done.
 * - Only files whose SHA-256 differs from the release's copy (GitHub keeps each asset's digest)
 *   are downloaded and uploaded; an unchanged pair costs nothing.
 * - A file whose bytes do not match the site's manifest (the server rebuilt it meanwhile) is
 *   fetched once more after reading the manifest again, and otherwise left for the next night.
 * - The release's manifest is written last, from a fresh listing of the release, even after a
 *   failure: it lists exactly the files the release holds. Pairs and spaces that left the
 *   snapshot are deleted only after it.
 *
 * Needs the GitHub CLI (`gh`) and plain Node 24 or newer: no dependencies.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SITE = process.env.POLYPACK_SITE ?? "https://polypack.fly.dev";
const REPO = process.env.GITHUB_REPOSITORY ?? "sinkomr/PolyPack";
const TAG = "records";
const FILE_NAME = /^(0|[1-9]\d{0,2})-(0|[1-9]\d{0,2})\.json\.gz$/;
const SPACE_FILE_NAME = /^space-[a-z][a-z0-9]{0,31}\.json\.gz$/;
/** GitHub allows 1000 assets per release; the manifest is one of them. */
const MAX_FILES = 999;

export interface ManifestFile {
  N: number;
  M: number;
  file: string;
  records: number;
  pieces: number;
  bytes: number;
  sha256: string;
  as_of: string;
}

/** The file of one space's site entries. */
export interface ManifestSpaceFile {
  space: string;
  file: string;
  records: number;
  pieces: number;
  bytes: number;
  sha256: string;
  as_of: string;
}

/** A file of either list. */
export type ManifestEntry = ManifestFile | ManifestSpaceFile;

export interface Manifest {
  format: number;
  generated_at: string;
  completed_at: string | null;
  /** Records and pieces of `files`, the shape pairs; each of `spaces` gives its own. */
  records: number;
  pieces: number;
  files: ManifestFile[];
  /** Missing in manifests written before the spaces were added. */
  spaces?: ManifestSpaceFile[];
}

/** Every file a manifest lists: the pairs, then the spaces. */
export const entries = (m: Manifest | null): ManifestEntry[] => [...(m?.files ?? []), ...(m?.spaces ?? [])];

export interface Asset {
  name: string;
  size: number;
  /** "sha256:<hex>", as GitHub computes it; missing on older assets or tools. */
  digest?: string | null;
}

/** Throws unless `m` is a snapshot manifest this script understands. */
export function checkManifest(m: unknown): Manifest {
  const x = m as Manifest;
  if (!x || x.format !== 1 || !Array.isArray(x.files) || (x.spaces !== undefined && !Array.isArray(x.spaces)))
    throw new Error("not a format 1 snapshot manifest");
  const fine = (f: ManifestEntry, name: RegExp) =>
    !!f && name.test(f.file) && /^[0-9a-f]{64}$/.test(f.sha256) && Number.isInteger(f.bytes) && f.bytes > 0;
  for (const [list, name] of [
    [x.files, FILE_NAME],
    [x.spaces ?? [], SPACE_FILE_NAME],
  ] as const)
    for (const f of list)
      if (!fine(f, name)) throw new Error(`malformed manifest entry ${JSON.stringify(f).slice(0, 200)}`);
  const n = entries(x).length;
  if (n > MAX_FILES) throw new Error(`${n} files: more than a release can hold`);
  return x;
}

/** Whether the release's asset is a copy of `f`: by GitHub's digest, or else by the release's manifest and the size. */
export function holds(f: ManifestEntry, asset: Asset | undefined, release: Manifest | null): boolean {
  if (!asset || asset.size !== f.bytes) return false;
  if (asset.digest) return asset.digest === `sha256:${f.sha256}`;
  return entries(release).some((r) => r.file === f.file && r.sha256 === f.sha256);
}

/**
 * What to do: the files to fetch and upload (new or changed), and the release's assets to delete
 * once the manifest no longer lists them (pairs or spaces no longer in the snapshot).
 */
export function plan(site: Manifest, release: Manifest | null, assets: readonly Asset[]) {
  const byName = new Map(assets.map((a) => [a.name, a]));
  const upload = entries(site).filter((f) => !holds(f, byName.get(f.file), release));
  const wanted = new Set(entries(site).map((f) => f.file));
  const remove = assets
    .map((a) => a.name)
    .filter((n) => (FILE_NAME.test(n) || SPACE_FILE_NAME.test(n)) && !wanted.has(n));
  return { upload, remove };
}

/**
 * The manifest the release ends with, from a fresh listing of its assets: for each file of the
 * snapshot, the entry of the copy the release now holds (the site's, one read again during the
 * run, or the release's previous one), or nothing.
 */
export function releaseManifest(
  site: Manifest,
  release: Manifest | null,
  assets: readonly Asset[],
  uploaded: ReadonlyMap<string, ManifestEntry>,
): Manifest {
  const byName = new Map(assets.map((a) => [a.name, a]));
  const held = <F extends ManifestEntry>(list: readonly F[]): F[] =>
    list.flatMap((f) => {
      const asset = byName.get(f.file);
      // a file keeps its name and so its kind: a pair's candidates are pairs, a space's spaces
      const candidates = [uploaded.get(f.file), f, entries(release).find((r) => r.file === f.file)] as (
        F | undefined
      )[];
      const copy = candidates.find((c): c is F => !!c && holds(c, asset, release));
      if (copy) return [copy];
      // without digests, a copy uploaded in this run is known by what was uploaded
      const now = uploaded.get(f.file) as F | undefined;
      return now && asset && !asset.digest && asset.size === now.bytes ? [now] : [];
    });
  const files = held(site.files);
  return {
    ...site,
    records: files.reduce((n, f) => n + f.records, 0),
    pieces: files.reduce((n, f) => n + f.pieces, 0),
    files,
    spaces: held(site.spaces ?? []),
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

async function fetchFile(f: ManifestEntry, path: string): Promise<boolean> {
  const r = await fetch(`${SITE}/api/snapshot/${f.file}`);
  if (!r.ok) return false;
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length !== f.bytes || createHash("sha256").update(bytes).digest("hex") !== f.sha256) return false;
  writeFileSync(path, bytes);
  return true;
}

function notes(m: Manifest): string {
  const count = (n: number) => n.toLocaleString("en-US");
  const spaces = m.spaces ?? [];
  const spaceRecords = spaces.reduce((n, f) => n + f.records, 0);
  return `Every current record on ${SITE.replace(/^https?:\/\//, "")} with its coordinates: the leader of each open problem, \
one gzipped JSON file per shape pair, named \`{N}-{M}.json.gz\` (N is the piece shape, M the container shape; 0 is a circle, \
3 or more a regular polygon). The site builds the snapshot every night, and this release mirrors it.

As of ${m.completed_at ?? m.generated_at}: ${count(m.records)} records, ${count(m.pieces)} pieces, ${count(m.files.length)} files; \
and ${count(spaceRecords)} records of the other kinds of problem in ${count(spaces.length)} files.

**Download everything** with the GitHub CLI: \`gh release download ${TAG} --repo ${REPO}\`. \`manifest.json\` lists every file with its size and SHA-256.

**Format.** Each pair's file is \`{"format": 1, "N": …, "M": …, "records": [ … ]}\`, one record per line. A record has \`P\`, \`score\` (container side, or radius for a circle container), \`id\`, \`name\`, \`found_with\`, \`verification\`, \`created_at\`, \`container_phi\` and \`pieces\` as \`[x, y, theta]\`, every number at full precision. Polygon pieces have side length 1 and circle pieces radius 1; angles are in radians. The conventions are on the API page, ${SITE}/api#snapshot, and the full entry of a record, with how it was found, is at \`${SITE}/api/submissions/{id}\`.

**The other kinds of problem** (curved 2D in 2D, 2D on 3D, 3D in 3D and 3D on 4D) have one file per space, \
named \`space-{space}.json.gz\` (\`surface\`, \`curved\`, \`sphere\`, \`torus\`, \`boundary\`, \`polyhedra\`), listed under \`spaces\` in \`manifest.json\`. \
Each is \`{"format": 1, "space": …, "records": [ … ]}\`, one record per line in the order the site lists the problems. A record has \`problem\` (its id, such as \`boundary/tesseract/cube/12\`), \`P\`, \`score\`, \`id\`, \`name\`, \`software\`, \`method\`, \`created_at\` and \`config\`, the configuration in its space's submission format (${SITE}/api#spaces), every number at full precision. The full entry is at \`${SITE}/api/spaces/entries/{id}\`.

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
  let release: Manifest | null = null;
  if (assets.some((a) => a.name === "manifest.json")) {
    gh(["release", "download", TAG, "--pattern", "manifest.json", "--dir", work, "--clobber"]);
    try {
      release = checkManifest(JSON.parse(readFileSync(join(work, "manifest.json"), "utf8")));
    } catch (e) {
      console.log(`the release's manifest is unusable (${(e as Error).message})`);
    }
  }

  const { upload, remove } = plan(site, release, assets);
  console.log(`${entries(site).length} files on the site; ${upload.length} new or changed; ${remove.length} to remove`);
  const uploaded = new Map<string, ManifestEntry>();
  let failed = 0;
  try {
    let batch: ManifestEntry[] = [];
    const send = () => {
      if (!batch.length) return;
      gh(["release", "upload", TAG, ...batch.map((f) => join(work, f.file)), "--clobber"]);
      for (const f of batch) uploaded.set(f.file, f);
      batch = [];
    };
    for (const f of upload) {
      const path = join(work, f.file);
      let got: ManifestEntry | undefined = (await fetchFile(f, path)) ? f : undefined;
      if (!got) {
        // the server may have rebuilt the file since its manifest was read
        got = entries(await siteManifest()).find((g) => g.file === f.file);
        if (got && !(await fetchFile(got, path))) got = undefined;
      }
      if (got) batch.push(got);
      else {
        failed++;
        console.log(`${f.file}: could not be fetched intact; the release keeps what it had`);
      }
      if (batch.length === 20) send();
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
      `the release lists ${final.files.length} pair files, ${final.records} records, and ${final.spaces!.length} space files`,
    );
  }
  for (const name of remove) gh(["release", "delete-asset", TAG, name, "--yes"]);
  if (failed) {
    console.log(`${failed} file(s) left for the next night`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
