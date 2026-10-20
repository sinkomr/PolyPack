import { describe, expect, it } from "vitest";
import { Pose, circumradius, evaluate, inradius, pieceSeparation, strictVerify } from "../src";

// docs/proofs/circle-container-floor.md: P regular N-gons in a circle reach the floor
// sqrt(r_N^2 rho0(P)^2 + 1/4) when every piece of the scaled circle optimum is turned face-on to
// its contacts. This test builds the proof's packings from its closed forms (not from the
// Packomania coordinates in data/records.json) and scores them with the site's own code.
// The exact check is python/proofs/circle_floor.py.

type Pt = [number, number];
/** A circle configuration in circle units: centres, wall radius a = rho0 - 1, stated contacts. */
interface Config {
  P: number;
  a: number;
  points: Record<string, Pt>;
  /** circles touching the wall */
  walls: string[];
  /** touching pairs */
  contacts: [string, string][];
  /** the N <= 100 claimed */
  classes: number[];
}

const deg = Math.PI / 180;
const e = (d: number, s = 1): Pt => [s * Math.cos(d * deg), s * Math.sin(d * deg)];
const every = (q: number, lo = 3) => Array.from({ length: 101 - lo }, (_, i) => i + lo).filter((N) => N % q === 0);

/** A ring of n touching circles at angles phi0 + 360 k / n, optionally with a centre circle. */
function ring(P: number, n: number, phi0: number, classes: number[], centre?: "touch" | "free"): Config {
  const a = 1 / Math.sin(Math.PI / n);
  const points: Record<string, Pt> = {};
  const walls: string[] = [];
  const contacts: [string, string][] = [];
  for (let k = 0; k < n; k++) {
    points[`c${k}`] = e(phi0 + (360 * k) / n, a);
    walls.push(`c${k}`);
    if (n > 2 || k === 0) contacts.push([`c${k}`, `c${(k + 1) % n}`]);
  }
  if (centre) {
    points.O = [0, 0];
    if (centre === "touch") for (let k = 0; k < n; k++) contacts.push(["O", `c${k}`]);
  }
  return { P, a, points, walls, contacts, classes };
}

function config11(): Config {
  const a = 1 / Math.sin(20 * deg);
  const t = Math.tan(10 * deg);
  const ks = [0, 1, 3, 4, 5, 6, 7, 8];
  const points: Record<string, Pt> = { X1: [-1, -t], X2: [1, -t], X3: [0, Math.sqrt(3) - t] };
  for (const k of ks) points[`W${k}`] = e(10 + 40 * k, a);
  const contacts: [string, string][] = [0, 3, 4, 5, 6, 7].map((k) => [`W${k}`, `W${k + 1}`]);
  contacts.push(["W8", "W0"], ["X1", "X2"], ["X1", "X3"], ["X2", "X3"], ["X1", "W4"], ["X1", "W5"]);
  contacts.push(["X2", "W0"], ["X2", "W8"], ["X3", "W1"], ["X3", "W3"]);
  return { P: 11, a, points, walls: ks.map((k) => `W${k}`), contacts, classes: [36, 72] };
}

function config13(): Config {
  const A = 1 + Math.sqrt(5);
  const b = Math.sqrt(5) - 1;
  const ks = [0, 1, 3, 4, 5, 6, 7, 8, 9];
  const points: Record<string, Pt> = { Y1: e(270, b), Y2: e(162, b), Y3: e(18, b), Y4: [0, 2] };
  for (const k of ks) points[`W${k}`] = e(18 + 36 * k, A);
  const contacts: [string, string][] = [0, 3, 4, 5, 6, 7, 8, 9].map((k) => [`W${k}`, `W${(k + 1) % 10}`]);
  contacts.push(["Y1", "W7"], ["Y3", "W0"], ["Y2", "W4"], ["Y4", "W1"], ["Y4", "W3"]);
  contacts.push(["Y1", "Y3"], ["Y1", "Y2"], ["Y3", "Y4"], ["Y2", "Y4"]);
  return { P: 13, a: A, points, walls: ks.map((k) => `W${k}`), contacts, classes: every(10) };
}

