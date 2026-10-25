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

describe("solids", () => {
  it("has upstream's 56 solids and PolyPack's 18, each a closed convex polyhedron centred at the origin", () => {
    expect(SOLID_NAMES.length).toBe(74);
    expect(SOLID_NAMES.slice(56)).toEqual([
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
    expect(checked).toBe(10);
  });
});

describe("problems and ids", () => {
  it("lists upstream's 86 3D problems, then PolyPack's 36, with unique codes", () => {
    expect(POLYHEDRA_PROBLEMS.length).toBe(122);
    expect(new Set(POLYHEDRA_PROBLEMS.map((p) => p.code)).size).toBe(122);
    expect(POLYHEDRA_PROBLEMS.slice(0, 86).every((p) => p.wiki)).toBe(true);
    expect(POLYHEDRA_PROBLEMS.slice(86).some((p) => p.wiki)).toBe(false);
    expect(POLYHEDRA_PROBLEMS.slice(86, 90).map((p) => p.code)).toEqual(["bp3inbp3", "bp3incub", "bp5inbp5", "bp5incub"]);
    expect(POLYHEDRA_PROBLEMS.at(-1)!.code).toBe("tz12incub");
    expect(getProblem("bp5inbp5")).toMatchObject({ piece: "bipyramid5", container: "bipyramid5", family: "bipyramids", wiki: false });
    expect(getProblem("bp5inbp5")!.title).toBe("Pentagonal bipyramids in a pentagonal bipyramid");
    expect(getProblem("tz11incub")).toMatchObject({ piece: "trapezohedron11", container: "cube", family: "trapezohedra" });
    expect(getProblem("tz11incub")!.title).toBe("Hendecagonal trapezohedra in a cube");
    expect(getProblem("tz9intz9")!.title).toBe("Enneagonal trapezohedra in an enneagonal trapezohedron");
    // the octahedron and the cube are the n = 4 bipyramid and the n = 3 trapezohedron (in other sizes)
    expect(getProblem("bp4inbp4")).toBeNull();
    expect(getProblem("tz3incub")).toBeNull();
    expect(POLYHEDRA_PROBLEMS.slice(0, 5).map((p) => p.code)).toEqual(["tetintet", "octinoct", "icoinico", "dodindod", "cubincub"]);
    expect(getProblem("pr3l15incub")).toMatchObject({ piece: "prism3_l15", container: "cube", family: "prisms" });
    expect(getProblem("cubintet")!.title).toBe("Cubes in a tetrahedron");
    expect(getProblem("icoinoct")!.title).toBe("Icosahedra in an octahedron");
  });

  it("parses ids in their one written form only", () => {
    expect(parsePolyhedraId("polyhedra/cubintet/12")).toMatchObject({ code: "cubintet", P: 12 });
    expect(formatPolyhedraId("cubintet", 12)).toBe("polyhedra/cubintet/12");
    for (const bad of ["polyhedra/cubintet/012", "polyhedra/cubintet/+1", "polyhedra/cubintet/0", "polyhedra/blob/3", "surface/cube/fold/0/1", "polyhedra/cubintet", 12])
      expect(typeof parsePolyhedraId(bad)).toBe("string");
    expect(wikiUrl("cubincub", 5)).toBe("https://polyhedrainpolyhedra.wiki/#cubincub_n05");
  });

  it("computes the volume bound", () => {
    expect(volumeBound(getProblem("cubincub")!, 8)).toBe(2);
    expect(volumeBound(getProblem("tetintet")!, 8)).toBeCloseTo(2, 14);
  });
});
