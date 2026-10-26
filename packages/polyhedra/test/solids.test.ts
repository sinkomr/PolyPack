import { describe, expect, it } from "vitest";
import {
  POLYHEDRA_PROBLEMS,
  SOLID_NAMES,
  type Solid,
  formatPolyhedraId,
  getProblem,
  getSolid,
  parsePolyhedraId,
  volumeBound,
  wikiUrl,
} from "../src";
import { PROBLEM_CODES, PROBLEM_ORDER, SOLID_NAMES_LIST, problemNameOf } from "../src/catalogue";

describe("solids", () => {
  it("has upstream's 56 solids and PolyPack's 38, each a closed convex polyhedron centred at the origin", () => {
    expect(SOLID_NAMES.length).toBe(94);
    expect(SOLID_NAMES.slice(56)).toEqual([
      ...["prism7", "prism9", "prism10", "prism11", "antiprism7", "antiprism9", "antiprism10", "antiprism11"],
      ...[7, 9, 10, 11].flatMap((k) => ["l15", "l2", "l3"].map((t) => `prism${k}_${t}`)),
      ...[3, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `bipyramid${n}`),
      ...[4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `trapezohedron${n}`),
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
      if (["catalan", "elongated_prism", "bipyramid", "trapezohedron"].includes(S.family)) continue;
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

describe("bipyramids and trapezohedra", () => {
  const dualsOf = (S: Solid) => Number(S.name.replace(/\D/g, ""));
  const vertices = (S: Solid) => Array.from({ length: S.nv }, (_, i) => [S.V[3 * i], S.V[3 * i + 1], S.V[3 * i + 2]]);
  const sameSet = (A: number[][], B: number[][], tol: number) =>
    A.length === B.length && A.every((a) => B.some((b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol));
  const news = SOLID_NAMES.filter((n) => /^(bipyramid|trapezohedron)\d+$/.test(n)).map(getSolid);

  it("are the closed forms of the canonical duals of the unit-edge prisms and antiprisms", () => {
    expect(news.length).toBe(18);
    for (const S of news) {
      const n = dualsOf(S);
      const t = Math.PI / n;
      let want: number[][];
      if (S.family === "bipyramid") {
        // equator radius 1 / sin(2 pi/n) at angles (2j+1) pi/n, apexes at +-1 / (2 sin^2(pi/n)) [CALC]
        const r = 1 / Math.sin(2 * t);
        const a = 1 / (2 * Math.sin(t) ** 2);
        want = Array.from({ length: n }, (_, j) => [r * Math.cos((2 * j + 1) * t), r * Math.sin((2 * j + 1) * t), 0]);
        want.push([0, 0, a], [0, 0, -a]);
      } else {
        // rings of radius R = 1 / (2 sin(pi/n)): the upper at angles (2j+1) pi/n and height z1, the lower at 2 j pi/n
        // and -z1; apexes at +-za, with c = cos(pi/n), H half the antiprism height: z1 = R^2 (1 - c) / (2H),
        // za = R^2 (1 + c) / (2H) [CALC]
        const R = 1 / (2 * Math.sin(t));
        const c = Math.cos(t);
        const H = Math.sqrt(1 - 1 / (4 * Math.cos(t / 2) ** 2)) / 2;
        const z1 = (R * R * (1 - c)) / (2 * H);
        const za = (R * R * (1 + c)) / (2 * H);
        want = Array.from({ length: n }, (_, j) => [R * Math.cos((2 * j + 1) * t), R * Math.sin((2 * j + 1) * t), z1]);
        for (let j = 0; j < n; j++) want.push([R * Math.cos(2 * j * t), R * Math.sin(2 * j * t), -z1]);
        want.push([0, 0, za], [0, 0, -za]);
      }
      expect(sameSet(vertices(S), want, 1e-13), S.name).toBe(true);
      expect(S.family === "bipyramid" ? S.faces.length : S.faces.length, S.name).toBe(2 * n);
      expect(S.tangential, S.name).toBe(true);
    }
  });

  it("have every edge tangent to the midsphere of the prism or antiprism, an insphere, and the closed-form volume", () => {
    for (const S of news) {
      const n = dualsOf(S);
      const t = Math.PI / n;
      const c = Math.cos(t);
      // the unit-edge n-prism has midradius 1 / (2 sin(pi/n)), the n-antiprism 1 / (4 sin(pi/2n)) [CALC]
      const rho = S.family === "bipyramid" ? 1 / (2 * Math.sin(t)) : 1 / (4 * Math.sin(t / 2));
      let shortest = Infinity;
      for (const [i, j] of S.edges) {
        const a = [S.V[3 * i], S.V[3 * i + 1], S.V[3 * i + 2]];
        const d = [S.V[3 * j] - a[0], S.V[3 * j + 1] - a[1], S.V[3 * j + 2] - a[2]];
        const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        const u = -(a[0] * d[0] + a[1] * d[1] + a[2] * d[2]) / dd;
        expect(u, S.name).toBeGreaterThan(0);
        expect(u, S.name).toBeLessThan(1);
        expect(Math.abs(Math.hypot(a[0] + u * d[0], a[1] + u * d[1], a[2] + u * d[2]) - rho), S.name).toBeLessThan(1e-13);
        shortest = Math.min(shortest, Math.sqrt(dd));
      }
      for (const b of S.offsets) expect(Math.abs(b - S.inradius), S.name).toBeLessThan(1e-14);
      // MathWorld's canonical dipyramid (prism edge 1) and trapezohedron (short edge 1, here 1 / sqrt(1 + 2 cos(pi/n)))
      // [EST, MathWorld "Dipyramid", "Trapezohedron"]
      let volume: number;
      if (S.family === "bipyramid") volume = n / (12 * Math.sin(t) ** 3 * c);
      else {
        expect(Math.abs(shortest - 1 / Math.sqrt(1 + 2 * c)), S.name).toBeLessThan(1e-14);
        const h = t / 2;
        volume = ((n / Math.tan(h) / Math.sin(h) ** 2) * (2 * c + 1)) / (24 * Math.sqrt(2 + 2 * c)) * shortest ** 3;
      }
      expect(Math.abs(S.volume - volume) / volume, S.name).toBeLessThan(1e-14);
    }
  });

  it("are the polar reciprocals about the midsphere of upstream's prisms and antiprisms where upstream has them", () => {
    let checked = 0;
    for (const S of news) {
      const n = dualsOf(S);
      const base = `${S.family === "bipyramid" ? "prism" : "antiprism"}${n}`;
      if (!SOLID_NAMES.includes(base)) continue;
      const B = getSolid(base);
      let rho = 0;
      for (const [i, j] of B.edges)
        rho = Math.hypot((B.V[3 * i] + B.V[3 * j]) / 2, (B.V[3 * i + 1] + B.V[3 * j + 1]) / 2, (B.V[3 * i + 2] + B.V[3 * j + 2]) / 2);
      // the dual vertex of a face with unit normal m at distance h is (rho^2 / h) m
      const dual = B.faces.map((_, f) => [0, 1, 2].map((k) => ((rho * rho) / B.offsets[f]) * B.N[3 * f + k]));
      expect(sameSet(vertices(S), dual, 1e-13), S.name).toBe(true);
      checked++;
    }
    expect(checked).toBe(18);
  });
});

describe("problems and ids", () => {
  it("lists upstream's 86 3D problems and PolyPack's 64 with unique codes", () => {
    expect(POLYHEDRA_PROBLEMS.length).toBe(150);
    expect(new Set(POLYHEDRA_PROBLEMS.map((p) => p.code)).size).toBe(150);
    expect(POLYHEDRA_PROBLEMS.slice(0, 86).every((p) => p.wiki)).toBe(true);
    expect(POLYHEDRA_PROBLEMS.slice(86).some((p) => p.wiki)).toBe(false);
    expect(POLYHEDRA_PROBLEMS.slice(86).map((p) => p.code)).toEqual([
      ...[7, 9, 10, 11].flatMap((k) => [`pr${k}inpr${k}`, `pr${k}incub`]),
      ...[7, 9, 10, 11].flatMap((k) => [`ap${k}inap${k}`, `ap${k}incub`]),
      ...[7, 9, 10, 11].flatMap((k) => ["l15", "l2", "l3"].map((t) => `pr${k}${t}incub`)),
      ...[3, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((n) => [`bp${n}inbp${n}`, `bp${n}incub`]),
      ...[4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((n) => [`tz${n}intz${n}`, `tz${n}incub`]),
    ]);
    expect(getProblem("bp5inbp5")).toMatchObject({ piece: "bipyramid5", container: "bipyramid5", family: "bipyramids", wiki: false });
    expect(getProblem("bp5inbp5")!.title).toBe("Pentagonal bipyramids in a pentagonal bipyramid");
    expect(getProblem("tz11incub")).toMatchObject({ piece: "trapezohedron11", container: "cube", family: "trapezohedra" });
    expect(getProblem("tz11incub")!.title).toBe("Hendecagonal trapezohedra in a cube");
    expect(getProblem("tz9intz9")!.title).toBe("Enneagonal trapezohedra in an enneagonal trapezohedron");
    // the octahedron and the cube are the n = 4 bipyramid and the n = 3 trapezohedron (in other sizes)
    expect(getProblem("bp4inbp4")).toBeNull();
    expect(getProblem("tz3incub")).toBeNull();
    expect(getProblem("pr7incub")).toMatchObject({ piece: "prism7", container: "cube", family: "prisms", wiki: false });
    expect(getProblem("pr7incub")!.title).toBe("Heptagonal prisms in a cube");
    expect(getProblem("ap9inap9")!.title).toBe("Enneagonal antiprisms in an enneagonal antiprism");
    expect(getProblem("pr10l15incub")!.title).toBe("Decagonal prisms of height 1.5 in a cube");
    expect(getProblem("ap11inap11")!.title).toBe("Hendecagonal antiprisms in a hendecagonal antiprism");
    expect(getProblem("pr12incub")!.wiki).toBe(true);
    // catalogue.ts names the same solids as the data, in the same order
    expect(SOLID_NAMES_LIST.map((x) => [x.name, x.code, x.family, x.title])).toEqual(
      SOLID_NAMES.map((n) => [n, getSolid(n).code, getSolid(n).family, getSolid(n).title]),
    );
    expect(PROBLEM_CODES.length).toBe(150);
    expect(problemNameOf("ap11incub")).toMatchObject({ piece: "antiprism11", container: "cube", wiki: false });
    // a listing puts PolyPack's prisms among the wiki's by their sides and keeps the wiki's own order
    expect([...PROBLEM_ORDER].sort()).toEqual([...PROBLEM_CODES].sort());
    const at = (c: string) => PROBLEM_ORDER.indexOf(c);
    expect(PROBLEM_ORDER.filter((c) => problemNameOf(c)!.wiki)).toEqual(PROBLEM_CODES.slice(0, 86));
    expect(PROBLEM_ORDER.slice(at("pr6inpr6"), at("pr6inpr6") + 6)).toEqual(["pr6inpr6", "pr6incub", "pr7inpr7", "pr7incub", "pr8inpr8", "pr8incub"]);
    expect(at("pr11incub") + 1).toBe(at("pr12inpr12"));
    expect(at("ap10incub") + 1).toBe(at("ap11inap11"));
    // then the bipyramids and trapezohedra, in the catalogue's order
    expect(PROBLEM_ORDER.slice(-36)).toEqual(PROBLEM_CODES.slice(-36));
    expect(PROBLEM_ORDER.slice(-42, -36)).toEqual(["pr11l15incub", "pr11l2incub", "pr11l3incub", "pr12l15incub", "pr12l2incub", "pr12l3incub"]);
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
