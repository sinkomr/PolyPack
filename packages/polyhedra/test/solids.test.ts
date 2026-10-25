import { describe, expect, it } from "vitest";
import {
  POLYHEDRA_PROBLEMS,
  SOLID_NAMES,
  formatPolyhedraId,
  getProblem,
  getSolid,
  parsePolyhedraId,
  volumeBound,
  wikiUrl,
} from "../src";

describe("solids", () => {
  it("has upstream's 56 solids and PolyPack's 20, each a closed convex polyhedron centred at the origin", () => {
    expect(SOLID_NAMES.length).toBe(76);
    expect(SOLID_NAMES.slice(56)).toEqual([
      ...["prism7", "prism9", "prism10", "prism11", "antiprism7", "antiprism9", "antiprism10", "antiprism11"],
      ...[7, 9, 10, 11].flatMap((k) => ["l15", "l2", "l3"].map((t) => `prism${k}_${t}`)),
    ]);
    for (const name of SOLID_NAMES) {
      const S = getSolid(name);
      expect(S.nv - S.edges.length + S.faces.length, name).toBe(2);
      for (let f = 0; f < S.faces.length; f++) {
        const n = [S.N[3 * f], S.N[3 * f + 1], S.N[3 * f + 2]];
        expect(Math.abs(Math.hypot(...n) - 1), name).toBeLessThan(1e-15);
        for (let v = 0; v < S.nv; v++) {
          const d = n[0] * S.V[3 * v] + n[1] * S.V[3 * v + 1] + n[2] * S.V[3 * v + 2] - S.offsets[f];
          if (S.faces[f].includes(v)) expect(Math.abs(d), `${name} face ${f}`).toBeLessThan(1e-14);
          else expect(d, `${name} face ${f}`).toBeLessThan(-1e-6);
        }
        // counter-clockwise seen from outside
        const [a, b, c] = S.faces[f].slice(0, 3).map((i) => [S.V[3 * i], S.V[3 * i + 1], S.V[3 * i + 2]]);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const x = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        expect(x[0] * n[0] + x[1] * n[1] + x[2] * n[2]).toBeGreaterThan(0);
      }
      let cx = 0;
      for (let v = 0; v < 3 * S.nv; v++) cx += Math.abs(S.V[v]);
      expect(cx).toBeGreaterThan(0);
      expect(S.inradius).toBeCloseTo(Math.min(...S.offsets), 15);
    }
  });

  it("has unit edges where upstream says so", () => {
    for (const name of SOLID_NAMES) {
      const S = getSolid(name);
      if (S.family === "catalan" || S.family === "elongated_prism") continue;
      for (const [i, j] of S.edges) {
        const l = Math.hypot(S.V[3 * j] - S.V[3 * i], S.V[3 * j + 1] - S.V[3 * i + 1], S.V[3 * j + 2] - S.V[3 * i + 2]);
        expect(Math.abs(l - 1), name).toBeLessThan(1e-14);
      }
    }
    expect(getSolid("cube").volume).toBe(1);
    expect(getSolid("prism3_l3").edgeMax).toBeCloseTo(3, 14);
  });

  it("has PolyPack's prisms and antiprisms with 7, 9, 10 and 11 sides in upstream's conventions", () => {
    for (const n of [7, 9, 10, 11]) {
      const R = 1 / (2 * Math.sin(Math.PI / n));
      const area = n / (4 * Math.tan(Math.PI / n));
      // prisms: V[2k] = (R cos 2 pi k/n, R sin 2 pi k/n, h/2), V[2k + 1] the same at -h/2; lateral edges h
      for (const [name, h] of [[`prism${n}`, 1], [`prism${n}_l15`, 1.5], [`prism${n}_l2`, 2], [`prism${n}_l3`, 3]] as const) {
        const S = getSolid(name);
        expect(S.family, name).toBe(name.includes("_") ? "elongated_prism" : "prism");
        expect([S.nv, S.edges.length, S.faces.length], name).toEqual([2 * n, 3 * n, n + 2]);
        for (let k = 0; k < n; k++)
          for (const [i, z] of [[2 * k, h / 2], [2 * k + 1, -h / 2]]) {
            const v = [S.V[3 * i], S.V[3 * i + 1], S.V[3 * i + 2]];
            const want = [R * Math.cos((2 * Math.PI * k) / n), R * Math.sin((2 * Math.PI * k) / n), z];
            for (let c = 0; c < 3; c++) expect(Math.abs(v[c] - want[c]), `${name} vertex ${i}`).toBeLessThan(1e-14);
          }
        const lengths = S.edges.map(([i, j]) => Math.hypot(S.V[3 * j] - S.V[3 * i], S.V[3 * j + 1] - S.V[3 * i + 1], S.V[3 * j + 2] - S.V[3 * i + 2]));
        expect(lengths.filter((l) => Math.abs(l - 1) < 1e-14).length, name).toBe(h === 1 ? 3 * n : 2 * n);
        if (h !== 1) expect(lengths.filter((l) => Math.abs(l - h) < 1e-14).length, name).toBe(n);
        expect(Math.abs(S.volume - h * area) / S.volume, name).toBeLessThan(1e-15);
        expect(S.circumradius).toBeCloseTo(Math.hypot(R, h / 2), 14);
      }
      // antiprisms: top V[k] at angle 2 pi k/n and height H/2, bottom V[n + k] at angle (2k + 1) pi/n and -H/2
      const name = `antiprism${n}`;
      const S = getSolid(name);
      const H = Math.sqrt(1 - 1 / (4 * Math.cos(Math.PI / (2 * n)) ** 2));
      expect(S.family).toBe("antiprism");
      expect([S.nv, S.edges.length, S.faces.length], name).toEqual([2 * n, 4 * n, 2 * n + 2]);
      for (let i = 0; i < 2 * n; i++) {
        const a = i < n ? (2 * Math.PI * i) / n : ((2 * (i - n) + 1) * Math.PI) / n;
        const want = [R * Math.cos(a), R * Math.sin(a), i < n ? H / 2 : -H / 2];
        for (let c = 0; c < 3; c++) expect(Math.abs(S.V[3 * i + c] - want[c]), `${name} vertex ${i}`).toBeLessThan(1e-14);
      }
      for (const [i, j] of S.edges)
        expect(Math.abs(Math.hypot(S.V[3 * j] - S.V[3 * i], S.V[3 * j + 1] - S.V[3 * i + 1], S.V[3 * j + 2] - S.V[3 * i + 2]) - 1)).toBeLessThan(1e-14);
      // prismatoid formula: the section at mid-height is the regular 2n-gon of circumradius R cos(pi/2n)
      const mid = n * (R * Math.cos(Math.PI / (2 * n))) ** 2 * Math.sin(Math.PI / n);
      expect(Math.abs(S.volume - (H / 6) * (2 * area + 4 * mid)) / S.volume, name).toBeLessThan(1e-14);
      expect(S.inradius).toBeCloseTo(Math.min(H / 2, Math.min(...Array.from(S.offsets))), 15);
    }
  });
});

