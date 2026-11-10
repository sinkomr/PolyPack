import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Asset,
  LAYOUT,
  type Manifest,
  type ManifestFile,
  type ManifestSpaceFile,
  type PieceFile,
  type ReleaseManifest,
  type ReleasePair,
  type ReleaseSpaceFile,
  checkManifest,
  checkRelease,
  countRecords,
  fetchFile,
  pieceFile,
  pieceFileBytes,
  pieceGroups,
  plan,
  releaseManifest,
} from "../mirror-snapshot";

const hash = (c: string) => c.repeat(64);
/** The site's manifest entry of a pair, with the fingerprint `fp` (one character, repeated to a hash). */
const file = (N: number, M: number, fp: string): ManifestFile => ({
  N,
  M,
  file: `${N}-${M}.json.gz`,
  records: 2,
  pieces: 5,
  as_of: `2026-11-07T11:0${M % 10}:00Z`,
  fingerprint: hash(fp),
});
const manifest = (files: ManifestFile[]): Manifest => ({
  format: 3,
  units: "diameter",
  generated_at: "2026-11-07T11:30:00Z",
  completed_at: "2026-11-07T11:30:00Z",
  records: 2 * files.length,
  pieces: 5 * files.length,
  files,
});
const spaceFile = (space: string, fp: string): ManifestSpaceFile => ({
  space,
  file: `space-${space}.json.gz`,
  records: 3,
  pieces: 30,
  as_of: "2026-11-07T11:20:00Z",
  fingerprint: hash(fp),
});
/** What the mirror records of a pair it fetched while the site listed `f`: the response's fingerprint is the site's. */
const fetched = (f: ManifestFile): ReleasePair => ({
  M: f.M,
  records: f.records,
  pieces: f.pieces,
  as_of: "2026-11-07T12:40:00Z",
  fingerprint: f.fingerprint,
});
/** The release's file of piece shape N built from `pairs`, with its own SHA-256 `sha`. */
const piece = (N: number, pairs: ManifestFile[], sha: string, bytes = 500): PieceFile =>
  pieceFile(N, pairs.map(fetched), bytes, hash(sha));
