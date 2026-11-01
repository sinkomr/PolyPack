/**
 * The imported records of the nD in nD space (data/ndim, python/ndim/build_records.py): the regular polytopes in 4D to 6D of
 * alejandrozu/platonic-packing, re-certified exactly when they were imported. Here: the index, the provenance, and every
 * configuration read back and checked by the float validator at tolerance 0 (the records keep a clearance of 1e-7).
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPolytope } from "@polypack/ndim";
import { ND_P_RANGE } from "@polypack/ndspace/catalogue";
import { parseSpaceId, validateSpaceSubmission } from "../src";
import { loadSpacesIndex, readEntryConfigSync } from "../src/load";

const root = resolve(__dirname, "../../..");
const cat = loadSpacesIndex(root).ndim!;

describe("the imported nD records", () => {
  it("are the regular polytopes of 4D to 6D, within upstream's ranges, none left out", async () => {
    await loadPolytope("8:421");
    expect(cat.skipped).toEqual([]);
    expect(cat.problems).toHaveLength(1886);
    const by = new Map<number, Set<string>>();
    for (const p of cat.problems) {
      const d = p.fields.d as number;
      expect([4, 5, 6]).toContain(d);
      expect(p.P).toBeGreaterThanOrEqual(2);
      expect(p.P).toBeLessThanOrEqual(ND_P_RANGE[d][1]);
      expect(p.status).toBe("best_known");
      expect(p.certified!.score).toBeGreaterThan(0);
      expect(p.bound).not.toBeNull();
      expect(p.certified!.score).toBeGreaterThanOrEqual(p.bound!.value);
      (by.get(d) ?? by.set(d, new Set()).get(d)!).add(`${p.fields.piece}/${p.fields.container}`);
    }
    // 36 ordered pairs of the six regular 4-polytopes, 9 of the three regular polytopes of 5D and of 6D
    expect([by.get(4)!.size, by.get(5)!.size, by.get(6)!.size]).toEqual([36, 9, 9]);
  });

  it("carry their credit, lineage and certification", () => {
    const file = JSON.parse(readFileSyncText("data/ndim/records.json"));
    expect(file.sources.wiki.licence).toMatch(/^MIT/);
    expect(file.sources.wiki.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const r of file.records.slice(0, 2000)) {
      expect(r.found_by).toBeTruthy();
      expect(r.credit).toMatch(/Zarzuelo/);
      expect(r.sources).toEqual(["wiki"]);
      expect(r.certification.min_wall_gap).toBeGreaterThan(0);
      expect(r.certification.min_pair_gap).toBeGreaterThan(0);
      expect(r.score_cert).toBe(r.wiki.s_full);
    }
  });

  it("read back and check as valid at tolerance 0 by the float validator (every record)", () => {
    let n = 0;
    for (const p of cat.problems) {
      const text = readEntryConfigSync(root, cat, p);
      expect(text, p.id).not.toBeNull();
      const v = validateSpaceSubmission("ndim", p.id, JSON.parse(text!), { bound: p.bound?.value ?? null });
      expect(v.reasons, p.id).toEqual([]);
      expect(v.score, p.id).toBe(p.certified!.score);
      n++;
    }
    expect(n).toBe(1886);
    expect(typeof parseSpaceId("ndim", "ndim/4/cube/cube/16")).not.toBe("string");
  });
});

import { readFileSync } from "node:fs";
function readFileSyncText(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}
