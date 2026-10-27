import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Container,
  LiteratureRecord,
  Overlap,
  PackingConfig,
  Pose,
  TOL,
  autoOrientSet,
  boundingRadius,
  circumradius,
  enclose,
  encloseSet,
  evaluate,
  extremePoints,
  findFreeSpot,
  findOverlaps,
  inradius,
  pairSeparation,
  pieceSeparation,
  regularPolygonSeparation,
} from "../src";

// The narrow phase and the container at one orientation take shortcuts (pairSeparation, and
// `enclose` from candidate pieces). Both must give exactly what the plain algorithms give: the
// same doubles, so that validity, reasons, overlaps and scores stay what they were, and stored
// scores stay comparable. The plain algorithms are kept here as the reference.

/** The broad phase of findOverlaps with the full separating-axis test of every near pair. */
function referenceOverlaps(N: number, poses: readonly Pose[], tol = TOL, scale = 1, limit = Infinity): Overlap[] {
  const reach = 2 * boundingRadius(N) * scale;
  const OFFSET = 2 ** 25;
  const SPAN = 2 ** 26;
  const grid = new Map<number, number[]>();
  const out: Overlap[] = [];
  for (let i = 0; i < poses.length; i++) {
    const a = poses[i];
    const ix = Math.floor(a.x / reach);
    const iy = Math.floor(a.y / reach);
    for (let gx = ix - 1; gx <= ix + 1; gx++)
      for (let gy = iy - 1; gy <= iy + 1; gy++)
        for (const j of grid.get((gx + OFFSET) * SPAN + (gy + OFFSET)) ?? []) {
          const b = poses[j];
          if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 > reach * reach) continue;
          const sep = pieceSeparation(N, a, b, scale).sep;
          if (sep < -tol && out.push({ i: j, j: i, sep }) >= limit) return out;
        }
    const key = (ix + OFFSET) * SPAN + (iy + OFFSET);
    grid.set(key, [...(grid.get(key) ?? []), i]);
  }
  return out;
}

/** evaluate as it was before the shortcuts: the container from the hull of all the vertices. */
function referenceEvaluate(config: PackingConfig, opts: { autoOrient?: boolean; maxOverlaps?: number } = {}) {
  const { N, M, P, pieces } = config;
  const reasons: string[] = [];
  if (pieces.length !== P) reasons.push(`expected exactly ${P} pieces, got ${pieces.length}`);
  const limit = opts.maxOverlaps ?? Infinity;
  const overlaps = referenceOverlaps(N, pieces, TOL, 1, limit);
  if (overlaps.length) {
    const worst = overlaps.reduce((a, b) => (b.sep < a.sep ? b : a));
    const count = overlaps.length >= limit ? `at least ${overlaps.length}` : `${overlaps.length}`;
    reasons.push(
      `${count} overlapping pair(s); deepest found is pieces ${worst.i} and ${worst.j}, ` +
        `penetration ${(-worst.sep).toExponential(3)} (tolerance ${TOL})`,
    );
  }
  let container: Container | null = null;
  if (pieces.length > 0) {
    const set = extremePoints(N, pieces);
    container = encloseSet(set, M, config.container_phi);
    if (opts.autoOrient && M !== 0) {
      const best = autoOrientSet(set, M, config.container_phi);
      if (best.size < container.size) container = best;
    }
  }
  return { valid: reasons.length === 0, reasons, overlaps, container, score: container ? container.size : null };
}

let seed = 20261021;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];

