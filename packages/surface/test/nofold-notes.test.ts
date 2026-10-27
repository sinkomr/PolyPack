import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as geometry from "@polypack/geometry";
import { type LiteratureRecord } from "@polypack/geometry";
import { faceAreaLowerBound as areaLowerBound } from "../src/disk";
import { planarValues } from "../scripts/planar-values";
import {
  PLANAR_VALUES,
  bestFaceSplit,
  regularFaceKinds,
  surfaceNofoldNote,
  type FaceKind,
  type PlanarValue,
  type NotePart,
} from "../src/nofold";
import { ALL_SOLID_NAMES, getSolid } from "../src/solids";

const words = (parts: NotePart[]) => parts.map((p) => (typeof p === "string" ? p : p.text)).join("");
const links = (parts: NotePart[]) => parts.filter((p): p is Exclude<NotePart, string> => typeof p !== "string");
const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

describe("surface notes use the current 2D records", () => {
  it("keeps the browser index equal to the records, without copying coordinates", () => {
    const file = json("../../../data/records.json");
    const records = file.records as LiteratureRecord[];
    // The index and the records are both in site units (disks of diameter 1).
    const current = planarValues(records);
    expect(PLANAR_VALUES).toHaveLength(current.length);
    PLANAR_VALUES.forEach(({ value, ...metadata }, i) => {
      const { value: expected, ...source } = current[i];
      expect(metadata).toEqual(source);
      // Trigonometric functions can differ in their last bits across Node versions and platforms.
      expect(Math.abs(value - expected) / Math.max(1, expected)).toBeLessThan(1e-11);
    });
    expect(JSON.stringify(PLANAR_VALUES)).not.toContain('"pieces"');
  });

  it("quotes the printed value, its precision marker and its source when coordinates are missing", () => {
    const parts = surfaceNofoldNote("surface/tetrahedron/nofold/6/21", 6.899627269665025);
    expect(words(parts)).toContain("Friedman publishes 6.89897+ for this 2D problem, without coordinates.");
    expect(links(parts)).toContainEqual({
      text: "Friedman",
      href: "https://erich-friedman.github.io/packing/hexintri/",
    });
    expect(links(parts)).toContainEqual({ text: "the 2D in 2D problem N = 6, M = 3, P = 6", href: "/#p=6,3,6" });
  });

  it("omits the printed-only note when coordinates already reach the source's printed precision", () => {
    expect(words(surfaceNofoldNote("surface/tetrahedron/nofold/3/21", 2.9772826479127295))).not.toContain(
      "without coordinates",
    );
    expect(words(surfaceNofoldNote("surface/cube/nofold/4/13"))).not.toContain("without coordinates");
  });

  it("covers every printed-only improvement in the surface records, using the source data", () => {
    const records = json("../../../data/surface/records.json").records;
    let count = 0;
    for (const r of records.filter((r: { mode: string }) => r.mode === "nofold")) {
      const face = getSolid(r.solid);
      const k = Math.ceil(r.P / face.F);
      const planar = PLANAR_VALUES.find((v) => v.N === r.N && v.M === face.M && v.k === k);
      const missing = !!planar?.printed && r.s > planar.value + Math.max(10 ** -planar.printed.precision, 1e-9);
      for (const compact of [false, true]) {
        const parts = surfaceNofoldNote(r.id, r.s, compact);
        expect(words(parts).includes("without coordinates"), r.id).toBe(missing);
        if (missing)
          expect(
            links(parts).some((l) => l.href === planar!.printed!.href),
            r.id,
          ).toBe(true);
      }
      if (missing) count++;
    }
    expect(count).toBeGreaterThan(0);
  });
});

