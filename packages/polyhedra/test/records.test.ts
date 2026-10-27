import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  POLYHEDRA_MAX_P,
  type PolyhedraRecordsFile,
  displayScore,
  getProblem,
  parsePolyhedraConfig,
  parsePolyhedraId,
  volumeBound,
} from "../src";
import { readRecordsFile } from "../src/records-file";

const url = new URL("../../../data/polyhedra/records.json", import.meta.url);
// the index with each record's configuration attached from data/polyhedra/configs/<code>.jsonl
const file: PolyhedraRecordsFile | undefined = existsSync(url) ? readRecordsFile(url.pathname) : undefined;

describe("displayScore", () => {
  it("rounds the exact binary value to the nearest at 6 decimals, ties to even", () => {
    expect(displayScore(2.0000003000001)).toBe("2.000000");
    expect(displayScore(1.9535648569341)).toBe("1.953565");
    expect(displayScore(2.4166165)).toBe("2.416616");
    expect(displayScore(0.0078125)).toBe("0.007812");
    expect(displayScore(1.0234375)).toBe("1.023438");
  });
});

describe("parsePolyhedraConfig", () => {
  it("keeps only the known fields and tells a wrong count from malformed input", () => {
    const ok = parsePolyhedraConfig({ s: 2, pieces: [[0, 0, 0, 1, 0, 0, 0]], extra: 1 }, 1);
    expect(ok).toEqual({ ok: true, config: { s: 2, pieces: [[0, 0, 0, 1, 0, 0, 0]] }, score: 2 });
    const count = parsePolyhedraConfig({ s: 2, pieces: [[0, 0, 0, 1, 0, 0, 0]] }, 2);
    expect(count).toMatchObject({ ok: false, malformed: false });
    const bad = parsePolyhedraConfig({ s: "2", pieces: [] }, 0);
    expect(bad).toMatchObject({ ok: false, malformed: true });
  });
});

describe.skipIf(!file)("data/polyhedra/records.json", () => {
  const records = file?.records ?? [];

  it("has one record per id, with fields that agree with the id and the display rule", () => {
    expect(new Set(records.map((r) => r.id)).size).toBe(records.length);
    expect(Math.max(...records.map((r) => r.P))).toBe(100);
    expect(POLYHEDRA_MAX_P).toBe(500);
    for (const r of records) {
      const id = parsePolyhedraId(r.id);
      expect(typeof id, r.id).toBe("object");
      if (typeof id === "string") continue;
      expect(id.problem).toMatchObject({ code: r.code, piece: r.piece, container: r.container, family: r.family });
      expect(id.P).toBe(r.P);
      expect(r.config.s).toBe(r.score_cert);
      expect(r.display).toBe(displayScore(r.score_cert));
      expect(r.score_float).toBeLessThanOrEqual(r.score_cert);
      expect(r.status).toBe("best_known");
      expect(Math.abs(r.bound.value - volumeBound(getProblem(r.code)!, r.P)) / r.bound.value).toBeLessThan(1e-12);
      expect(r.bound.value).toBeLessThan(r.score_cert);
      if (id.problem.wiki) {
        expect(r.wiki!.s_full).toBeGreaterThan(0);
        // a record differs from the wiki's only where PolyPack research beats it by more than 1e-5 relative
        if (r.found_by === "PolyPack research") expect(r.score_cert).toBeLessThan(r.wiki!.s_full * (1 - 1e-5));
        else expect(r.score_cert).toBe(r.wiki!.s_full);
      } else {
        // PolyPack's own problems: no wiki record and no published value, PolyPack research only
        expect(r.wiki).toBeUndefined();
        expect(r).toMatchObject({ found_by: "PolyPack research", credit: "PolyPack research", sources: ["polypack"], literature: [] });
        expect(r.method!.length).toBeGreaterThan(20);
        // the research file: prisms/ for the prisms and antiprisms, duals/ for the bipyramids and trapezohedra
        expect(r.origin.file).toBe(`${/^(bp|tz)\d/.test(r.code) ? "duals" : "prisms"}/${r.code}.json`);
      }
      for (const k of r.sources) expect(file!.sources[k], `${r.id} ${k}`).toBeDefined();
      expect(r.source.length).toBeGreaterThan(10);
      expect(parsePolyhedraConfig(r.config, r.P).ok).toBe(true);
    }
  });

  it("cites the non-MIT sources in every record that rests on them", () => {
    for (const r of records) {
      if (r.sources.includes("kamp")) expect(r.source).toMatch(/Kamp/);
      if (r.sources.includes("hyra")) {
        expect(r.source).toMatch(/Apache-2\.0/);
        expect(r.notes).toMatch(/modified/);
      }
    }
  });
});
