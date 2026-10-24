import { describe, expect, it } from "vitest";
import { type Manifest, type ManifestFile, checkManifest, plan, releaseManifest } from "../mirror-snapshot";

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
const asset = (f: ManifestFile, size = f.bytes) => ({ name: f.file, size });

describe("mirroring the snapshot", () => {
  it("uploads new and changed files only, and removes pairs the site no longer has", () => {
    const same = file(3, 3, "a");
    const changed = file(3, 4, "b");
    const fresh = file(4, 4, "c");
    const gone = file(5, 5, "d");
    const release = manifest([same, file(3, 4, "e"), gone]);
    const site = manifest([same, changed, fresh]);
    const assets = [asset(same), asset(release.files[1]), asset(gone), { name: "manifest.json", size: 900 }];
    const { upload, remove } = plan(site, release, assets);
    expect(upload.map((f) => f.file)).toEqual(["3-4.json.gz", "4-4.json.gz"]);
    expect(remove).toEqual(["5-5.json.gz"]);
  });

  it("uploads again a file whose asset is missing or of the wrong size, and everything without a manifest", () => {
    const f = file(3, 3, "a");
    const site = manifest([f]);
    expect(plan(site, manifest([f]), []).upload).toEqual([f]);
    expect(plan(site, manifest([f]), [asset(f, 99)]).upload).toEqual([f]);
    expect(plan(site, null, [asset(f)]).upload).toEqual([f]);
  });

  it("ends with a manifest of exactly what the release holds", () => {
    const kept = file(3, 3, "a");
    const oldCopy = file(3, 4, "b");
    const site = manifest([kept, file(3, 4, "c"), file(4, 4, "d"), file(5, 5, "e")]);
    const release = manifest([kept, oldCopy]);
    const assets = [asset(kept), asset(oldCopy)];
    // 3-4 and 5-5 could not be fetched; 4-4 was uploaded, as the version read on the second try
    const second = file(4, 4, "f");
    const final = releaseManifest(site, release, assets, new Map([[second.file, second]]));
    expect(final.files).toEqual([kept, oldCopy, second]);
    expect([final.records, final.pieces]).toEqual([6, 15]);
  });

  it("refuses a manifest it does not understand", () => {
    expect(() => checkManifest({ format: 2, files: [] })).toThrow(/format 1/);
    expect(() => checkManifest(manifest([{ ...file(3, 3, "a"), file: "../x.json.gz" }]))).toThrow(/malformed/);
    expect(() => checkManifest(manifest([{ ...file(3, 3, "a"), sha256: "xyz" }]))).toThrow(/malformed/);
    expect(checkManifest(manifest([file(3, 3, "a")])).files).toHaveLength(1);
  });
});