describe("splits across regular face kinds", () => {
  it("groups all regular faces and rejects irregular containers", () => {
    for (const name of ALL_SOLID_NAMES) {
      const solid = getSolid(name);
      const kinds = regularFaceKinds(solid);
      if (solid.regular.every(Boolean)) {
        expect(
          kinds!.reduce((n, f) => n + f.F, 0),
          name,
        ).toBe(solid.F);
        for (const f of kinds!) expect(f.F, name).toBe(solid.sides.filter((m) => m === f.M).length);
      } else expect(kinds, name).toBeNull();
    }
    expect(regularFaceKinds({ regular: [true, true, true, true], sides: [3, 4, 6, 3] })).toEqual([
      { M: 3, F: 2 },
      { M: 4, F: 1 },
      { M: 6, F: 1 },
    ]);
  });

  // Independent exhaustive enumeration for small face counts, including a third face kind.
  function brute(N: number, P: number, kinds: FaceKind[], values: readonly PlanarValue[]): number {
    const visit = (i: number, capacity: number, score: number): number => {
      if (i === kinds.length) return capacity >= P ? score : Infinity;
      const { M, F } = kinds[i];
      let best = Infinity;
      const stored = values.filter((v) => v.N === N && v.M === M);
      for (let k = 0; k <= Math.max(P, ...stored.map((v) => v.k)); k++) {
        const record = stored.find((v) => v.k === k);
        if (k > P && !record) continue;
        const value = k === 0 ? 0 : (record?.value ?? areaLowerBound(N, M, k));
        best = Math.min(best, visit(i + 1, capacity + F * k, Math.max(score, value)));
      }
      return best;
    };
    return visit(0, 0, 0);
  }

  it("minimises the largest value across two or three face kinds", () => {
    const values: PlanarValue[] = [
      { N: 4, M: 3, k: 1, value: 3 },
      { N: 4, M: 3, k: 2, value: 2.9 },
      { N: 4, M: 4, k: 1, value: 1 },
      { N: 4, M: 4, k: 2, value: 2 },
      { N: 4, M: 6, k: 1, value: 1.2 },
    ];
    for (const N of [0, 3, 4, 7])
      for (const P of [1, 4, 8])
        for (const kinds of [
          [
            { M: 3, F: 2 },
            { M: 4, F: 3 },
          ],
          [
            { M: 3, F: 2 },
            { M: 4, F: 3 },
            { M: 6, F: 1 },
          ],
        ]) {
          const split = bestFaceSplit(N, P, kinds, values);
          expect(split.value).toBeCloseTo(brute(N, P, kinds, values), 12);
          expect(split.faces.reduce((n, f) => n + f.F * f.k, 0)).toBeGreaterThanOrEqual(P);
          expect(split.value).toBe(Math.max(...split.faces.map((f) => f.value)));
          for (const f of split.faces) if (f.lowerBound) expect(f.value).toBe(areaLowerBound(N, f.M, f.k));
        }
  });

  it("considers larger stored packings when their current values are better", () => {
    const split = bestFaceSplit(
      4,
      2,
      [{ M: 4, F: 2 }],
      [
        { N: 4, M: 4, k: 1, value: 3 },
        { N: 4, M: 4, k: 2, value: 2.5 },
      ],
    );
    expect(split.value).toBe(2.5);
    expect(split.faces[0].k).toBe(2);
  });

  it("links the best current prism and antiprism splits and labels missing 2D values", () => {
    for (const id of ["surface/prism5/nofold/0/9", "surface/antiprism4/nofold/3/10"]) {
      const parts = surfaceNofoldNote(id);
      expect(words(parts)).toContain(
        "each split across face kinds needs its largest 2D in 2D value. Take the smallest over all splits.",
      );
      expect(links(parts).filter((l) => l.href.startsWith("/#p="))).toHaveLength(2);
      expect(words(parts)).not.toContain("lower bound");
    }
    const missing = surfaceNofoldNote("surface/prism11/nofold/7/25");
    expect(words(missing)).toContain("lower bound; no 2D value");
    expect(words(missing)).toContain("This split uses lower bounds where 2D values are missing.");
    expect(links(missing).some((l) => l.href.startsWith("/#p=7,11,"))).toBe(true);
    const one = surfaceNofoldNote("surface/prism5/nofold/4/1");
    expect(words(one)).toContain("empty");
    expect(links(one).every((l) => !l.href.endsWith(",0"))).toBe(true);
    for (const id of ["surface/prism5/fold/0/9", "surface/rhombic_dodecahedron/nofold/0/9", "surface/prism/nofold/4/2"])
      expect(surfaceNofoldNote(id)).toEqual([]);
  });
});