/** The release's copy of a space's file, fetched while the site listed `f`. */
const releaseSpace = (f: ManifestSpaceFile, sha: string, bytes = 100): ReleaseSpaceFile => ({
  ...f,
  as_of: "2026-11-07T12:50:00Z",
  bytes,
  sha256: hash(sha),
});
const release = (files: PieceFile[], spaces: ReleaseSpaceFile[] = []): ReleaseManifest => ({
  format: 3,
  units: "diameter",
  layout: LAYOUT,
  generated_at: "2026-11-06T11:30:00Z",
  completed_at: "2026-11-06T11:30:00Z",
  records: 0,
  pieces: 0,
  files,
  spaces,
});
/** The release's copy of `f`, with GitHub's digest unless `digest` is false. */
const asset = (f: PieceFile | ReleaseSpaceFile, digest = true, size = f.bytes): Asset => ({
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

  it("fetches nothing when every pair has the fingerprint the release recorded, and a piece shape when one differs", () => {
    const a = file(3, 3, "a");
    const b = file(3, 4, "b");
    const c = file(4, 4, "c");
    const n3 = piece(3, [a, b], "e");
    const n4 = piece(4, [c], "f");
    const assets = [asset(n3), asset(n4), { name: "manifest.json", size: 900 }];
    expect(plan(manifest([a, b, c]), release([n3, n4]), assets)).toEqual({
      groups: [],
      spaces: [],
      old: [],
      remove: [],
    });

    // one pair of n-3 changed on the site: the whole piece shape is fetched again, n-4 is not
    const { groups } = plan(manifest([a, file(3, 4, "x"), c]), release([n3, n4]), assets);
    expect(groups.map((g) => [g.file, g.pairs.map((p) => p.M)])).toEqual([["n-3.json.gz", [3, 4]]]);
    // a pair more, or fewer, or in another container shape, is a change too
    expect(plan(manifest([a, b, file(3, 5, "b"), c]), release([n3, n4]), assets).groups.map((g) => g.file)).toEqual([
      "n-3.json.gz",
    ]);
    expect(plan(manifest([a, c]), release([n3, n4]), assets).groups.map((g) => g.file)).toEqual(["n-3.json.gz"]);
    expect(plan(manifest([a, file(3, 6, "b"), c]), release([n3, n4]), assets).groups.map((g) => g.file)).toEqual([
      "n-3.json.gz",
    ]);
    // a piece shape new to the release
    expect(plan(manifest([a, b, c, file(5, 5, "d")]), release([n3, n4]), assets).groups.map((g) => g.file)).toEqual([
      "n-5.json.gz",
    ]);
  });

  it("compares the site's fingerprint with the one of the response the mirror fetched, not with the manifest it read", () => {
    // the mirror read the manifest, fetched the pair, and the site had a newer leader by then
    const listed = file(3, 3, "a");
    const response = hash("b");
    const n3 = pieceFile(3, [{ ...fetched(listed), fingerprint: response }], 500, hash("e"));
    // tomorrow's manifest lists the fingerprint of that newer leader: nothing to fetch
    expect(plan(manifest([{ ...listed, fingerprint: response }]), release([n3]), [asset(n3)]).groups).toEqual([]);
    // the manifest of the night the file was fetched listed another, so listing it again would fetch it again
    expect(plan(manifest([listed]), release([n3]), [asset(n3)]).groups).toHaveLength(1);
  });

  it("fetches everything from a release that records no fingerprints, as the first run after format 3 finds it", () => {
    const a = file(3, 3, "a");
    const c = file(4, 4, "c");
    // a release manifest of format 2: pairs with a SHA-256 and sizes of the site's file, no fingerprint
    const old = (f: ManifestFile) => {
      const { fingerprint: _fp, ...rest } = fetched(f);
      return { ...rest, bytes: 100, sha256: hash("9") };
    };
    const n3 = { ...piece(3, [a], "e"), pairs: [old(a)] };
    const n4 = { ...piece(4, [c], "f"), pairs: [old(c)] };
    const space = releaseSpace(spaceFile("sphere", "s"), "b");
    const { fingerprint: _fp, ...bare } = space;
    const site = { ...manifest([a, c]), spaces: [spaceFile("sphere", "s")] };
    const rel = { ...release([n3, n4], [bare]), format: 2 };
    expect(checkRelease(rel)).not.toBeNull();
    const assets = [asset(n3), asset(n4), asset(space)];
    const todo = plan(site, rel, assets);
    expect(todo.groups.map((g) => g.file)).toEqual(["n-3.json.gz", "n-4.json.gz"]);
    expect(todo.spaces.map((f) => f.file)).toEqual(["space-sphere.json.gz"]);
    // and without any release manifest
    expect(plan(site, null, assets).groups).toHaveLength(2);
  });

  it("rebuilds a file when the release's copy is not the one its manifest lists", () => {
    const a = file(3, 3, "a");
    const n3 = piece(3, [a], "e");
    const site = manifest([a]);
    expect(plan(site, release([n3]), [asset(n3)]).groups).toEqual([]);
    expect(plan(site, release([n3]), [{ ...asset(n3), digest: `sha256:${hash("f")}` }]).groups).toHaveLength(1);
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
      { format: 3, N: 4, M: 0, records: [{ P: 2, score: 2.8284271247461903 }] },
      {
        format: 3,
        N: 4,
        M: 4,
        records: [
          { P: 2, score: 2 },
          { P: 3, score: 2 },
        ],
      },
    ];
    const gz = pieceFileBytes(
      3,
      4,
      pairs.map((p) => gzipSync(JSON.stringify(p) + "\n")),
    );
    expect(JSON.parse(gunzipSync(gz).toString("utf8"))).toEqual({ format: 3, N: 4, pairs });
    expect(JSON.parse(gunzipSync(pieceFileBytes(3, 5, [])).toString("utf8"))).toEqual({ format: 3, N: 5, pairs: [] });
  });

  it("counts the records and pieces of the bytes it fetched, whatever the site's manifest said", () => {
    const text = `{"format":3,"N":4,"M":4,"records":[\n{"P":2,"score":2},\n{"P":3,"score":2}\n]}\n`;
    expect(countRecords(gzipSync(text))).toEqual({ records: 2, pieces: 5 });
    expect(countRecords(gzipSync(`{"format":3,"N":4,"M":4,"records":[\n]}\n`))).toEqual({ records: 0, pieces: 0 });
    expect(() => countRecords(Buffer.from("not gzip"))).toThrow();
    expect(() => countRecords(gzipSync("not json"))).toThrow();
    expect(() => countRecords(gzipSync('{"error":"too many"}'))).toThrow(/no list/);
    expect(() => countRecords(gzipSync('{"records":[{"score":1}]}'))).toThrow(/without P/);
  });

  it("lists a piece shape's pairs, totals and latest time in its entry", () => {
    const pairs = [
      { M: 3, records: 2, pieces: 5, as_of: "2026-11-07T12:03:00Z", fingerprint: hash("a") },
      { M: 7, records: 4, pieces: 9, as_of: "2026-11-07T12:07:00Z", fingerprint: hash("b") },
    ];
    const f = pieceFile(3, pairs, 321, hash("c"));
    expect(f).toMatchObject({
      N: 3,
      file: "n-3.json.gz",
      records: 6,
      pieces: 14,
      bytes: 321,
      sha256: hash("c"),
      as_of: "2026-11-07T12:07:00Z",
    });
    expect(f.pairs).toEqual(pairs);
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
    expect(final).toMatchObject({ layout: LAYOUT, format: 3, units: "diameter", generated_at: site.generated_at });
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

  it("mirrors the spaces' files by their fingerprint, and lists them apart", () => {
    const n3 = piece(3, [file(3, 3, "a")], "z");
    const same = spaceFile("sphere", "b");
    const changed = spaceFile("boundary", "c");
    const site = { ...manifest([file(3, 3, "a")]), spaces: [same, changed] };
    const heldSame = releaseSpace(same, "1");
    const heldChanged = releaseSpace(spaceFile("boundary", "e"), "2");
    const assets = [asset(n3), asset(heldSame), asset(heldChanged), asset(releaseSpace(spaceFile("torus", "d"), "3"))];
    const { spaces, remove } = plan(site, release([n3], [heldSame, heldChanged]), assets);
    expect(spaces).toEqual([changed]);
    expect(remove).toEqual(["space-torus.json.gz"]);
    // a space file the release's copy of is gone is fetched whatever its fingerprint
    expect(plan(site, release([n3], [heldSame, heldChanged]), [asset(n3), asset(heldChanged)]).spaces).toEqual([
      same,
      changed,
    ]);

    const newBoundary = releaseSpace(changed, "4");
    const final = releaseManifest(
      site,
      release([n3], [heldSame, heldChanged]),
      [asset(n3), asset(heldSame), asset(newBoundary)],
      new Map([[newBoundary.file, newBoundary]]),
    );
    expect(final.files).toEqual([n3]);
    expect(final.spaces).toEqual([heldSame, newBoundary]);
    // the totals stay the piece shapes'
    expect([final.records, final.pieces]).toEqual([2, 5]);
    // a space file that could not be fetched is left out until the release holds it, or keeps its old copy
    expect(releaseManifest(site, release([n3]), [asset(n3), asset(heldSame)], new Map()).spaces).toEqual([]);
    expect(releaseManifest(site, release([n3], [heldSame]), [asset(n3), asset(heldSame)], new Map()).spaces).toEqual([
      heldSame,
    ]);
  });

  it("uses the release's manifest only when it is of this layout", () => {
    const n3 = piece(3, [file(3, 3, "a")], "b");
    expect(checkRelease(release([n3], [releaseSpace(spaceFile("sphere", "c"), "d")]))).not.toBeNull();
    // the old layout's manifest: one entry per pair, no layout
    expect(checkRelease(manifest([file(3, 3, "a")]))).toBeNull();
    expect(checkRelease({ ...release([n3]), layout: "other" })).toBeNull();
    expect(checkRelease({ ...release([n3]), format: 4 })).toBeNull();
    expect(checkRelease(release([{ ...n3, file: "3-3.json.gz" }]))).toBeNull();
    expect(checkRelease(release([{ ...n3, sha256: "xyz" }]))).toBeNull();
    expect(checkRelease(release([{ ...n3, pairs: [{ ...n3.pairs[0], fingerprint: "xyz" }] }]))).toBeNull();
    expect(
      checkRelease(release([], [{ ...releaseSpace(spaceFile("sphere", "c"), "d"), fingerprint: "xyz" }])),
    ).toBeNull();
    expect(checkRelease(null)).toBeNull();
  });

  it("refuses a site manifest it does not understand", () => {
    // the site before format 3 lists a SHA-256 and a size, not what this script compares
    expect(() => checkManifest({ ...manifest([file(3, 3, "a")]), format: 2 })).toThrow(/format 3/);
    expect(() => checkManifest({ format: 4, files: [] })).toThrow(/format 3/);
    expect(() => checkManifest(manifest([{ ...file(3, 3, "a"), file: "../x.json.gz" }]))).toThrow(/malformed/);
    expect(() => checkManifest(manifest([{ ...file(3, 3, "a"), fingerprint: "xyz" }]))).toThrow(/malformed/);
    const { fingerprint: _fp, ...bare } = file(3, 3, "a");
    expect(() => checkManifest(manifest([bare as ManifestFile]))).toThrow(/malformed/);
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
    expect(() => checkManifest({ ...manifest([]), spaces: "all" })).toThrow(/format 3/);
    expect(checkManifest(withSpace(spaceFile("sphere", "a"))).spaces).toHaveLength(1);
  });
});

describe("fetching a file from the site", () => {
  afterEach(() => vi.unstubAllGlobals());
  const gz = gzipSync('{"format":3,"N":4,"M":4,"records":[\n{"P":2},\n{"P":3}\n]}\n');
  const ok = (fp = hash("a")) => new Response(gz, { status: 200, headers: { "x-snapshot-fingerprint": fp } });
  const answers = (...rs: Response[]) => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => (calls.push(url), rs.shift()!));
    return calls;
  };
  const waits: number[] = [];
  const wait = async (ms: number) => void waits.push(ms);

  it("takes the bytes the site returns and the fingerprint of the response, and counts them itself", async () => {
    const calls = answers(ok(hash("b")));
    const got = await fetchFile("4-4.json.gz", wait);
    expect(calls).toEqual(["https://polypack.fly.dev/api/snapshot/4-4.json.gz"]);
    expect(got).toMatchObject({ fingerprint: hash("b"), records: 2, pieces: 5 });
    expect(got!.bytes.equals(gz)).toBe(true);
  });

  it("tries again after a refusal for the rate or a server error, and gives up after four tries", async () => {
    waits.length = 0;
    const limited = new Response("{}", { status: 429, headers: { "retry-after": "60" } });
    const calls = answers(limited, new Response("{}", { status: 503 }), ok());
    expect(await fetchFile("4-4.json.gz", wait)).not.toBeNull();
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([60_000, 10_000]);
    const always = answers(...Array.from({ length: 4 }, () => new Response("{}", { status: 500 })));
    expect(await fetchFile("4-4.json.gz", wait)).toBeNull();
    expect(always).toHaveLength(4);
  });

  it("does not try again when the file is gone or what comes is not a snapshot file", async () => {
    const gone = answers(new Response("{}", { status: 404 }), ok());
    expect(await fetchFile("4-4.json.gz", wait)).toBeNull();
    expect(gone).toHaveLength(1);
    const bare = answers(new Response(gz, { status: 200 }), ok());
    expect(await fetchFile("4-4.json.gz", wait)).toBeNull();
    expect(bare).toHaveLength(1);
    const junk = answers(new Response("junk", { status: 200, headers: { "x-snapshot-fingerprint": hash("a") } }), ok());
    expect(await fetchFile("4-4.json.gz", wait)).toBeNull();
    expect(junk).toHaveLength(1);
  });
});