describe("problems and ids", () => {
  it("lists upstream's 86 3D problems and PolyPack's 28 with unique codes", () => {
    expect(POLYHEDRA_PROBLEMS.length).toBe(114);
    expect(new Set(POLYHEDRA_PROBLEMS.map((p) => p.code)).size).toBe(114);
    expect(POLYHEDRA_PROBLEMS.slice(0, 86).every((p) => p.wiki)).toBe(true);
    expect(POLYHEDRA_PROBLEMS.slice(86).some((p) => p.wiki)).toBe(false);
    expect(POLYHEDRA_PROBLEMS.slice(86).map((p) => p.code)).toEqual([
      ...[7, 9, 10, 11].flatMap((k) => [`pr${k}inpr${k}`, `pr${k}incub`]),
      ...[7, 9, 10, 11].flatMap((k) => [`ap${k}inap${k}`, `ap${k}incub`]),
      ...[7, 9, 10, 11].flatMap((k) => ["l15", "l2", "l3"].map((t) => `pr${k}${t}incub`)),
    ]);
    expect(getProblem("pr7incub")).toMatchObject({ piece: "prism7", container: "cube", family: "prisms", wiki: false });
    expect(getProblem("pr7incub")!.title).toBe("Heptagonal prisms in a cube");
    expect(getProblem("ap9inap9")!.title).toBe("Enneagonal antiprisms in an enneagonal antiprism");
    expect(getProblem("pr10l15incub")!.title).toBe("Decagonal prisms of height 1.5 in a cube");
    expect(getProblem("ap11inap11")!.title).toBe("Hendecagonal antiprisms in a hendecagonal antiprism");
    expect(getProblem("pr12incub")!.wiki).toBe(true);
    expect(POLYHEDRA_PROBLEMS.slice(0, 5).map((p) => p.code)).toEqual(["tetintet", "octinoct", "icoinico", "dodindod", "cubincub"]);
    expect(getProblem("pr3l15incub")).toMatchObject({ piece: "prism3_l15", container: "cube", family: "prisms" });
    expect(getProblem("cubintet")!.title).toBe("Cubes in a tetrahedron");
    expect(getProblem("icoinoct")!.title).toBe("Icosahedra in an octahedron");
  });

  it("parses ids in their one written form only", () => {
    expect(parsePolyhedraId("polyhedra/cubintet/12")).toMatchObject({ code: "cubintet", P: 12 });
    expect(parsePolyhedraId("polyhedra/ap10inap10/100")).toMatchObject({ code: "ap10inap10", P: 100 });
    expect(parsePolyhedraId("polyhedra/pr9l3incub/2")).toMatchObject({ code: "pr9l3incub", P: 2 });
    expect(typeof parsePolyhedraId("polyhedra/pr13incub/2")).toBe("string");
    expect(formatPolyhedraId("cubintet", 12)).toBe("polyhedra/cubintet/12");
    for (const bad of ["polyhedra/cubintet/012", "polyhedra/cubintet/+1", "polyhedra/cubintet/0", "polyhedra/blob/3", "surface/cube/fold/0/1", "polyhedra/cubintet", 12])
      expect(typeof parsePolyhedraId(bad)).toBe("string");
    expect(wikiUrl("cubincub", 5)).toBe("https://polyhedrainpolyhedra.wiki/#cubincub_n05");
  });

  it("computes the volume bound", () => {
    expect(volumeBound(getProblem("cubincub")!, 8)).toBe(2);
    expect(volumeBound(getProblem("tetintet")!, 8)).toBeCloseTo(2, 14);
    // P = 8 pieces in their own solid: s >= 2; prisms in a cube: s >= (P h n cot(pi/n) / 4)^(1/3)
    for (const code of ["pr7inpr7", "pr9inpr9", "pr10inpr10", "pr11inpr11", "ap7inap7", "ap9inap9", "ap10inap10", "ap11inap11"])
      expect(volumeBound(getProblem(code)!, 8)).toBeCloseTo(2, 14);
    for (const [code, n, h] of [["pr7incub", 7, 1], ["pr9l15incub", 9, 1.5], ["pr10l3incub", 10, 3], ["pr11l2incub", 11, 2]] as const)
      expect(volumeBound(getProblem(code)!, 20)).toBeCloseTo(Math.cbrt((20 * h * n) / (4 * Math.tan(Math.PI / n))), 13);
  });
});