function config19(): Config {
  const A = Math.sqrt(2) + Math.sqrt(6);
  const points: Record<string, Pt> = { O: [0, 0] };
  const contacts: [string, string][] = [];
  for (let j = 0; j < 6; j++) {
    points[`H${j}`] = e(60 * j, 2);
    contacts.push(
      ["O", `H${j}`],
      [`H${j}`, `H${(j + 1) % 6}`],
      [`H${j}`, `W${2 * j}`],
      [`H${j}`, `W${(2 * j + 11) % 12}`],
    );
  }
  const walls: string[] = [];
  for (let k = 0; k < 12; k++) {
    points[`W${k}`] = e(15 + 30 * k, A);
    walls.push(`W${k}`);
    contacts.push([`W${k}`, `W${(k + 1) % 12}`]);
  }
  return { P: 19, a: A, points, walls, contacts, classes: every(24) };
}

/** Theorem 3 (P = 6): the centre and five circles at radius 2, gaps of k 360/N degrees. */
function sixCentre(N: number): Config {
  const g = Math.floor(N / 6) + 1;
  const gaps = [g, g, g, g, N - 4 * g];
  const points: Record<string, Pt> = { O: [0, 0] };
  const contacts: [string, string][] = [];
  for (let k = 0, s = 0; k < 5; s += gaps[k], k++) {
    points[`c${k}`] = e((360 * s) / N, 2);
    contacts.push(["O", `c${k}`]);
  }
  return { P: 6, a: 2, points, walls: [0, 1, 2, 3, 4].map((k) => `c${k}`), contacts, classes: [N] };
}

const theorem2: Config[] = [
  ring(2, 2, 0, every(2, 4)),
  ring(3, 3, 90, every(12)),
  ring(4, 4, 45, every(8)),
  ring(5, 5, 90, every(20)),
  ring(6, 6, 0, every(3)),
  ring(7, 6, 0, every(6), "touch"),
  ring(8, 7, 90, every(28), "free"),
  ring(9, 8, 22.5, every(16), "free"),
  config11(),
  config13(),
  config19(),
];
const theorem3 = every(2, 10)
  .filter((N) => N % 3 !== 0 && N !== 14)
  .map(sixCentre);

/** Contact directions (radians) of each circle: outwards for wall circles, then towards each neighbour. */
function directions(c: Config): Record<string, number[]> {
  const dirs: Record<string, number[]> = {};
  for (const k of Object.keys(c.points)) dirs[k] = [];
  for (const k of c.walls) dirs[k].push(Math.atan2(c.points[k][1], c.points[k][0]));
  for (const [i, j] of c.contacts) {
    const [dx, dy] = [c.points[j][0] - c.points[i][0], c.points[j][1] - c.points[i][1]];
    dirs[i].push(Math.atan2(dy, dx));
    dirs[j].push(Math.atan2(-dy, -dx));
  }
  return dirs;
}

/** Is every direction of each circle a multiple of 2 pi / N away from its first one? */
function congruent(c: Config, N: number): boolean {
  const step = (2 * Math.PI) / N;
  return Object.values(directions(c)).every((d) =>
    d.every((psi) => {
      const k = (psi - d[0]) / step;
      return Math.abs(k - Math.round(k)) < 1e-9;
    }),
  );
}

/** The proof's placement: centre r_N c_i, a face normal along the first contact direction psi_i. */
function build(c: Config, N: number): { names: string[]; pieces: Pose[] } {
  const r = inradius(N);
  const dirs = directions(c);
  const names = Object.keys(c.points);
  const pieces = names.map((k) => ({
    x: r * c.points[k][0],
    y: r * c.points[k][1],
    // vertex k at theta + pi/2 + 2 pi k / N (shapes.ts), so face normals at theta + pi/2 + pi/N + 2 pi k / N
    theta: dirs[k].length ? dirs[k][0] - Math.PI / 2 - Math.PI / N : 0,
  }));
  return { names, pieces };
}

