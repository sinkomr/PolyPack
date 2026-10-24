/**
 * Mirrors the site's records snapshot (GET /api/snapshot, built by the server every night; see
 * apps/server/src/snapshot.ts) into the GitHub release "records": one gzipped JSON file per shape
 * pair, and manifest.json listing them with their SHA-256. Run every night by
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
 *   failure: it lists exactly the files the release holds. Pairs that left the snapshot are
 *   deleted only after it.
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

export interface Manifest {
  format: number;
  generated_at: string;
  completed_at: string | null;
  records: number;
  pieces: number;
  files: ManifestFile[];
}

export interface Asset {
  name: string;
  size: number;
  /** "sha256:<hex>", as GitHub computes it; missing on older assets or tools. */
  digest?: string | null;
}

/** Throws unless `m` is a snapshot manifest this script understands. */
export function checkManifest(m: unknown): Manifest {
  const x = m as Manifest;
  if (!x || x.format !== 1 || !Array.isArray(x.files)) throw new Error("not a format 1 snapshot manifest");
  for (const f of x.files)
    if (!FILE_NAME.test(f.file) || !/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isInteger(f.bytes) || f.bytes <= 0)
      throw new Error(`malformed manifest entry ${JSON.stringify(f).slice(0, 200)}`);
  if (x.files.length > MAX_FILES) throw new Error(`${x.files.length} files: more than a release can hold`);
  return x;
}

/** Whether the release's asset is a copy of `f`: by GitHub's digest, or else by the release's manifest and the size. */
export function holds(f: ManifestFile, asset: Asset | undefined, release: Manifest | null): boolean {
  if (!asset || asset.size !== f.bytes) return false;
  if (asset.digest) return asset.digest === `sha256:${f.sha256}`;
  return release?.files.some((r) => r.file === f.file && r.sha256 === f.sha256) ?? false;
}

/**
 * What to do: the files to fetch and upload (new or changed), and the release's assets to delete
 * once the manifest no longer lists them (pairs no longer in the snapshot).
 */
export function plan(site: Manifest, release: Manifest | null, assets: readonly Asset[]) {
  const byName = new Map(assets.map((a) => [a.name, a]));
  const upload = site.files.filter((f) => !holds(f, byName.get(f.file), release));
  const wanted = new Set(site.files.map((f) => f.file));
  const remove = assets.map((a) => a.name).filter((n) => FILE_NAME.test(n) && !wanted.has(n));
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
  uploaded: ReadonlyMap<string, ManifestFile>,
): Manifest {
  const byName = new Map(assets.map((a) => [a.name, a]));
  const files = site.files.flatMap((f) => {
    const asset = byName.get(f.file);
    const candidates = [uploaded.get(f.file), f, release?.files.find((r) => r.file === f.file)];
    const held = candidates.find((c): c is ManifestFile => !!c && holds(c, asset, release));
    if (held) return [held];
    // without digests, a copy uploaded in this run is known by what was uploaded
    const now = uploaded.get(f.file);
    return now && asset && !asset.digest && asset.size === now.bytes ? [now] : [];
  });
  return {
    ...site,
    records: files.reduce((n, f) => n + f.records, 0),
    pieces: files.reduce((n, f) => n + f.pieces, 0),
    files,
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

async function fetchFile(f: ManifestFile, path: string): Promise<boolean> {
  const r = await fetch(`${SITE}/api/snapshot/${f.file}`);
  if (!r.ok) return false;
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length !== f.bytes || createHash("sha256").update(bytes).digest("hex") !== f.sha256) return false;
  writeFileSync(path, bytes);
  return true;
}

function notes(m: Manifest): string {
  const count = (n: number) => n.toLocaleString("en-US");
  return `Every current record on ${SITE.replace(/^https?:\/\//, "")} with its coordinates: the leader of each open problem, \
one gzipped JSON file per shape pair, named \`{N}-{M}.json.gz\` (N is the piece shape, M the container shape; 0 is a circle, \
3 or more a regular polygon). The site builds the snapshot every night, and this release mirrors it.

As of ${m.completed_at ?? m.generated_at}: ${count(m.records)} records, ${count(m.pieces)} pieces, ${count(m.files.length)} files.

**Download everything** with the GitHub CLI: \`gh release download ${TAG} --repo ${REPO}\`. \`manifest.json\` lists every file with its size and SHA-256.

**Format.** Each file is \`{"format": 1, "N": …, "M": …, "records": [ … ]}\`, one record per line. A record has \`P\`, \`score\` (container side, or radius for a circle container), \`id\`, \`name\`, \`found_with\`, \`verification\`, \`created_at\`, \`container_phi\` and \`pieces\` as \`[x, y, theta]\`, every number at full precision. Polygon pieces have side length 1 and circle pieces radius 1; angles are in radians. The conventions are on the API page, ${SITE}/api#snapshot, and the full entry of a record, with how it was found, is at \`${SITE}/api/submissions/{id}\`.

Published values from the literature, with their sources, are in [\`data/records.json\`](https://github.com/${REPO}/blob/main/data/records.json). Problems with a proven optimum take no entries and are left out.
`;
}

function listAssets(): Asset[] {
  return (JSON.parse(gh(["release", "view", TAG, "--json", "assets"])) as { assets: Asset[] }).assets;
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "polypack-mirror-"));
  const site = await siteManifest();
  if (!site.completed_at || site.completed_at !== site.generated_at) {
    console.log(`the site's snapshot is being built (generated ${site.generated_at}); nothing to do until it is finished`);
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
  console.log(`${site.files.length} files on the site; ${upload.length} new or changed; ${remove.length} to remove`);
  const uploaded = new Map<string, ManifestFile>();
  let failed = 0;
  try {
    let batch: ManifestFile[] = [];
    const send = () => {
      if (!batch.length) return;
      gh(["release", "upload", TAG, ...batch.map((f) => join(work, f.file)), "--clobber"]);
      for (const f of batch) uploaded.set(f.file, f);
      batch = [];
    };
    for (const f of upload) {
      const path = join(work, f.file);
      let got: ManifestFile | undefined = (await fetchFile(f, path)) ? f : undefined;
      if (!got) {
        // the server may have rebuilt the file since its manifest was read
        got = (await siteManifest()).files.find((g) => g.file === f.file);
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
    console.log(`the release lists ${final.files.length} files, ${final.records} records`);
  }
  for (const name of remove) gh(["release", "delete-asset", TAG, name, "--yes"]);
  if (failed) {
    console.log(`${failed} file(s) left for the next night`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
