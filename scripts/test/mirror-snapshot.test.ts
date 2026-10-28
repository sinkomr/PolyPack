import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  type Asset,
  LAYOUT,
  type Manifest,
  type ManifestFile,
  type ManifestSpaceFile,
  type PieceFile,
  type ReleaseManifest,
  checkManifest,
  checkRelease,
  pieceFile,
  pieceFileBytes,
  pieceGroups,
  plan,
  releaseManifest,
} from "../mirror-snapshot";

const file = (N: number, M: number, sha: string, bytes = 100): ManifestFile => ({
  N,
  M,
  file: `${N}-${M}.json.gz`,
  records: 2,
  pieces: 5,
  bytes,
  sha256: sha.repeat(64),
  as_of: `2026-10-24T11:0${M % 10}:00Z`,
});
const manifest = (files: ManifestFile[]): Manifest => ({
  format: 2,
  units: "diameter",
  generated_at: "2026-10-24T11:30:00Z",
  completed_at: "2026-10-24T11:30:00Z",
  records: 2 * files.length,
  pieces: 5 * files.length,
  files,
});
const spaceFile = (space: string, sha: string, bytes = 100): ManifestSpaceFile => ({
  space,
  file: `space-${space}.json.gz`,
  records: 3,
  pieces: 30,
  bytes,
  sha256: sha.repeat(64),
  as_of: "2026-10-24T11:20:00Z",
});
/** The release's file of piece shape N built from `pairs`, with its own digest `sha`. */
const piece = (N: number, pairs: ManifestFile[], sha: string, bytes = 500): PieceFile =>
  pieceFile(N, pairs, bytes, sha.repeat(64));
const release = (files: PieceFile[], spaces: ManifestSpaceFile[] = []): ReleaseManifest => ({
  format: 2,
  units: "diameter",
  layout: LAYOUT,
  generated_at: "2026-10-23T11:30:00Z",
  completed_at: "2026-10-23T11:30:00Z",
  records: 0,
  pieces: 0,
  files,
  spaces,
});
/** The release's copy of `f`, with GitHub's digest unless `digest` is false. */
const asset = (f: PieceFile | ManifestSpaceFile, digest = true, size = f.bytes): Asset => ({
  name: f.file,
  size,
  digest: digest ? `sha256:${f.sha256}` : null,
});

