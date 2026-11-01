/**
 * The float catalogue, checked against the literature's counts and against itself: every vertex satisfies every facet
 * inequality, every facet touches at least d vertices, the edges (pairs at distance 1) number nE, the volume matches the
 * closed forms. The exact proof of the data is python/ndim/catalogue.py (run by python/ndim/test_ndim.py).
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  LAZY_CODES,
  POLYTOPE_CODES,
  ballVolume,
  getPolytope,
  isLoaded,
  loadPolytope,
  polytopeInfo,
  polytopesOfDimension,
  type Polytope,
} from "../src";

// counts from the literature (Coxeter; the uniform polytope tables), restated here independently of the generator
const fact = (n: number): number => (n <= 1 ? 1 : n * fact(n - 1));
function expected(code: string): [number, number, number] {
  const [ds, name] = code.split(":");
  const d = Number(ds);
  switch (name) {
    case "simplex":
      return [d + 1, ((d + 1) * d) / 2, d + 1];
    case "cube":
      return [2 ** d, d * 2 ** (d - 1), 2 * d];
    case "ortho":
      return [2 * d, 2 * d * (d - 1), 2 ** d];
    case "demi":
      return [2 ** (d - 1), 2 ** (d - 3) * d * (d - 1), 2 ** (d - 1) + 2 * d];
  }
  const table: Record<string, [number, number, number]> = {
    "4:24cell": [24, 96, 24],
    "4:120cell": [600, 1200, 120],
    "4:600cell": [120, 720, 600],
    "6:221": [27, 216, 99],
    "6:122": [72, 720, 54],
    "7:321": [56, 756, 702],
    "8:421": [240, 6720, 19440],
  };
  return table[code];
}

beforeAll(async () => {
  await loadPolytope("8:421");
});

describe("catalogue listing", () => {
  it("has the 34 polytopes of the plan", () => {
    expect(POLYTOPE_CODES.length).toBe(34);
    expect(polytopesOfDimension(4)).toEqual(["4:120cell", "4:24cell", "4:600cell", "4:cube", "4:ortho", "4:simplex"]);
    for (let d = 5; d <= 10; d++) {
      for (const n of ["simplex", "cube", "ortho", "demi"]) expect(POLYTOPE_CODES).toContain(`${d}:${n}`);
    }
    expect(POLYTOPE_CODES).not.toContain("4:demi"); // the 4-demicube is the 16-cell
    for (const c of ["6:221", "6:122", "7:321", "8:421"]) expect(POLYTOPE_CODES).toContain(c);
  });
  it("loads 8:421 on demand only", async () => {
    expect(LAZY_CODES).toEqual(["8:421"]);
    expect(isLoaded("8:421")).toBe(true); // by beforeAll
    expect(() => getPolytope("9:nothing")).toThrow(/unknown/);
    expect(polytopeInfo("8:421").nF).toBe(19440);
  });
});

function check(P: Polytope) {
  const { d, nV, nF } = P;
  const [eV, eE, eF] = expected(P.code);
  expect([nV, P.nE, nF]).toEqual([eV, eE, eF]);
  expect(P.V.length).toBe(nV * d);
  expect(P.N.length).toBe(nF * d);
  // centred at the vertex centroid
  for (let c = 0; c < d; c++) {
    let s = 0;
    for (let v = 0; v < nV; v++) s += P.V[v * d + c];
    expect(Math.abs(s / nV)).toBeLessThan(1e-13);
  }
  // unit normals, positive offsets, inradius and circumradius
  let minB = Infinity;
  for (let f = 0; f < nF; f++) {
    let l = 0;
    for (let c = 0; c < d; c++) l += P.N[f * d + c] ** 2;
    expect(Math.abs(Math.sqrt(l) - 1)).toBeLessThan(1e-13);
    expect(P.b[f]).toBeGreaterThan(0);
    minB = Math.min(minB, P.b[f]);
  }
  expect(P.inradius).toBeCloseTo(minB, 13);
  // every vertex inside every facet; every facet touches at least d vertices (to 1e-12); circumradius
  const touch = new Int32Array(nF);
  let maxR = 0;
  for (let v = 0; v < nV; v++) {
    let r = 0;
    for (let c = 0; c < d; c++) r += P.V[v * d + c] ** 2;
    maxR = Math.max(maxR, Math.sqrt(r));
    for (let f = 0; f < nF; f++) {
      let s = 0;
      for (let c = 0; c < d; c++) s += P.N[f * d + c] * P.V[v * d + c];
      const g = P.b[f] - s;
      if (g < -1e-12) throw new Error(`${P.code}: vertex ${v} outside facet ${f} by ${-g}`);
      if (g < 1e-12) touch[f]++;
    }
  }
  expect(Math.abs(maxR - P.circumradius)).toBeLessThan(1e-13);
  for (let f = 0; f < nF; f++) if (touch[f] < d) throw new Error(`${P.code}: facet ${f} touches ${touch[f]} vertices`);
  // unit edges: no pair closer than 1, exactly nE pairs at 1
  let edges = 0;
  for (let i = 0; i < nV; i++)
    for (let j = i + 1; j < nV; j++) {
      let s = 0;
      for (let c = 0; c < d; c++) s += (P.V[i * d + c] - P.V[j * d + c]) ** 2;
      if (s < 1 - 1e-9) throw new Error(`${P.code}: vertices ${i} and ${j} are ${Math.sqrt(s)} apart`);
      if (s < 1 + 1e-9) edges++;
    }
  expect(edges).toBe(eE);
}

describe("every polytope", () => {
  for (const code of POLYTOPE_CODES) {
    it(code, () => {
      check(getPolytope(code));
    });
  }
});

describe("volumes", () => {
  it("matches the closed forms of the simplex, cube, orthoplex and demicube", () => {
    for (let d = 4; d <= 10; d++) {
      expect(getPolytope(`${d}:cube`).volume).toBe(1);
      expect(getPolytope(`${d}:simplex`).volume).toBeCloseTo(Math.sqrt(d + 1) / (fact(d) * 2 ** (d / 2)), 14);
      expect(getPolytope(`${d}:ortho`).volume).toBeCloseTo(2 ** (d / 2) / fact(d), 14);
    }
    // the 5-demicube has volume (1 - 1/15) of the cube of edge sqrt2: (2^5 - 16 * 2^5/5!) / (2 sqrt2)^5
    expect(getPolytope("5:demi").volume).toBeCloseTo((32 - (16 * 32) / 120) / (2 * Math.SQRT2) ** 5, 14);
  });
  it("matches the sum of pyramids over the cells of the regular 4-polytopes", () => {
    // V = (1/4) r_in (number of cells) (cell volume)
    const tet = Math.SQRT2 / 12;
    const oct = Math.SQRT2 / 3;
    const dodec = (15 + 7 * Math.sqrt(5)) / 4;
    expect(getPolytope("4:24cell").volume).toBeCloseTo((24 * getPolytope("4:24cell").inradius * oct) / 4, 12);
    expect(getPolytope("4:24cell").volume).toBeCloseTo(2, 13);
    expect(getPolytope("4:600cell").volume).toBeCloseTo((600 * getPolytope("4:600cell").inradius * tet) / 4, 11);
    expect(getPolytope("4:120cell").volume).toBeCloseTo((120 * getPolytope("4:120cell").inradius * dodec) / 4, 10);
    expect(getPolytope("4:ortho").volume).toBeCloseTo((16 * getPolytope("4:ortho").inradius * tet) / 4, 13);
    expect(getPolytope("4:simplex").volume).toBeCloseTo((5 * getPolytope("4:simplex").inradius * tet) / 4, 13);
  });
  it("has the d-ball volumes", () => {
    expect(ballVolume(4)).toBeCloseTo(Math.PI ** 2 / 2, 14);
    expect(ballVolume(5)).toBeCloseTo((8 * Math.PI ** 2) / 15, 14);
    expect(ballVolume(8)).toBeCloseTo(Math.PI ** 4 / 24, 14);
    expect(ballVolume(10, 0.5)).toBeCloseTo(Math.PI ** 5 / 120 / 2 ** 10, 14);
  });
});
