/**
 * The balls of any solid and the solids in a ball: the catalogue of 189 problems (balls in a ball and in each of the
 * polyhedra space's 94 solids, each of the 94 solids in a ball), the container's geometry (a ball of radius r lies in
 * s C iff N_f . c <= s b_f - r for every face), the bounds, the validator, the search and the kernel on these
 * problems. The search tests assert properties (validity, the bound, determinism), not seeded outcomes, which may
 * differ between Node versions and platforms.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SOLID_NAMES, getSolid } from "@polypack/polyhedra";
import { SOLID_NAMES_LIST } from "@polypack/polyhedra/catalogue";
import { checkKernel } from "@polypack/methods/contract";
import { methodsFor, mulberry32, runMethod } from "@polypack/methods";
import {
  BALLS_CODES,
  BALLS_FAMILY_SAMPLE,
  BALLS_MAX_P,
  BALLS_MIN_P,
  BALLS_ORIGINAL_CODES,
  BALLS_PROBLEMS,
  BALL_DIAMETER,
  BALL_RADIUS,
  type BallsConfig,
  type BallsProblem,
  setBallContainerConversionForTests,
  ballsBound,
  ballsDomain,
  ballsKernel,
  getBallsProblem,
  legalizeBalls,
  parseBallsId,
  searchBalls,
  tightSize,
  validateBalls,
} from "../src";
import { latticeCut } from "../src/ball-pieces";
import { containerOf, containerOfProblem, wallGap } from "../src/container";

const problem = (code: string): BallsProblem => getBallsProblem(code)!;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const containers = BALLS_PROBLEMS.filter((p) => p.piece === "ball" && p.container !== "ball");
const pieces = BALLS_PROBLEMS.filter((p) => p.piece !== "ball");

describe("the catalogue of the solids", () => {
  it("has 189 codes: balls in a ball, in each of the 94 solids, and each of the 94 solids in a ball", () => {
    expect(SOLID_NAMES).toHaveLength(94);
    expect(BALLS_CODES).toHaveLength(1 + 94 + 94);
    expect(new Set(BALLS_CODES).size).toBe(189);
    expect(containers).toHaveLength(94);
    expect(pieces).toHaveLength(94);
    for (const s of SOLID_NAMES_LIST) {
      expect(problem(`ballin${s.code}`), s.name).toMatchObject({ piece: "ball", container: s.name });
      expect(problem(`${s.code}inball`), s.name).toMatchObject({ piece: s.name, container: "ball" });
    }
    expect(ballsDomain.info.problems).toBe(189 * (BALLS_MAX_P - BALLS_MIN_P + 1));
  });

  it("keeps the first 7 problems as they were", () => {
    expect(BALLS_ORIGINAL_CODES).toEqual(["ballinball", "ballincub", "tetinball", "cubinball", "octinball", "dodinball", "icoinball"]);
    expect(BALLS_ORIGINAL_CODES.map((c) => problem(c))).toMatchObject([
      { piece: "ball", container: "ball", title: "Balls in a ball" },
      { piece: "ball", container: "cube", title: "Balls in a cube" },
      { piece: "tetrahedron", container: "ball", title: "Tetrahedra in a ball" },
      { piece: "cube", container: "ball", title: "Cubes in a ball" },
      { piece: "octahedron", container: "ball", title: "Octahedra in a ball" },
      { piece: "dodecahedron", container: "ball", title: "Dodecahedra in a ball" },
      { piece: "icosahedron", container: "ball", title: "Icosahedra in a ball" },
    ]);
  });

  it("titles the problems in words", () => {
    expect(problem("ballinpkd").title).toBe("Balls in a pentakis dodecahedron");
    expect(problem("kttinball").title).toBe("Triakis tetrahedra in a ball");
    expect(problem("ballinpr3l15").title).toBe("Balls in a triangular prism of height 1.5");
    expect(problem("pr3l15inball").title).toBe("Triangular prisms of height 1.5 in a ball");
    expect(problem("ballinoct").title).toBe("Balls in an octahedron");
    expect(problem("ballintz8").title).toBe("Balls in an octagonal trapezohedron");
    expect(problem("tz8inball").title).toBe("Octagonal trapezohedra in a ball");
    expect(problem("sncinball").title).toBe("Snub cubes in a ball");
    expect(new Set(BALLS_PROBLEMS.map((p) => p.title)).size).toBe(189);
  });

  it("groups the menu: each group is one run of codes, the groups name the family", () => {
    const runs: string[] = [];
    for (const p of BALLS_PROBLEMS) if (runs[runs.length - 1] !== p.group) runs.push(p.group);
    expect(new Set(runs).size).toBe(runs.length);
    expect(runs).toEqual([
      "Balls in a ball or a Platonic solid",
      "Balls in an Archimedean solid",
      "Balls in a Catalan solid",
      "Balls in a prism",
      "Balls in an antiprism",
      "Balls in an elongated prism",
      "Balls in a bipyramid",
      "Balls in a trapezohedron",
      "Platonic solids in a ball",
      "Archimedean solids in a ball",
      "Catalan solids in a ball",
      "Prisms in a ball",
      "Antiprisms in a ball",
      "Elongated prisms in a ball",
      "Bipyramids in a ball",
      "Trapezohedra in a ball",
    ]);
    // prisms by sides, the elongated ones by sides and then height
    const prisms = BALLS_CODES.filter((c) => /^ballinpr\d+$/.test(c));
    expect(prisms).toEqual(["ballinpr3", "ballinpr5", "ballinpr6", "ballinpr7", "ballinpr8", "ballinpr9", "ballinpr10", "ballinpr11", "ballinpr12"]);
    const elong = BALLS_CODES.filter((c) => /^ballinpr\d+l/.test(c));
    expect(elong.slice(0, 5)).toEqual(["ballinpr3l15", "ballinpr3l2", "ballinpr3l3", "ballinpr5l15", "ballinpr5l2"]);
    // the domain tells the board
    const f = ballsDomain.info.fields[0];
    expect(f.values).toEqual(BALLS_CODES);
    expect(f.groups!.ballinpkd).toBe("Balls in a Catalan solid");
    expect(f.titles!.kttinball).toBe("Triakis tetrahedra in a ball");
  });

  it("reads and writes the ids of the new codes, in their one written form", () => {
    expect(parseBallsId("balls/ballinpkd/20")).toMatchObject({ code: "ballinpkd", P: 20 });
    expect(parseBallsId("balls/pr3l15inball/7")).toMatchObject({ code: "pr3l15inball", P: 7 });
    expect(parseBallsId("balls/ap5inball/100")).toMatchObject({ code: "ap5inball", P: 100 });
    for (const bad of ["balls/ballinpr3l16/3", "balls/3inball/3", "balls/ballinPKD/3", "balls/pr3l15inball/03", "balls/ballin-pkd/3"])
      expect(typeof parseBallsId(bad), bad).toBe("string");
    for (const p of BALLS_PROBLEMS) expect(parseBallsId(`balls/${p.code}/9`), p.code).toMatchObject({ code: p.code });
  });

  it("samples the volunteers' work list from the first 7 problems only, as before", () => {
    const all = ballsDomain.sample(100000);
    expect(all).toHaveLength(7 * 99);
    expect(all.slice(0, 8)).toEqual([...BALLS_ORIGINAL_CODES.map((c) => `balls/${c}/2`), "balls/ballinball/3"]);
  });

  it("states the ball radius once", () => {
    expect(BALL_RADIUS).toBe(0.5);
    expect(BALL_DIAMETER).toBe(1);
    expect(BALL_DIAMETER).toBe(2 * BALL_RADIUS);
  });
});

describe("the container's geometry", () => {
  it("has the inradius and circumradius of every solid at its vertex centroid (random directions do not improve either)", () => {
    const rng = mulberry32(11);
    for (const name of SOLID_NAMES) {
      const C = containerOf(name);
      const S = C.solid;
      // the inscribed radius at c: the least face distance b_f - N_f . c; the circumscribed one: the largest vertex distance
      const inner = (x: number, y: number, z: number) => {
        let m = Infinity;
        for (let f = 0; f < C.F; f++) m = Math.min(m, C.b[f] - (C.N[3 * f] * x + C.N[3 * f + 1] * y + C.N[3 * f + 2] * z));
        return m;
      };
      const outer = (x: number, y: number, z: number) => {
        let m = 0;
        for (let v = 0; v < S.nv; v++) m = Math.max(m, Math.hypot(S.V[3 * v] - x, S.V[3 * v + 1] - y, S.V[3 * v + 2] - z));
        return m;
      };
      expect(Math.abs(inner(0, 0, 0) - S.inradius), name).toBeLessThan(1e-14);
      expect(Math.abs(outer(0, 0, 0) - S.circumradius), name).toBeLessThan(1e-14);
      for (let t = 0; t < 40; t++) {
        const u = [rng() - 0.5, rng() - 0.5, rng() - 0.5];
        const l = Math.hypot(u[0], u[1], u[2]);
        for (const h of [1e-3, 1e-6]) {
          const d = u.map((v) => (h * v) / l);
          expect(inner(d[0], d[1], d[2]), name).toBeLessThanOrEqual(S.inradius + 1e-14);
          expect(outer(d[0], d[1], d[2]), name).toBeGreaterThanOrEqual(S.circumradius - 1e-14);
        }
      }
    }
  });

  it("measures the gap to the walls as the distance to the planes through the faces' vertices", () => {
    // independent of the stored normals and offsets: the plane of each face from three of its vertices
    const rng = mulberry32(3);
    for (const name of SOLID_NAMES) {
      const C = containerOf(name);
      const S = C.solid;
      const planes = S.faces.map((f) => {
        const [a, b, c] = [f[0], f[1], f[2]].map((i) => [S.V[3 * i], S.V[3 * i + 1], S.V[3 * i + 2]]);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const l = Math.hypot(n[0], n[1], n[2]);
        n = n.map((x) => x / l);
        // outward: away from the origin, inside the solid
        const d = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
        return d >= 0 ? { n, d } : { n: n.map((x) => -x), d: -d };
      });
      for (let t = 0; t < 6; t++) {
        const s = 1 + 3 * rng();
        const c = [s * (rng() - 0.5) * 0.4, s * (rng() - 0.5) * 0.4, s * (rng() - 0.5) * 0.4];
        const want = Math.min(...planes.map((p) => s * p.d - BALL_RADIUS - (p.n[0] * c[0] + p.n[1] * c[1] + p.n[2] * c[2])));
        const got = wallGap(C, s, BALL_RADIUS, c[0], c[1], c[2]);
        expect(Math.abs(got - want), name).toBeLessThan(1e-13);
        const code = SOLID_NAMES_LIST.find((x) => x.name === name)!.code;
        if (name !== "cube")
          expect(validateBalls(problem(`ballin${code}`), { s, pieces: [c] }, { tol: 1 }).minWallGap, name).toBe(got);
      }
    }
  });

  it("holds exactly the centres at least a ball's radius inside: the octahedron, the triakis tetrahedron, a prism", () => {
    // octahedron (edge 1): inradius sqrt 6 / 6, so one ball of radius 1/2 fits from s = sqrt 6 / 2 on, centred
    const oct = problem("ballinoct");
    const s = Math.sqrt(6) / 2;
    const at = (p: BallsProblem, size: number, c = [0, 0, 0]) => validateBalls(p, { s: size, pieces: [c] }, { tol: 0 }).valid;
    expect(at(oct, s * (1 + 1e-12))).toBe(true);
    expect(at(oct, s * (1 - 1e-9))).toBe(false);
    expect(validateBalls(oct, { s: s * (1 - 5e-10), pieces: [[0, 0, 0]] }).valid).toBe(true);
    // a centre moved by 0.05 along a face normal needs the face's offset times s to grow by 0.05 as well: s >= (r + 0.05) / rho
    const rho = getSolid("octahedron").inradius;
    const n = 0.05 / Math.sqrt(3);
    const off = [n, n, n];
    expect(at(oct, ((BALL_RADIUS + 0.05) / rho) * (1 + 1e-12), off)).toBe(true);
    expect(at(oct, ((BALL_RADIUS + 0.05) / rho) * (1 - 1e-9), off)).toBe(false);
  });

  it("attains the two-piece bound of the tangential solids: two balls at the far vertices of the shrunk container", () => {
    // the shrunk container is (s - r / rho) C when every face is at the inradius; s = r / rho + 2 r / D puts two balls at
    // the ends of its diameter D, touching, so the bound cannot be too high [EST]
    for (const code of ["ballintet", "ballinoct", "ballinico", "ballinktt", "ballinbp5", "ballintz6", "ballinpkd", "ballinrdo"]) {
      const p = problem(code);
      const C = containerOfProblem(p)!;
      expect(C.tangential, code).toBe(true);
      let [ia, ib, far] = [0, 0, 0];
      const V = C.solid.V;
      for (let i = 0; i < C.solid.nv; i++)
        for (let j = i + 1; j < C.solid.nv; j++) {
          const d = Math.hypot(V[3 * i] - V[3 * j], V[3 * i + 1] - V[3 * j + 1], V[3 * i + 2] - V[3 * j + 2]);
          if (d > far) [ia, ib, far] = [i, j, d];
        }
      expect(far, code).toBe(C.diameter);
      const two = BALL_RADIUS / C.inradius + BALL_DIAMETER / C.diameter;
      const size = two * (1 + 1e-9);
      // (a hair inside the shrunk container's vertices, which are on its walls)
      const k = (size - BALL_RADIUS / C.inradius) * (1 - 1e-12);
      const config = { s: size, pieces: [[0, 1, 2].map((d) => k * V[3 * ia + d]), [0, 1, 2].map((d) => k * V[3 * ib + d])] };
      expect(validateBalls(p, config, { tol: 0 }).valid, code).toBe(true);
      // just below, the same two balls overlap
      const below = two * (1 - 1e-6);
      const kb = (below - BALL_RADIUS / C.inradius) * (1 - 1e-12);
      const config2 = { s: below, pieces: [[0, 1, 2].map((d) => kb * V[3 * ia + d]), [0, 1, 2].map((d) => kb * V[3 * ib + d])] };
      expect(validateBalls(p, config2, { tol: 0 }).valid, code).toBe(false);
      // the bound is the larger of this, the volume bound and the one-piece bound: never above the packing found
      expect(ballsBound(p, 2).value, code).toBeLessThanOrEqual(size);
      expect(ballsBound(p, 2).value, code).toBeGreaterThanOrEqual(two * (1 - 1e-12));
    }
  });

  it("gives bounds that every valid packing respects, and one-piece bounds that a centred ball attains", () => {
    for (const p of containers) {
      const C = containerOfProblem(p)!;
      const one = BALL_RADIUS / C.inradius;
      expect(validateBalls(p, { s: one * (1 + 1e-12), pieces: [[0, 0, 0]] }, { tol: 0 }).valid, p.code).toBe(true);
      expect(validateBalls(p, { s: one * (1 - 1e-8), pieces: [[0, 0, 0]] }, { tol: 0 }).valid, p.code).toBe(false);
      for (const P of [2, 7, 100]) {
        const b = ballsBound(p, P);
        expect(b.value, `${p.code} ${P}`).toBeGreaterThanOrEqual(one * (1 - 1e-12));
        expect(Number.isFinite(b.value) && b.value > 0, `${p.code} ${P}`).toBe(true);
        expect(b.label, p.code).toMatch(/^\[EST\]/);
      }
    }
    // the volume bound grows with P as P^(1/3)
    const p = problem("ballinpkd");
    expect(ballsBound(p, 100).value).toBeGreaterThan(ballsBound(p, 10).value);
  });

  it("has the bounds of the solids in a ball as before for the Platonic ones, and sound ones for the rest", () => {
    for (const p of pieces) {
      const S = getSolid(p.piece);
      for (const P of [2, 30]) {
        const b = ballsBound(p, P);
        expect(b.value, p.code).toBeGreaterThanOrEqual(S.circumradius);
        expect(b.value, p.code).toBeGreaterThanOrEqual(2 * S.inradius);
      }
    }
  });
});

describe("the validator with a solid container", () => {
  it("tells valid, borderline and invalid for a ball against a face, in any tolerance", () => {
    const p = problem("ballinpr3");
    const C = containerOfProblem(p)!;
    // a prism with a triangular base (edge 1) and height 1: faces at offsets 0.2887 (sides) and 0.5 (ends);
    // one ball at the centre needs s * 0.2887 >= 1
    const s = BALL_RADIUS / C.inradius;
    const v = (size: number, tol: number) => validateBalls(p, { s: size, pieces: [[0, 0, 0]] }, { tol }).valid;
    expect(v(s * (1 + 1e-12), 0)).toBe(true);
    expect(v(s * (1 - 1e-12), 0)).toBe(false);
    // inside the touching tolerance of 1e-9 (a gap of -s * 1e-12 * inradius) but outside tolerance 0
    expect(v(s * (1 - 1e-12), 1e-9)).toBe(true);
    // 3e-9 past a wall: invalid at the touching tolerance
    expect(v(s - 3e-9 / C.inradius, 1e-9)).toBe(false);
    const r = validateBalls(p, { s: s * 0.9, pieces: [[0, 0, 0]] });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/^piece 0 sticks out of the container by /);
    expect(r.minWallGap).toBeLessThan(0);
  });

  it("finds overlaps between balls and the container's walls together, and counts the errors", () => {
    const p = problem("ballinap5");
    const v = validateBalls(p, { s: 4, pieces: [[0, 0, 0], [0.5, 0, 0], [50, 0, 0]] });
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => /pieces 0 and 1 overlap/.test(e))).toBe(true);
    expect(v.errors.some((e) => /piece 2 sticks out/.test(e))).toBe(true);
    expect(v.worstPair).toEqual([0, 1]);
  });

  it("has a tight size that holds the pieces as placed, for every container", () => {
    const rng = mulberry32(21);
    for (const p of containers) {
      const centres = Array.from({ length: 4 }, () => [4 * rng() - 2, 4 * rng() - 2, 4 * rng() - 2]);
      const s = tightSize(p, centres);
      expect(validateBalls(p, { s: s * (1 + 4 * Number.EPSILON), pieces: centres }, { tol: 0 }).errors.filter((e) => /sticks out/.test(e)), p.code).toEqual([]);
      expect(validateBalls(p, { s: s * (1 - 1e-9), pieces: centres }, { tol: 0 }).errors.some((e) => /sticks out/.test(e)), p.code).toBe(true);
    }
  });

  it("validates the solids in a ball for all 94 solids: one at the origin needs a container of diameter twice its circumradius", () => {
    for (const p of pieces) {
      const S = getSolid(p.piece);
      const one = (s: number) => validateBalls(p, { s, pieces: [[0, 0, 0, 1, 0, 0, 0]] }, { tol: 0 }).valid;
      expect(one(2 * S.circumradius * (1 + 1e-12)), p.code).toBe(true);
      expect(one(2 * S.circumradius * (1 - 1e-9)), p.code).toBe(false);
    }
  });
});

describe("the lattice start for solids of any shape", () => {
  it("cuts the P lattice points of least gauge, also for a thin and long prism and P = 100", () => {
    // sc, not turned: the points are 2 r (i, j, k) + t, with t the first three draws
    for (const code of ["ballinpr3l3", "ballinpr12", "ballintet", "ballinbp3"]) {
      const p = problem(code);
      const C = containerOfProblem(p)!;
      const P = 100;
      const t = (() => {
        const r = mulberry32(5);
        return [BALL_RADIUS * (2 * r() - 1), BALL_RADIUS * (2 * r() - 1), BALL_RADIUS * (2 * r() - 1)];
      })();
      const got = latticeCut(p, P, mulberry32(5), "sc", false);
      expect(got).toHaveLength(P);
      const gauge = (q: number[]) => {
        let g = -Infinity;
        for (let f = 0; f < C.F; f++) g = Math.max(g, (C.N[3 * f] * q[0] + C.N[3 * f + 1] * q[1] + C.N[3 * f + 2] * q[2]) / C.b[f]);
        return g;
      };
      const all: number[] = [];
      // every point with a gauge up to the cut's largest lies within gauge x circumradius of the origin
      const gMax = Math.max(...got.map(gauge));
      const m = Math.ceil((gMax * C.circumradius + 2 * BALL_RADIUS * Math.sqrt(3)) / BALL_DIAMETER) + 1;
      for (let i = -m; i <= m; i++)
        for (let j = -m; j <= m; j++)
          for (let k = -m; k <= m; k++) all.push(gauge([BALL_DIAMETER * i + t[0], BALL_DIAMETER * j + t[1], BALL_DIAMETER * k + t[2]]));
      all.sort((a, b) => a - b);
      const mine = got.map(gauge).sort((a, b) => a - b);
      for (let i = 0; i < P; i++) expect(Math.abs(mine[i] - all[i]), `${code} ${i}`).toBeLessThan(1e-8);
    }
  });

  it("makes legalized lattice cuts that are valid in every container of the sample", () => {
    for (const code of BALLS_FAMILY_SAMPLE.filter((c) => c.startsWith("ballin"))) {
      const p = problem(code);
      for (const [kind, turn] of [["fcc", false], ["hcp", false], ["sc", false], ["fcc", true], ["hcp", true]] as const) {
        const c = legalizeBalls(p, latticeCut(p, 20, mulberry32(4), kind, turn), 1e-10, 1e-10);
        expect(validateBalls(p, c, { tol: 0 }).valid, `${code} ${kind} ${turn}`).toBe(true);
      }
    }
  });
});

describe("the search with a solid container", () => {
  it("returns a valid packing no smaller than the bound for balls in each of the 94 solids, P = 2 and 3", async () => {
    for (const p of containers)
      for (const P of [2, 3]) {
        await tick();
        const r = searchBalls(p, P, { seed: 1, maxEvals: 3000 });
        expect(r.config, `${p.code} ${P}`).not.toBeNull();
        expect(validateBalls(p, r.config!, { tol: 0 }).valid, `${p.code} ${P}`).toBe(true);
        expect(r.score, `${p.code} ${P}`).toBeGreaterThanOrEqual(ballsBound(p, P).value * (1 - 1e-9));
        expect(r.config!.pieces).toHaveLength(P);
      }
    await tick();
  });

  it("returns a valid packing for each of the 94 solids in a ball, P = 2 and 3", async () => {
    for (const p of pieces)
      for (const P of [2, 3]) {
        await tick();
        const r = searchBalls(p, P, { seed: 2, maxEvals: 2500 });
        expect(r.config, `${p.code} ${P}`).not.toBeNull();
        expect(validateBalls(p, r.config!, { tol: 0 }).valid, `${p.code} ${P}`).toBe(true);
        expect(r.score, `${p.code} ${P}`).toBeGreaterThanOrEqual(ballsBound(p, P).value * (1 - 1e-9));
      }
    await tick();
  });

  it("is reproducible by seed on a count of evaluations, at larger P in a prism, and stops when told", () => {
    for (const code of ["ballinpr5l2", "ballinkth"]) {
      const p = problem(code);
      const a = searchBalls(p, 9, { seed: 4, maxEvals: 6000 });
      const b = searchBalls(p, 9, { seed: 4, maxEvals: 6000 });
      expect(a.config).toEqual(b.config);
      expect(a.evaluations).toBe(b.evaluations);
      expect(a.stopped).toBe("evals");
      expect(validateBalls(p, a.config!, { tol: 0 }).valid).toBe(true);
      let n = 0;
      const c = searchBalls(p, 9, { seed: 4, shouldStop: () => ++n > 50 });
      expect(c.stopped).toBe("aborted");
      if (c.config) expect(validateBalls(p, c.config, { tol: 0 }).valid).toBe(true);
    }
  });

  it("polishes a given overlapping start in a polyhedron to a valid packing no larger than its legalization", () => {
    const p = problem("ballinap6");
    const rng = mulberry32(8);
    const start: BallsConfig = { s: 30, pieces: Array.from({ length: 12 }, () => [2 * rng() - 1, 2 * rng() - 1, 2 * rng() - 1]) };
    const legal = legalizeBalls(p, start.pieces as [number, number, number][], 1e-10, 1e-10);
    expect(validateBalls(p, legal, { tol: 0 }).valid).toBe(true);
    const r = searchBalls(p, 12, { seed: 1, start, maxEvals: 20000 });
    expect(validateBalls(p, r.config!, { tol: 0 }).valid).toBe(true);
    expect(r.score).toBeLessThanOrEqual(legal.s);
  });
});

describe("the kernel with a solid container", () => {
  it("passes the kernel contract on a problem of each family, as container and as piece, at P = 2 and 4", async () => {
    for (const code of BALLS_FAMILY_SAMPLE)
      for (const P of [2, 4]) {
        expect(checkKernel(() => ballsKernel({ code, P }), { seed: P, states: 3 }), `${code} P = ${P}`).toEqual([]);
        await tick();
      }
  });

  it("has exact gradients for overlapping balls and walls in a polyhedron, and a container smaller than a ball", () => {
    for (const code of BALLS_FAMILY_SAMPLE.filter((c) => c.startsWith("ballin"))) {
      const k = ballsKernel({ code, P: 6 });
      const rng = mulberry32(2);
      const s = k.randomStart(rng);
      k.setSize(s, 0.45 * s.size);
      for (let i = 0; i < 6; i++) k.jiggle(s, i, 3, rng);
      expect(k.energy(s), code).toBeGreaterThan(1e-3);
      const n = k.P * k.dim;
      const g = new Float64Array(n + 1);
      k.energy(s, g);
      for (let i = 0; i <= n; i++) {
        const h = 1e-6 * (i < n ? k.steps[i % k.dim] : 1);
        const p = k.clone(s);
        const m = k.clone(s);
        if (i < n) {
          p.x[i] += h;
          m.x[i] -= h;
        } else {
          p.size += h;
          m.size -= h;
        }
        const fd = (k.energy(p) - k.energy(m)) / (2 * h);
        expect(Math.abs(fd - g[i]) / Math.max(1, Math.abs(fd), Math.abs(g[i])), `${code} ${i}`).toBeLessThan(1e-6);
      }
    }
    // a container smaller than a ball: every face of the octahedron pushes
    const k = ballsKernel({ code: "ballinoct", P: 2 });
    const s = k.fromConfig({ s: 1.5, pieces: [[0.1, -0.2, 0.3], [5, 0, 0]] })!;
    expect(k.energy(s)).toBeGreaterThan(0);
  });

  it("has zero energy exactly when balls are valid at tolerance 0, and clear() agrees with the validator", () => {
    const rng = mulberry32(6);
    const ulps = (x: number, n: number) => x + n * 2 ** (Math.floor(Math.log2(Math.abs(x))) - 52);
    let invalid = 0;
    let valid = 0;
    for (const code of ["ballintet", "ballinpr3", "ballinpkd", "ballinpr7l3", "ballinap5"]) {
      const pb = problem(code);
      const kc = ballsKernel({ code, P: 3 });
      for (let t = 0; t < 120; t++) {
        const n = () => Math.floor(7 * rng()) - 3;
        const u = [rng() - 0.5, rng() - 0.5, rng() - 0.5];
        const l = Math.hypot(u[0], u[1], u[2]);
        const a = [rng() - 0.5, rng() - 0.5, rng() - 0.5].map((v) => 0.2 * v);
        const d = ulps(2, n());
        const e = ulps(2, n());
        const centres = [a, a.map((v, i) => v + (d * u[i]) / l), a.map((v, i) => v - (e * u[i]) / l)];
        const config = { s: ulps(tightSize(pb, centres), n()), pieces: centres };
        const st = kc.fromConfig(config)!;
        const ok = validateBalls(pb, config, { tol: 0 }).valid;
        if (ok) valid++;
        else invalid++;
        expect(kc.energy(st) === 0, `${code} ${t}`).toBe(ok);
        for (const tol of [0, 1e-9])
          expect([0, 1, 2].every((i) => kc.clear(st, i, tol)), `${code} ${t} ${tol}`).toBe(validateBalls(pb, config, { tol }).valid);
      }
    }
    expect(invalid).toBeGreaterThan(50);
    expect(valid).toBeGreaterThan(50);
  });

  it("states its bound, its costs and its capabilities for the new problems", () => {
    const a = ballsKernel({ code: "ballinpkd", P: 10 });
    expect(a.dim).toBe(3);
    expect(a.capabilities).toEqual(["shape", "seeds"]);
    expect(a.inradius).toBe(BALL_RADIUS);
    expect(a.bound).toBe(ballsBound(problem("ballinpkd"), 10).value);
    const b = ballsKernel({ code: "pr3l3inball", P: 10 });
    expect(b.dim).toBe(6);
    expect(b.capabilities).toEqual(["shape", "seeds", "swap"]);
    expect(b.inradius).toBe(getSolid("prism3_l3").inradius);
    for (const q of [a, b]) {
      expect(q.finishCost).toBeGreaterThanOrEqual(10);
      expect(q.validateCost).toBeLessThan(q.finishCost);
    }
    expect(ballsKernel({ code: "ballintz12", P: 100 }).P).toBe(100);
    expect(() => ballsKernel({ code: "ballintz12", P: 101 })).toThrow(/from 2 to 100/);
  });

  it("runs every method it offers on a problem of each family at P = 3, valid by the server's rule", async () => {
    for (const code of ["ballintet", "ballinpr7l3", "ballinbp5", "ballinpkd", "pr3inball", "tz6inball", "ap4inball"]) {
      const P = 3;
      const k = ballsKernel({ code, P });
      const names = methodsFor(k).map((m) => m.name);
      expect(names, code).toEqual(
        expect.arrayContaining(["penalty", "mc_compress", "asc", "basin_hopping", "shrink_repair", "harden", "morph", "seed"]),
      );
      const evals = 2 * (k.finishCost + k.validateCost!) + 1500;
      const pb = problem(code);
      const found = searchBalls(pb, P, { seed: 3, maxEvals: 3000 }).config!;
      const grown = { ...found, s: found.s * 1.03 };
      expect(k.validate(grown).valid, code).toBe(true);
      for (const name of names)
        for (const from of [grown, undefined]) {
          const r = runMethod(k, name, { seed: 7, ...(from ? { start: from } : {}), budget: { evals, time_s: 30 } });
          expect(r.reasons.filter((x) => x !== "no valid configuration found"), `${code} ${name}`).toEqual([]);
          if (from) expect(r.score!, `${code} ${name}`).toBeLessThanOrEqual(grown.s);
          if (r.config) {
            expect(k.validate(r.config).valid, `${code} ${name}`).toBe(true);
            expect(validateBalls(pb, r.config as BallsConfig, { tol: 0 }).valid, `${code} ${name}`).toBe(true);
            expect(r.score, `${code} ${name}`).toBeGreaterThanOrEqual(k.bound! * (1 - 1e-9));
          } else expect(from, `${code} ${name}`).toBeUndefined();
        }
      await tick();
    }
  });
});

describe("the certifier's fixtures", () => {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../python/balls/fixtures/${name}`, import.meta.url), "utf8"));

  it("has the validator's gaps in crosscheck_solids.json, passing at tolerance 0 exactly the separated cases", () => {
    const fixture = read("crosscheck_solids.json") as { cases: { code: string; what: string; config: BallsConfig; gap: number }[] };
    expect(fixture.cases).toHaveLength(702);
    for (const c of fixture.cases) {
      const pb = problem(c.code);
      const v = validateBalls(pb, c.config, { tol: 1 });
      const gap = c.what.startsWith("pair") ? v.minPairSep : v.minWallGap;
      expect(Math.abs(gap - c.gap), `${c.code} ${c.what}`).toBeLessThan(1e-15);
      expect(validateBalls(pb, c.config, { tol: 0 }).valid, `${c.code} ${c.what}`).toBe(c.gap >= 0);
    }
  });

  it("has the bounds and solid geometry of bounds.json, which the certifier's bound() reproduces", () => {
    const fixture = read("bounds.json") as {
      solids: Record<string, { volume: number; inradius: number; circumradius: number; diameter: number; tangential: boolean }>;
      bounds: { code: string; P: number; value: number; kind: string }[];
    };
    expect(Object.keys(fixture.solids)).toEqual([...SOLID_NAMES]);
    for (const [name, g] of Object.entries(fixture.solids)) expect(containerOf(name), name).toMatchObject(g);
    expect(fixture.bounds).toHaveLength(189 * 3);
    for (const b of fixture.bounds) expect(ballsBound(problem(b.code), b.P), `${b.code} ${b.P}`).toMatchObject({ value: b.value, kind: b.kind });
  });
});

describe("a ball container scored by a multiple of its radius", () => {
  // The score of a ball container is its radius today and will be its diameter: only ballContainerScore and
  // ballContainerRadius change. A test-only hook swaps in radius = k score, and everything that depends on the
  // conversion must stay right: bounds, validity, the kernel's contract, gradients in the size, clear() against the validator.
  for (const k of [0.5, 2]) {
    it(`keeps the bounds, the kernel's gradients and clear() right when the radius is ${k} times the score`, async () => {
      try {
        setBallContainerConversionForTests(k);
        for (const code of ["ballinball", "tetinball", "pr3inball", "kttinball"]) {
          const pb = problem(code);
          // the bound is a score: the radius bound over k (here only for the ball containers)
          setBallContainerConversionForTests(1);
          const radiusBound = ballsBound(pb, 7).value;
          setBallContainerConversionForTests(k);
          expect(ballsBound(pb, 7).value, code).toBeCloseTo(radiusBound / k, 12);
          expect(checkKernel(() => ballsKernel({ code, P: 4 }), { seed: 3, states: 3 }), code).toEqual([]);
          await tick();
          const kern = ballsKernel({ code, P: 5 });
          const rng = mulberry32(9);
          const st = kern.randomStart(rng);
          kern.setSize(st, 0.5 * st.size);
          for (let i = 0; i < 5; i++) kern.jiggle(st, i, 2, rng);
          const n = kern.P * kern.dim;
          const g = new Float64Array(n + 1);
          expect(kern.energy(st, g), code).toBeGreaterThan(1e-3);
          // the derivative in the size, by central differences
          const h = 1e-6 * st.size;
          const up = kern.clone(st);
          const dn = kern.clone(st);
          up.size += h;
          dn.size -= h;
          const fd = (kern.energy(up) - kern.energy(dn)) / (2 * h);
          expect(Math.abs(fd - g[n]) / Math.max(1, Math.abs(fd)), `${code} ds`).toBeLessThan(1e-6);
          // clear() against the validator at the size the pieces need, a few ulps either side
          for (const f of [1 - 1e-9, 1 - 1e-13, 1, 1 + 1e-13, 1 + 1e-9]) {
            const centres = Array.from({ length: 3 }, () => [2 * rng() - 1, 2 * rng() - 1, 2 * rng() - 1]);
            const poses = kern.dim === 6 ? centres.map((c) => [...c, 1, 0, 0, 0]) : centres;
            const sized = tightSize(pb, poses);
            const cfg = { s: sized * f, pieces: poses };
            const k3 = ballsKernel({ code, P: 3 });
            const state = k3.fromConfig(cfg)!;
            for (const tol of [0, 1e-9]) {
              const v = validateBalls(pb, cfg, { tol }).errors.filter((e) => /sticks out/.test(e)).length === 0;
              // clear() also looks at pairs, so compare only where the pairs are fine
              const walls = [0, 1, 2].every((i) => k3.clear(state, i, tol));
              const pairsOk = validateBalls(pb, cfg, { tol }).errors.every((e) => /sticks out/.test(e));
              if (pairsOk) expect(walls, `${code} f=${f} tol=${tol}`).toBe(v);
            }
          }
        }
      } finally {
        setBallContainerConversionForTests(null);
      }
    });
  }
});