describe("mirroring the snapshot, one file per piece shape", () => {
  it("gathers the pairs by piece shape, in order of N and M", () => {
    const groups = pieceGroups(manifest([file(4, 4, "a"), file(0, 5, "b"), file(4, 0, "c"), file(0, 0, "d")]));
    expect(groups.map((g) => [g.file, g.pairs.map((p) => p.M)])).toEqual([
      ["n-0.json.gz", [0, 5]],
      ["n-4.json.gz", [0, 4]],
    ]);
    // 99 piece shapes of 99 container shapes each fit a release; 9,801 files of their own would not
    const shapes = [0, ...Array.from({ length: 98 }, (_, i) => i + 3)];
    const all = shapes.flatMap((N) => shapes.map((M) => file(N, M, "a")));
    expect(pieceGroups(manifest(all))).toHaveLength(99);
    expect(() => checkManifest(manifest(all))).not.toThrow();
  });

  it("rebuilds a piece shape's file when one of its pairs changed, and only then", () => {
    const a = file(3, 3, "a");
    const b = file(3, 4, "b");
    const c = file(4, 4, "c");
    const site = manifest([a, b, c]);
    const n3 = piece(3, [a, b], "e");
    const n4 = piece(4, [file(4, 4, "x")], "f");
    const assets = [asset(n3), asset(n4), { name: "manifest.json", size: 900 }];
    const { groups, spaces, old, remove } = plan(site, release([n3, n4]), assets);
    expect(groups.map((g) => g.file)).toEqual(["n-4.json.gz"]);
    expect([spaces, old, remove]).toEqual([[], [], []]);
    // a pair more or less is a change too
    expect(plan(manifest([a]), release([n3]), [asset(n3)]).groups.map((g) => g.file)).toEqual(["n-3.json.gz"]);
  });

  it("rebuilds a file when the release's copy is not the one its manifest lists, or there is no usable manifest", () => {
    const a = file(3, 3, "a");
    const n3 = piece(3, [a], "e");
    const site = manifest([a]);
    expect(plan(site, release([n3]), [asset(n3)]).groups).toEqual([]);
    expect(plan(site, release([n3]), [{ ...asset(n3), digest: `sha256:${"f".repeat(64)}` }]).groups).toHaveLength(1);
    expect(plan(site, release([n3]), [asset(n3, true, 499)]).groups).toHaveLength(1);
    expect(plan(site, release([n3]), []).groups).toHaveLength(1);
    expect(plan(site, null, [asset(n3)]).groups).toHaveLength(1);
    // without digests the manifest and the size vouch for the copy
    expect(plan(site, release([n3]), [asset(n3, false)]).groups).toEqual([]);
  });

  it("removes the old layout's pair files first, and files that left the snapshot after the manifest", () => {
    const a = file(3, 3, "a");
    const site = { ...manifest([a]), spaces: [spaceFile("sphere", "b")] };
    const assets: Asset[] = [
      { name: "3-3.json.gz", size: 100, digest: null },
      { name: "20-3.json.gz", size: 100, digest: null },
      { name: "n-7.json.gz", size: 100, digest: null },
      { name: "space-torus.json.gz", size: 100, digest: null },
      { name: "manifest.json", size: 900, digest: null },
    ];
    const { groups, spaces, old, remove } = plan(site, null, assets);
    expect(old).toEqual(["3-3.json.gz", "20-3.json.gz"]);
    expect(remove).toEqual(["n-7.json.gz", "space-torus.json.gz"]);
    expect(groups.map((g) => g.file)).toEqual(["n-3.json.gz"]);
    expect(spaces.map((f) => f.file)).toEqual(["space-sphere.json.gz"]);
  });

  it("writes a piece shape's file that holds the site's pairs as they are", () => {
    const pairs = [
      { format: 2, N: 4, M: 0, records: [{ P: 2, score: 2.8284271247461903 }] },
      {
        format: 2,
        N: 4,
        M: 4,
        records: [
          { P: 2, score: 2 },
          { P: 3, score: 2 },
        ],
      },
    ];
    const gz = pieceFileBytes(
      2,
      4,
      pairs.map((p) => gzipSync(JSON.stringify(p) + "\n")),
    );
    expect(JSON.parse(gunzipSync(gz).toString("utf8"))).toEqual({ format: 2, N: 4, pairs });
    expect(JSON.parse(gunzipSync(pieceFileBytes(2, 5, [])).toString("utf8"))).toEqual({ format: 2, N: 5, pairs: [] });
  });

  it("lists a piece shape's pairs, totals and latest time in its entry", () => {
    const f = pieceFile(3, [file(3, 3, "a"), file(3, 7, "b")], 321, "c".repeat(64));
    expect(f).toMatchObject({
      N: 3,
      file: "n-3.json.gz",
      records: 4,
      pieces: 10,
      bytes: 321,
      as_of: "2026-10-24T11:07:00Z",
    });
    expect(f.pairs).toEqual([
      { M: 3, records: 2, pieces: 5, bytes: 100, sha256: "a".repeat(64), as_of: "2026-10-24T11:03:00Z" },
      { M: 7, records: 2, pieces: 5, bytes: 100, sha256: "b".repeat(64), as_of: "2026-10-24T11:07:00Z" },
    ]);
  });

  it("ends with a manifest of exactly what the release holds", () => {
    const a = file(3, 3, "a");
    const site = { ...manifest([a, file(3, 4, "b"), file(4, 4, "c"), file(5, 5, "d"), file(6, 6, "e")]), spaces: [] };
    // n-3 could not be rebuilt and keeps its old copy; n-4 was uploaded; n-5 never was; n-6's old
    // copy was clobbered by an upload that failed
    const oldN3 = piece(3, [a], "f");
    const newN4 = piece(4, [file(4, 4, "c")], "g");
    const oldN6 = piece(6, [file(6, 6, "h")], "i");
    const final = releaseManifest(
      site,
      release([oldN3, oldN6]),
      [asset(oldN3), asset(newN4)],
      new Map([[newN4.file, newN4]]),
    );
    expect(final.files).toEqual([oldN3, newN4]);
    expect([final.records, final.pieces]).toEqual([4, 10]);
    expect(final).toMatchObject({ layout: LAYOUT, format: 2, units: "diameter", generated_at: site.generated_at });
  });

  it("without digests, lists what this run uploaded and what the release's manifest vouches for", () => {
    const kept = piece(3, [file(3, 3, "a")], "b");
    const now = piece(4, [file(4, 4, "c")], "d");
    const site = manifest([file(3, 3, "a"), file(4, 4, "c")]);
    const final = releaseManifest(
      site,
      release([kept]),
      [asset(kept, false), asset(now, false)],
      new Map([[now.file, now]]),
    );
    expect(final.files).toEqual([kept, now]);
    expect(releaseManifest(site, null, [asset(kept, false)], new Map()).files).toEqual([]);
  });

  it("mirrors the spaces' files by their digest, and lists them apart", () => {
    const n3 = piece(3, [file(3, 3, "a")], "z");
    const same = spaceFile("sphere", "b");
    const changed = spaceFile("boundary", "c");
    const site = { ...manifest([file(3, 3, "a")]), spaces: [same, changed] };
    const assets = [asset(n3), asset(same), asset(spaceFile("boundary", "e")), asset(spaceFile("torus", "d"))];
    const { spaces, remove } = plan(site, release([n3]), assets);
    expect(spaces).toEqual([changed]);
    expect(remove).toEqual(["space-torus.json.gz"]);

    const final = releaseManifest(
      site,
      release([n3]),
      [asset(n3), asset(same), asset(changed)],
      new Map([[changed.file, changed]]),
    );
    expect(final.files).toEqual([n3]);
    expect(final.spaces).toEqual([same, changed]);
    // the totals stay the piece shapes'
    expect([final.records, final.pieces]).toEqual([2, 5]);
    // a space file that could not be fetched is left out until the release holds it
    expect(releaseManifest(site, release([n3]), [asset(n3), asset(same)], new Map()).spaces).toEqual([same]);
  });

  it("reads a site manifest from before the spaces, and mirrors no space file for it", () => {
    const pair = file(3, 3, "a");
    const site: Manifest = { ...manifest([pair]), format: 1 };
    expect(checkManifest(site).spaces).toBeUndefined();
    const n3 = piece(3, [pair], "b");
    expect(plan(site, release([n3]), [asset(n3)])).toEqual({ groups: [], spaces: [], old: [], remove: [] });
    expect(releaseManifest(site, release([n3]), [asset(n3)], new Map()).spaces).toEqual([]);
  });

  it("uses the release's manifest only when it is of this layout", () => {
    const n3 = piece(3, [file(3, 3, "a")], "b");
    expect(checkRelease(release([n3], [spaceFile("sphere", "c")]))).not.toBeNull();
    // the old layout's manifest: one entry per pair, no layout
    expect(checkRelease(manifest([file(3, 3, "a")]))).toBeNull();
    expect(checkRelease({ ...release([n3]), layout: "other" })).toBeNull();
    expect(checkRelease(release([{ ...n3, file: "3-3.json.gz" }]))).toBeNull();
    expect(checkRelease(release([{ ...n3, pairs: [{ ...n3.pairs[0], sha256: "xyz" }] }]))).toBeNull();
    expect(checkRelease(null)).toBeNull();
  });

  it("refuses a site manifest it does not understand", () => {
    expect(() => checkManifest({ format: 3, files: [] })).toThrow(/format 1 or 2/);
    expect(() => checkManifest(manifest([{ ...file(3, 3, "a"), file: "../x.json.gz" }]))).toThrow(/malformed/);
    expect(() => checkManifest(manifest([{ ...file(3, 3, "a"), sha256: "xyz" }]))).toThrow(/malformed/);
    expect(checkManifest(manifest([file(3, 3, "a")])).files).toHaveLength(1);
    const withSpace = (f: ManifestSpaceFile | unknown) => ({ ...manifest([]), spaces: [f] });
    expect(() => checkManifest(withSpace({ ...spaceFile("sphere", "a"), file: "space-../x.json.gz" }))).toThrow(
      /malformed/,
    );
    // a pair's name in the spaces' list, a space's in the pairs', or a piece shape's anywhere
    expect(() => checkManifest(withSpace({ ...spaceFile("sphere", "a"), file: "3-3.json.gz" }))).toThrow(/malformed/);
    expect(() => checkManifest(manifest([{ ...file(3, 3, "a"), file: "space-sphere.json.gz" }]))).toThrow(/malformed/);
    expect(() => checkManifest(manifest([{ ...file(3, 3, "a"), file: "n-3.json.gz" }]))).toThrow(/malformed/);
    expect(() => checkManifest(withSpace(null))).toThrow(/malformed/);
    expect(() => checkManifest({ ...manifest([]), spaces: "all" })).toThrow(/format 1/);
    expect(checkManifest(withSpace(spaceFile("sphere", "a"))).spaces).toHaveLength(1);
  });
});