describe("the narrow phase", () => {
  it("gives regularPolygonSeparation's value for every pair, from far fewer axes", () => {
    // The pairs are drawn at random, but stratified: N runs through every small side count, the primes and
    // composites around the pruning's thresholds and 100, and the orientation, offset and distance cases below
    // come round in turn
    const sides = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 24, 36, 60, 97, 100];
    let pairs = 0;
    for (let t = 0; t < 20_000; t++) {
      const N = t % 3 === 0 ? 3 + Math.floor(random() * 98) : sides[t % sides.length];
      const R = circumradius(N);
      const r = inradius(N);
      const step = (2 * Math.PI) / N;
      // orientations anywhere, or on and next to the multiples of pi / N where axes tie
      const angle = () => {
        const kind = random();
        if (kind < 0.3) return (random() - 0.5) * 20;
        if (kind < 0.6) return Math.round((random() - 0.5) * 4 * N) * (step / 2) + (random() - 0.5) * 1e-12;
        if (kind < 0.7) return (random() - 0.5) * 2000;
        // beyond the pruning's range: the full test
        if (kind < 0.75) return (random() - 0.5) * 1e7;
        return Math.round(random() * 40) * (step / 2);
      };
      // centres anywhere in the coordinate range, at any distance from overlapping to just apart
      const far = random() < 0.2 ? 1e6 : 100;
      const a: Pose = { x: (random() - 0.5) * 2 * far, y: (random() - 0.5) * 2 * far, theta: angle() };
      const dir = random() < 0.3 ? Math.round(random() * 4 * N) * (step / 2) : random() * 2 * Math.PI;
      const kind = random();
      const dist = kind < 0.1 ? 0 : kind < 0.4 ? 2 * r * (1 + (random() - 0.5) * 1e-9) : random() * 2 * R * 1.05;
      const b: Pose = { x: a.x + dist * Math.cos(dir), y: a.y + dist * Math.sin(dir), theta: angle() };
      const scale = random() < 0.2 ? 1 - 1e-8 : 1;
      const full = regularPolygonSeparation(N, a, b, scale).sep;
      const pruned = pairSeparation(N, a, b, scale);
      // the same double (=== lets only the sign of a zero differ, which nothing reads)
      if (pruned !== full) expect({ N, a, b, scale, pruned }).toEqual({ N, a, b, scale, pruned: full });
      pairs++;
    }
    expect(pairs).toBe(20_000);
  });

  it("finds the same overlapping pairs, with the same separations, as the full test", () => {
    for (let t = 0; t < 60; t++) {
      const N = [3, 4, 6, 11, 12, 13, 24, 60, 100][t % 9];
      const P = 1 + Math.floor(random() * 60);
      const spread = pick([0.3, 0.8, 1, 1.5, 3]);
      const side = spread * 2 * circumradius(N) * Math.sqrt(P);
      const pieces = Array.from({ length: P }, () => ({
        x: random() * side,
        y: random() * side,
        theta: (random() - 0.5) * 20,
      }));
      for (const [tol, scale, limit] of [
        [TOL, 1, Infinity],
        [TOL, 1, 20],
        [-Number.MIN_VALUE, 1 - 1e-8, Infinity],
      ] as const)
        expect(findOverlaps(N, pieces, tol, scale, limit)).toEqual(referenceOverlaps(N, pieces, tol, scale, limit));
    }
  });
});

