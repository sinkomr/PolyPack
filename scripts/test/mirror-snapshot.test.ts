import { describe, expect, it } from "vitest";
import {
  type Asset,
  type Manifest,
  type ManifestFile,
  type ManifestSpaceFile,
  checkManifest,
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
  as_of: "2026-10-24T11:00:00Z",
});
const manifest = (files: ManifestFile[]): Manifest => ({
  format: 1,
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
/** The release's copy of `f`, with GitHub's digest unless `digest` is false. */
const asset = (f: ManifestFile | ManifestSpaceFile, digest = true, size = f.bytes): Asset => ({
  name: f.file,
  size,
  digest: digest ? `sha256:${f.sha256}` : null,
});

describe("mirroring the snapshot", () => {
  it("uploads new and changed files only, and removes pairs the site no longer has", () => {
    const same = file(3, 3, "a");
    const changed = file(3, 4, "b");
    const fresh = file(4, 4, "c");
    const gone = file(5, 5, "d");
    const site = manifest([same, changed, fresh]);
    // the release's manifest may be stale or missing: GitHub's digests decide
    const assets = [asset(same), asset(file(3, 4, "e")), asset(gone), { name: "manifest.json", size: 900 }];
    const { upload, remove } = plan(site, null, assets);
    expect(upload.map((f) => f.file)).toEqual(["3-4.json.gz", "4-4.json.gz"]);
    expect(remove).toEqual(["5-5.json.gz"]);
  });

  it("without digests, trusts the release's manifest and the size", () => {
    const f = file(3, 3, "a");
    const site = manifest([f]);
    expect(plan(site, manifest([f]), [asset(f, false)]).upload).toEqual([]);
    expect(plan(site, manifest([f]), [asset(f, false, 99)]).upload).toEqual([f]);
    expect(plan(site, manifest([file(3, 3, "b")]), [asset(f, false)]).upload).toEqual([f]);
    expect(plan(site, null, [asset(f, false)]).upload).toEqual([f]);
    expect(plan(site, manifest([f]), []).upload).toEqual([f]);
  });

  it("ends with a manifest of exactly what the release holds", () => {
    const kept = file(3, 3, "a");
    const oldCopy = file(3, 4, "b");
    const site = manifest([kept, file(3, 4, "c"), file(4, 4, "d"), file(5, 5, "e"), file(6, 6, "f")]);
    const release = manifest([kept, oldCopy, file(6, 6, "g")]);
    // 3-4 could not be fetched and keeps its old copy; 4-4 was uploaded as the version read on the
    // second try; 5-5 was never uploaded; 6-6's old copy was clobbered by an upload that failed
    const second = file(4, 4, "h");
    const fresh = [asset(kept), asset(oldCopy), asset(second)];
    const final = releaseManifest(site, release, fresh, new Map([[second.file, second]]));
    expect(final.files).toEqual([kept, oldCopy, second]);
    expect([final.records, final.pieces]).toEqual([6, 15]);
  });

  it("without digests, lists what this run uploaded and what the release's manifest vouches for", () => {
    const kept = file(3, 3, "a");
    const now = file(4, 4, "b");
    const site = manifest([kept, now]);
    const final = releaseManifest(
      site,
      manifest([kept]),
      [asset(kept, false), asset(now, false)],
      new Map([[now.file, now]]),
    );
    expect(final.files).toEqual([kept, now]);
    expect(releaseManifest(site, null, [asset(kept, false)], new Map()).files).toEqual([]);
  });

  it("mirrors the spaces' files like the pairs', and lists them apart", () => {
    const pair = file(3, 3, "a");
    const same = spaceFile("sphere", "b");
    const changed = spaceFile("boundary", "c");
    const gone = spaceFile("torus", "d");
    const site = { ...manifest([pair]), spaces: [same, changed] };
    const assets = [asset(pair), asset(same), asset(spaceFile("boundary", "e")), asset(gone)];
    const { upload, remove } = plan(site, null, assets);
    expect(upload).toEqual([changed]);
    expect(remove).toEqual(["space-torus.json.gz"]);

    const final = releaseManifest(
      site,
      null,
      [asset(pair), asset(same), asset(changed)],
      new Map([[changed.file, changed]]),
    );
    expect(final.files).toEqual([pair]);
    expect(final.spaces).toEqual([same, changed]);
    // the totals stay the pairs'
    expect([final.records, final.pieces]).toEqual([2, 5]);
    // a space file that could not be fetched is left out until the release holds it
    expect(releaseManifest(site, null, [asset(pair), asset(same)], new Map()).spaces).toEqual([same]);
  });

  it("reads a manifest from before the spaces, and mirrors no space file for it", () => {
    const pair = file(3, 3, "a");
    const site = manifest([pair]);
    expect(checkManifest(site).spaces).toBeUndefined();
    expect(plan(site, null, [asset(pair)])).toEqual({ upload: [], remove: [] });
    expect(releaseManifest(site, null, [asset(pair)], new Map()).spaces).toEqual([]);
  });

  it("refuses a manifest it does not understand", () => {
    expect(() => checkManifest({ format: 3, files: [] })).toThrow(/format 1 or 2/);
    expect(() => checkManifest(manifest([{ ...file(3, 3, "a"), file: "../x.json.gz" }]))).toThrow(/malformed/);
    expect(() => checkManifest(manifest([{ ...file(3, 3, "a"), sha256: "xyz" }]))).toThrow(/malformed/);
    expect(checkManifest(manifest([file(3, 3, "a")])).files).toHaveLength(1);
    const withSpace = (f: ManifestSpaceFile | unknown) => ({ ...manifest([]), spaces: [f] });
    expect(() => checkManifest(withSpace({ ...spaceFile("sphere", "a"), file: "space-../x.json.gz" }))).toThrow(
      /malformed/,
    );
    // a pair's name in the spaces' list, or a space's in the pairs'
    expect(() => checkManifest(withSpace({ ...spaceFile("sphere", "a"), file: "3-3.json.gz" }))).toThrow(/malformed/);
    expect(() => checkManifest(manifest([{ ...file(3, 3, "a"), file: "space-sphere.json.gz" }]))).toThrow(/malformed/);
    expect(() => checkManifest(withSpace(null))).toThrow(/malformed/);
    expect(() => checkManifest({ ...manifest([]), spaces: "all" })).toThrow(/format 1/);
    expect(checkManifest(withSpace(spaceFile("sphere", "a"))).spaces).toHaveLength(1);
  });
});