const floorOf = (c: Config, N: number) => Math.hypot(inradius(N) * (c.a + 1), 0.5);

describe("circle-container floor (docs/proofs/circle-container-floor.md)", () => {
  it("has 148 cases in Theorem 2 and 30 more in Theorem 3", () => {
    expect(theorem2.reduce((n, c) => n + c.classes.length, 0)).toBe(148);
    expect(theorem3.map((c) => c.classes[0])).toEqual(
      every(2, 4).filter((N) => N % 3 !== 0 && ![4, 8, 14].includes(N)),
    );
    expect(theorem3.length).toBe(30);
  });

  it("finds the stated contacts in each configuration, and no others", () => {
    for (const c of [...theorem2, ...theorem3]) {
      const names = Object.keys(c.points);
      expect(names.length).toBe(c.P);
      const stated = new Set(c.contacts.map(([i, j]) => [i, j].sort().join(",")));
      for (let s = 0; s < names.length; s++) {
        const [x, y] = c.points[names[s]];
        expect(Math.hypot(x, y) - c.a).toBeLessThan(1e-12);
        if (!c.walls.includes(names[s])) expect(Math.hypot(x, y)).toBeLessThan(c.a - 1e-3);
        else expect(Math.abs(Math.hypot(x, y) - c.a)).toBeLessThan(1e-12);
        for (let t = s + 1; t < names.length; t++) {
          const [u, v] = c.points[names[t]];
          const d = Math.hypot(u - x, v - y);
          if (stated.has([names[s], names[t]].sort().join(","))) expect(Math.abs(d - 2)).toBeLessThan(1e-12);
          else expect(d).toBeGreaterThan(2 + 1e-3);
        }
      }
    }
  });

  it("is commensurate exactly for the claimed N <= 100", () => {
    for (const c of theorem2) {
      expect(
        every(1).filter((N) => congruent(c, N)),
        `P = ${c.P}`,
      ).toEqual(c.classes);
    }
    for (const c of theorem3) expect(congruent(c, c.classes[0])).toBe(true);
  });

  it("builds valid packings at the floor, accepted by evaluate and strictVerify", () => {
    let count = 0;
    for (const c of [...theorem2, ...theorem3]) {
      for (const N of c.classes) {
        const { names, pieces } = build(c, N);
        const evaluation = evaluate({ N, M: 0, P: c.P, pieces, container_phi: 0 });
        const tag = `(${N}, 0, ${c.P})`;
        expect(evaluation.valid, `${tag}: ${evaluation.reasons.join("; ")}`).toBe(true);
        const floor = floorOf(c, N);
        expect(Math.abs(evaluation.score! - floor) / floor, tag).toBeLessThan(1e-12);
        expect(strictVerify(N, pieces, evaluation.container!).ok, tag).toBe(true);
        // contacts are flush; every other pair keeps a gap (the six triangles of N = 3 meet at the centre)
        const stated = new Set(c.contacts.map(([i, j]) => [i, j].sort().join(",")));
        for (let s = 0; s < pieces.length; s++)
          for (let t = s + 1; t < pieces.length; t++) {
            const sep = pieceSeparation(N, pieces[s], pieces[t]).sep;
            if (stated.has([names[s], names[t]].sort().join(","))) expect(Math.abs(sep), tag).toBeLessThan(1e-12);
            else if (N === 3) expect(sep, tag).toBeGreaterThan(-1e-12);
            else {
              expect(sep, tag).toBeGreaterThan(0.3);
              const d = Math.hypot(pieces[s].x - pieces[t].x, pieces[s].y - pieces[t].y);
              expect(d, tag).toBeGreaterThanOrEqual(2 * circumradius(N));
            }
          }
        count++;
      }
    }
    expect(count).toBe(178);
  });
});