/** Boards where shortcuts could slip: random, packed tight, on lattices and rings, aligned with the container. */
function boards(count = 60): PackingConfig[] {
  const out: PackingConfig[] = [];
  // the kinds, N and M come round in turn (their lengths 5, 12 and 10 are not multiples of each other), so that
  // every kind meets many of the side counts
  const Ns = [3, 4, 5, 6, 8, 12, 21, 24, 36, 60, 90, 100];
  const Ms = [3, 4, 5, 6, 7, 12, 21, 24, 50, 100];
  const kinds = ["random", "compact", "lattice", "ring", "row"] as const;
  for (let t = 0; t < count; t++) {
    const N = Ns[t % Ns.length];
    const M = Ms[(t + (t >> 3)) % Ms.length];
    const P = 1 + Math.floor(random() * 50);
    const R = circumradius(N);
    const kind = kinds[t % kinds.length];
    let pieces: Pose[] = [];
    if (kind === "random") {
      const side = pick([1, 2, 4]) * 2 * R * Math.sqrt(P);
      pieces = Array.from({ length: P }, () => ({ x: random() * side, y: random() * side, theta: random() * 7 }));
    } else if (kind === "compact") {
      for (let i = 0; i < P; i++) pieces.push(findFreeSpot(N, pieces, 0, 0));
    } else if (kind === "lattice") {
      // in face contact, edges along the axes: the supports tie
      const d = 2 * inradius(N) * (1 + pick([0, 1e-10, 1e-6]));
      const theta = pick([0, -Math.PI / 2 - Math.PI / N, Math.PI / N]);
      for (let i = 0; pieces.length < P; i++)
        for (let j = 0; j <= i && pieces.length < P; j++)
          pieces.push({ x: d * (j + (i - j) / 2), y: d * (i - j) * 0.866, theta });
    } else if (kind === "ring") {
      const rho = (P * 2 * R * pick([1, 2, 4])) / (2 * Math.PI);
      pieces = Array.from({ length: P }, (_, i) => ({
        x: rho * Math.cos((2 * Math.PI * i) / P),
        y: rho * Math.sin((2 * Math.PI * i) / P),
        theta: (i * 0.618) % 7,
      }));
    } else {
      pieces = Array.from({ length: P }, (_, i) => ({ x: i * 2 * R, y: 0, theta: 0 }));
    }
    const offset = pick([0, 0, 1e3, -7e5]);
    pieces = pieces.map((p) => ({ ...p, x: p.x + offset, y: p.y - offset }));
    const phi = pick([0, 0, Math.PI / M, (2 * Math.PI) / M, random() * 7, -random() * 3]);
    out.push({ N, M, P: P + pick([0, 0, 0, 1]), pieces, container_phi: phi });
  }
  return out;
}

const { records } = JSON.parse(readFileSync(new URL("../../../data/records.json", import.meta.url), "utf8")) as {
  records: LiteratureRecord[];
};
// every (N, M) of the published packings with its smallest and its largest P and a tenth of the rest
const withPieces = records.filter((r) => r.pieces);
const sampledPublished = withPieces.filter((r, i) => {
  const same = withPieces.filter((q) => q.N === r.N && q.M === r.M);
  return i % 10 === 0 || r.P === Math.min(...same.map((q) => q.P)) || r.P === Math.max(...same.map((q) => q.P));
});
const published = sampledPublished
  .map((r) => ({ N: r.N, M: r.M, P: r.P, pieces: r.pieces!, container_phi: r.container_phi ?? 0 }));

function corpus(dir: string): PackingConfig[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? corpus(resolve(dir, e.name))
      : e.name.endsWith(".json")
        ? [JSON.parse(readFileSync(resolve(dir, e.name), "utf8")).config]
        : [],
  );
}
const saved = corpus(resolve(import.meta.dirname, "../../../data/corpus"));

describe("the container at one orientation", () => {
  it("is the hull's container, to the bit, on fuzzed boards and on a sample of the published packings", () => {
    // each also turned to its best orientation, where supports often nearly tie, and to others
    const cases = [...boards(), ...published, ...saved].flatMap((c) => {
      if (!c.pieces.length || c.M === 0) return [c];
      const best = autoOrientSet(extremePoints(c.N, c.pieces), c.M, c.container_phi).phi;
      return [c, { ...c, container_phi: best }, { ...c, container_phi: random() * 7 }];
    });
    expect(cases.length).toBeGreaterThan(400);
    for (const c of cases)
      expect(enclose(c.N, c.pieces, c.M, c.container_phi)).toEqual(
        encloseSet(extremePoints(c.N, c.pieces), c.M, c.container_phi),
      );
  });
});

describe("evaluate", () => {
  it("gives what it gave before, to the bit: validity, reasons, overlaps and score", () => {
    const fuzzed = [...boards(), ...saved];
    // the orientation search is the same code either way; it runs on the fuzzed boards only
    const cases = [...fuzzed, ...published].map((c, i) => ({ c, search: i < fuzzed.length }));
    for (const { c, search } of cases)
      for (const opts of [{}, { maxOverlaps: 20 }, ...(search ? [{ autoOrient: true, maxOverlaps: 20 }] : [])]) {
        const now = evaluate(c, opts);
        const before = referenceEvaluate(c, opts);
        expect(now).toEqual(before);
        expect(evaluate(c, { ...opts, stopWhenInvalid: true }).reasons).toEqual(before.reasons);
      }
  });
});
