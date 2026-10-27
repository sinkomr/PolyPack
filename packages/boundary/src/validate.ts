/**
 * Float validator of the boundary space (tolerance tol, default 1e-9).
 *
 * A configuration is valid ("fold" placement, research note sec. 2.2) when:
 * (1) every centre lies in its closed anchor cell (within tol);
 * (2) no point of the hinges (the polytope's edges, vertices included) lies in the interior of a
 *     developed piece (by more than tol);
 * (3) the development is injective on each piece's interior, and (4) the interiors of distinct
 *     pieces are disjoint. With (2), (3) and (4) together say: in every cell, all parts (two parts
 *     of one piece included) have disjoint interiors (overlap depth <= tol allowed).
 *
 * Units (units.ts): balls have diameter 1, radius 1/2. The ball code is written for radius 1 and runs on lengths x2;
 * the text below states the rule in that working unit (clearance >= 1, centre distances >= 2), which in site units
 * is clearance >= 1/2 and distances >= 1, and the reasons quote site lengths. The tolerance is a site length.
 *
 * Balls use the equivalent distance form (the surface track's argument one dimension up; shortest
 * paths avoid the hinges [EST: Miller, Pak 2008, Prop. 1.2]): every centre at geodesic distance
 * >= 1 - tol from the hinges, centre distances >= 2 - tol, geodesic loops at each centre >= 2 - tol.
 * Distances and loops count a developed image of a centre only when it lies in the chain's closed
 * window, exactly (no tolerance). A window's faces are planes through the centre x and an edge of
 * a gate, which lies on a hinge or on an earlier window face, with one exception: the half-space
 * window of a centre lying on a ridge (chains.ts, "Centres near ridges") is bounded by the ridge's
 * own plane. So an image on a window boundary is either a path through a hinge, of length
 * >= d(x, hinge) + d(hinge, y) >= 2 - 2 tol by the clearance check, or a path inside a ridge from a
 * centre on that ridge to a centre on it. Rounding could hide the second kind (on the tesseract it
 * does not: its gluings are exact signed permutations), so a ball whose centre lies on a facet of
 * its anchor cell is also entered, mapped across, in the neighbouring cell: a ball of that cell
 * sees it from its own anchor, with no window at all.
 *
 * Vertices. The research note's vertex rule (sec. 2.2) is argued, not proved: a piece touching a
 * polytope vertex might need a condition on its tangent cone there. This validator enforces only
 * the following at vertices: a vertex is a point of the hinges, so (2) rejects a vertex inside a
 * piece (by more than tol), exactly as for any other edge point; a vertex on a piece's boundary is
 * allowed with no further condition; and parts are developed along rays that avoid the vertices
 * (rays through a vertex lie on window boundaries, which the closed windows cover), so overlaps
 * next to a vertex are caught only through the parts test of (3)-(4).
 *
 * Work is bounded: chains per piece are capped (opts.maxChains, default 4096), and a configuration
 * that reaches the cap is rejected with a plain reason. Cheap checks run first, so a container far
 * too small for its pieces fails before any chain is enumerated: the volume bound (P vol(piece)
 * <= vol(boundary)), then each piece against its anchor cell's own edges. The pair stages bin
 * centres (balls) or parts' bounding boxes (cubes) in a uniform grid of side 2 per cell, so their
 * work is linear in P, and they stop once opts.maxReasons reasons are collected.
 *
 * Ridge snap. Each piece is developed from its centre snapped onto the facet planes of its anchor
 * within ridgeSnap(s, tol) = min(1e-14 max(1, s), tol / 10) (chains.ts), which moves it by some
 * mu <= sqrt 3 tol / 10. Moving a piece by mu changes each distance or overlap depth it takes part
 * in by at most mu (a loop at its centre, or its overlap with itself, by 2 mu), so every check
 * compares against tol charged with the displacements: clearance >= 1 - tol + mu_i, centre
 * distances >= 2 - tol + mu_i + mu_j, loops >= 2 - tol + 2 mu_i, hinge depth <= tol - mu_i,
 * part overlaps <= tol - mu_A - mu_B. So a configuration whose unsnapped pieces violate a check by
 * more than tol is always rejected, and one with exact contacts is still accepted (the charged
 * tolerance stays >= 0.65 tol > 0). The in-cell edge tests use the unsnapped centres directly.
 * The charged tolerance never goes below 0, the value at tol 0 (allowed() below). For tol > 0 the
 * cap keeps the charges below 0.35 tol, so they apply in full; only when the snap is the rounding
 * floor (tol 0, or tol below a few rounding units of s) does it go partly uncharged, by at most
 * sqrt 3 rounding units of s, which those tolerances cannot resolve anyway. (Charging it in full
 * made exact contacts fail at tol 0 for centres a rounding unit inside their facet.)
 *
 * Untrusted input: numbers are read by index (holes in sparse arrays read as undefined and are
 * rejected) and every rejecting comparison is written so that NaN rejects.
 */
import { ChainLimitError, ChainNode, RIDGE_SNAP, clipSegmentToWindow, hingeDistanceOverChains, inWindow, ridgeSnap } from "./chains";
import { MAX_P, isPieceName } from "./ids";
import { V3, isoApply, isoInverse, isoLinearT, norm3, pointSegmentDistance3, quaternionToMatrix, sub3 } from "./linalg";
import { Development, PART_EPS, developPiece, partsOfDevelopment, pieceReach } from "./parts";
import { SatShape, polyhedronThickness, satDepth, satShape } from "./polyhedron";
import { boundaryVolume, cellExcess, getPolytope, isPolytopeName, topo } from "./polytope";
import { BALL_RADIUS, BALL_WORK } from "./units";
import type { BoundaryPiece, BoundaryProblem, BoundaryVerdict, PieceName, Polytope } from "./types";

export interface ValidateOptions {
  /** Float tolerance (default 1e-9). */
  tol?: number;
  /** Most chains of cells per piece before the configuration is rejected (default 4096). */
  maxChains?: number;
  /** Stop collecting reasons after this many (default 20). */
  maxReasons?: number;
}

/**
 * Largest accepted edge s. Every meaningful score is far below it: P <= 9999 unit balls already
 * fit at s = 22 (k^3 per cell at s = 2 k, k = 11) and the catalogue's P <= 64 below s = 4, cubes
 * lower still; but a straight row of P unit cubes along one cell, a valid if useless layout, needs
 * s of about P, so 1e4 keeps every such layout of the engine's MAX_P = 9999 pieces checkable. It
 * also keeps the float rule meaningful: local coordinates stay below 1e4, where one rounding unit
 * is 1.8e-12, so tol = 1e-9 is still about 500 units and the ridge snap (chains.ts, 1e-14 s) moves
 * a centre by less than 2e-10.
 */
export const MAX_S = 1e4;

const fmt = (x: number) => (Number.isFinite(x) ? String(Number(x.toPrecision(10))) : String(x));

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** The first n entries of x, read by index, when x is an array of exactly n finite numbers (holes rejected). */
function finiteNumbers(x: unknown, n: number): number[] | null {
  if (!Array.isArray(x) || x.length !== n) return null;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const v: unknown = x[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

/**
 * Checks the problem and the configuration's shape; returns the typed pieces or pushes reasons.
 * `given`: a polytope to use instead of the catalogue's (its name is then not checked).
 */
function checkShape(problem: BoundaryProblem, config: unknown, tol: number, reasons: string[], maxReasons: number, given?: Polytope): { poly: Polytope; s: number; pieces: BoundaryPiece[] } | null {
  const push = (r: string) => {
    if (reasons.length < maxReasons) reasons.push(r);
  };
  if (!isObject(problem)) {
    push("The problem must be an object with polytope, piece and P.");
    return null;
  }
  if (!given && !isPolytopeName(problem.polytope)) push(`Unknown polytope "${String(problem.polytope)}".`);
  if (!isPieceName(problem.piece)) push(`Unknown piece "${String(problem.piece)}".`);
  if (!(typeof problem.P === "number" && Number.isInteger(problem.P) && problem.P >= 1 && problem.P <= MAX_P)) push(`The problem's P must be a whole number from 1 to ${MAX_P}.`);
  if (reasons.length) return null;
  const poly = given ?? getPolytope(problem.polytope);
  const dim = poly.d - 1;
  if (!isObject(config)) {
    push("The configuration must be an object with s and pieces.");
    return null;
  }
  const s = config.s;
  if (typeof s !== "number" || !Number.isFinite(s)) push("The edge s must be a finite number.");
  else if (!(s > 0 && s <= MAX_S)) push(`The edge s must be greater than 0 and at most ${MAX_S}; it is ${fmt(s)}.`);
  const list = config.pieces;
  if (!Array.isArray(list)) {
    push("The configuration needs a list of pieces.");
    return null;
  }
  if (list.length !== problem.P) push(`The configuration has ${list.length} pieces; the problem needs exactly ${problem.P}.`);
  if (reasons.length) return null;
  const C = poly.cells.length;
  const pieces: BoundaryPiece[] = [];
  // by index, so that holes in a sparse list are seen (forEach would skip them)
  for (let i = 0; i < list.length; i++) {
    const raw: unknown = list[i];
    if (!isObject(raw)) {
      push(`Piece ${i} must be an object with cell and u.`);
      continue;
    }
    const cell = raw.cell;
    const q = raw.q;
    let ok = true;
    if (!(typeof cell === "number" && Number.isInteger(cell) && cell >= 0 && cell < C)) {
      push(`Piece ${i}: its cell must be a whole number from 0 to ${C - 1}.`);
      ok = false;
    }
    const u = finiteNumbers(raw.u, dim);
    if (!u) {
      push(`Piece ${i}: its centre u must be ${dim} finite numbers.`);
      ok = false;
    }
    let qv: number[] | null = null;
    if (problem.piece === "ball") {
      if (q !== undefined) {
        push(`Piece ${i} is a ball and must not have a rotation q.`);
        ok = false;
      }
    } else if (q !== undefined) {
      qv = finiteNumbers(q, 4);
      if (!qv) {
        push(`Piece ${i}: its rotation q must be 4 finite numbers (a unit quaternion w, x, y, z).`);
        ok = false;
      } else {
        const n = Math.hypot(qv[0], qv[1], qv[2], qv[3]);
        if (!(Math.abs(n - 1) <= 1e-9)) {
          push(`Piece ${i}: its rotation q must be a unit quaternion; its length is ${fmt(n)}.`);
          ok = false;
        }
      }
    }
    if (!ok || !u) continue;
    const piece: BoundaryPiece = { cell: cell as number, u };
    if (qv) piece.q = qv as BoundaryPiece["q"];
    const ex = cellExcess(poly, piece.cell, piece.u, s as number);
    if (!(ex <= tol)) push(`Piece ${i}: its centre lies outside its anchor cell ${piece.cell} by ${fmt(ex)}.`);
    pieces.push(piece);
  }
  if (reasons.length) return null;
  if (pieces.length !== problem.P) return null;
  return { poly, s: s as number, pieces };
}

/** Distance from u to the anchor cell's own hinges (straight segments inside the cell). */
function inCellHingeDistance(poly: Polytope, cell: number, u: V3, s: number): number {
  const ct = topo(poly).cells[cell];
  let best = Infinity;
  for (const [i, j] of poly.cells[cell].hinges) {
    const a = ct.verts[i];
    const b = ct.verts[j];
    best = Math.min(best, pointSegmentDistance3(u, [a[0] * s, a[1] * s, a[2] * s], [b[0] * s, b[1] * s, b[2] * s]));
  }
  return best;
}

/**
 * Depth of the segment a + t (b - a), t in [t0, t1], inside the unit cube with pose (R, u):
 * max over t of 1/2 - max_k |(R^T (x(t) - u))_k|. The function is concave piecewise linear in t,
 * so its maximum is at an end or where two of the |.| terms cross or one vanishes.
 */
function segmentDepthInCube(R: number[], u: V3, a: V3, b: V3, t0: number, t1: number): number {
  const T = { m: R, t: [0, 0, 0] as V3 };
  const A = isoLinearT(T, sub3(a, u));
  const B = isoLinearT(T, sub3(b, a));
  const g = (t: number) => Math.max(Math.abs(A[0] + t * B[0]), Math.abs(A[1] + t * B[1]), Math.abs(A[2] + t * B[2]));
  const cand = [t0, t1];
  for (let k = 0; k < 3; k++) {
    if (B[k] !== 0) cand.push(-A[k] / B[k]);
    for (let l = k + 1; l < 3; l++) {
      if (B[k] !== B[l]) cand.push((A[l] - A[k]) / (B[k] - B[l]));
      if (B[k] !== -B[l]) cand.push(-(A[l] + A[k]) / (B[k] + B[l]));
    }
  }
  let best = Infinity;
  for (const t of cand) if (t >= t0 && t <= t1) best = Math.min(best, g(t));
  return 0.5 - best;
}

/** Largest depth of a hinge point inside a cube, over the chains given (hinges clipped to each window). */
function hingeDepthInCube(poly: Polytope, s: number, nodes: readonly ChainNode[], R: number[], u: V3): number {
  const T = topo(poly);
  let worst = -Infinity;
  for (const node of nodes) {
    const V = T.cells[node.cell].verts.map((p) => isoApply(node.toAnchor, [p[0] * s, p[1] * s, p[2] * s]));
    for (const [i, j] of poly.cells[node.cell].hinges) {
      const iv = clipSegmentToWindow(node.window, u, V[i], V[j]);
      if (!iv) continue;
      worst = Math.max(worst, segmentDepthInCube(R, u, V[i], V[j], iv[0], iv[1]));
    }
  }
  return worst;
}

/**
 * The tolerance left after charging a snap displacement m: tol - m, but never below 0, the value
 * at tol 0 (header: for tol > 0 the cap keeps m < tol, so only the rounding-unit snaps of tol 0
 * go uncharged).
 */
function allowed(tol: number, m: number): number {
  return Math.max(tol - m, 0);
}

function develop(poly: Polytope, piece: PieceName, p: BoundaryPiece, s: number, reach: number, maxChains: number, snap: number, i: number, reasons: string[]): Development | null {
  try {
    return developPiece(poly, piece, p, s, reach, { maxChains, snap });
  } catch (e) {
    if (e instanceof ChainLimitError) {
      reasons.push(`Piece ${i} reaches more than ${maxChains} chains of cells; the ${poly.name} is far too small for its pieces.`);
      return null;
    }
    throw e;
  }
}

/**
 * The ball rule in site units (balls of diameter 1): the working code below is written for balls of radius 1, so the
 * lengths, the tolerance and the snaps are converted by BALL_WORK = 2 on entry (exact), and the reasons quote site
 * lengths (units.ts).
 */
function validateBallsSite(poly: Polytope, s: number, pieces: BoundaryPiece[], tol: number, maxChains: number, maxReasons: number): string[] {
  const w = BALL_WORK;
  const scaled = pieces.map((p) => ({ cell: p.cell, u: p.u.map((x) => x * w) }));
  return validateBalls(poly, s * w, scaled, tol * w, maxChains, maxReasons, BALL_RADIUS);
}

/**
 * The ball rule for balls of radius 1: `unit` is the site length of one working unit (1 / BALL_WORK), by which the
 * lengths quoted in the reasons are multiplied.
 */
function validateBalls(poly: Polytope, s: number, pieces: BoundaryPiece[], tol: number, maxChains: number, maxReasons: number, unit: number): string[] {
  const q = (x: number) => fmt(x * unit);
  const reasons: string[] = [];
  const push = (r: string) => {
    if (reasons.length < maxReasons) reasons.push(r);
  };
  const name = poly.name;
  // in-cell clearance first: a straight segment inside the anchor cell is a path
  const devs: Development[] = [];
  pieces.forEach((p, i) => {
    const d = inCellHingeDistance(poly, p.cell, [p.u[0], p.u[1], p.u[2]], s);
    if (!(d >= 1 - tol)) push(`Ball ${i} is ${q(d)} from an edge of the ${name}; it must be at least ${q(1)}, or the edge passes through the ball.`);
  });
  if (reasons.length) return reasons;
  const snap = ridgeSnap(s, tol);
  for (let i = 0; i < pieces.length; i++) {
    const dev = develop(poly, "ball", pieces[i], s, 2, maxChains, snap, i, reasons);
    if (!dev) return reasons;
    devs.push(dev);
  }
  // clearance along the chains
  devs.forEach((dev, i) => {
    const d = hingeDistanceOverChains(poly, s, dev.nodes, dev.u);
    if (!(d >= 1 - allowed(tol, dev.snapped))) push(`Ball ${i} is ${q(d)} from an edge of the ${name} along the boundary; it must be at least ${q(1)}, or the edge passes through the ball.`);
  });
  // Centres by cell, in a grid of side 2 (the interaction distance), for the pair checks. A centre
  // on a facet of its anchor (snapped there, chains.ts) is also entered in the neighbour across
  // that facet, mapped into the neighbour's frame (see the header: paths inside a ridge).
  // copies are true path lengths (the unfolding across the ridge), so this threshold is not a tolerance
  const onFacet = RIDGE_SNAP * Math.max(1, s);
  interface Entry {
    j: number;
    y: V3;
    own: boolean;
  }
  const grids = poly.cells.map(() => new Map<string, Entry[]>());
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const enter = (cell: number, e: Entry) => {
    const g = grids[cell];
    const k = key(Math.floor(e.y[0] / 2), Math.floor(e.y[1] / 2), Math.floor(e.y[2] / 2));
    const list = g.get(k);
    if (list) list.push(e);
    else g.set(k, [e]);
  };
  const T = topo(poly);
  devs.forEach((dev, j) => {
    const cell = pieces[j].cell;
    enter(cell, { j, y: dev.u, own: true });
    const ct = T.cells[cell];
    ct.planes.forEach((pl, f) => {
      if (!(Math.abs(pl.h * s - (pl.n[0] * dev.u[0] + pl.n[1] * dev.u[1] + pl.n[2] * dev.u[2])) <= onFacet)) return;
      const g = ct.glue[f];
      enter(poly.cells[cell].facets[f].neighbor, { j, y: isoApply({ m: g.m, t: [g.t[0] * s, g.t[1] * s, g.t[2] * s] }, dev.u), own: false });
    });
  });
  /** Entries of `cell` whose centres may lie within 2 of p (cell frame). */
  const near = (cell: number, p: V3): Entry[] => {
    const g = grids[cell];
    const out: Entry[] = [];
    const bx = Math.floor(p[0] / 2);
    const by = Math.floor(p[1] / 2);
    const bz = Math.floor(p[2] / 2);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) for (const e of g.get(key(bx + a, by + b, bz + c)) ?? []) out.push(e);
    return out;
  };
  // Stops once maxReasons reasons are collected: without overlaps every grid cell of side 2 holds
  // a bounded number of centres (they are 2 apart in their cell), so the work stays linear in P.
  devs.forEach((dev, i) => {
    if (reasons.length >= maxReasons) return;
    const u = dev.u;
    const pairMin = new Map<number, number>();
    let loop = Infinity;
    // thresholds charged with the snap displacements (header)
    const loopLimit = 2 - allowed(tol, 2 * dev.snapped);
    dev.nodes.forEach((node, ni) => {
      if (pairMin.size >= maxReasons) return;
      const back = isoInverse(node.toAnchor);
      const uLoc = isoApply(back, u);
      for (const { j, y, own } of near(node.cell, uLoc)) {
        if (j < i) continue;
        const limit = 2 - allowed(tol, dev.snapped + devs[j].snapped);
        // cheap test in the cell's frame first (the development is an isometry)
        if (norm3(sub3(y, uLoc)) >= limit) continue;
        if (j === i) {
          // loops: the ball's own entry only (a copy across its ridge is the centre itself)
          if (ni === 0 || !own) continue;
          const img = isoApply(node.toAnchor, y);
          if (!inWindow(node, u, img)) continue;
          loop = Math.min(loop, norm3(sub3(img, u)));
          continue;
        }
        const img = isoApply(node.toAnchor, y);
        if (!inWindow(node, u, img)) continue;
        const d = norm3(sub3(img, u));
        pairMin.set(j, Math.min(pairMin.get(j) ?? Infinity, d));
      }
    });
    for (const [j, d] of [...pairMin].sort((a, b) => a[0] - b[0]))
      push(`Balls ${i} and ${j} overlap: their centres are ${q(d)} apart along the boundary; they must be at least ${q(2)} apart.`);
    if (!(loop >= loopLimit)) push(`Ball ${i} overlaps itself: a geodesic loop of length ${q(loop)} leaves and returns to its centre; it must be at least ${q(2)}.`);
  });
  return reasons;
}

function validateCubes(poly: Polytope, s: number, pieces: BoundaryPiece[], tol: number, maxChains: number, maxReasons: number): string[] {
  const reasons: string[] = [];
  const push = (r: string) => {
    if (reasons.length < maxReasons) reasons.push(r);
  };
  const name = poly.name;
  const rot = pieces.map((p) => (p.q ? quaternionToMatrix(p.q) : [1, 0, 0, 0, 1, 0, 0, 0, 1]));
  // in-cell hinge test first: the anchor's own edges against the cube
  pieces.forEach((p, i) => {
    const root: ChainNode = { cell: p.cell, toAnchor: { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, window: [], gate: [], gateDist: 0, entry: -1, parent: -1, depth: 0, cells: [p.cell], runEdge: -1, runAngle: 0 };
    const depth = hingeDepthInCube(poly, s, [root], rot[i], [p.u[0], p.u[1], p.u[2]]);
    if (!(depth <= tol)) push(`Cube ${i} has an edge of the ${name} passing through its interior (depth ${fmt(depth)}).`);
  });
  if (reasons.length) return reasons;
  const shapes: { piece: number; cell: number; sat: SatShape; mu: number }[][] = poly.cells.map(() => []);
  const snap = ridgeSnap(s, tol);
  for (let i = 0; i < pieces.length; i++) {
    if (reasons.length >= maxReasons) return reasons;
    const dev = develop(poly, "cube", pieces[i], s, pieceReach("cube"), maxChains, snap, i, reasons);
    if (!dev) return reasons;
    const depth = hingeDepthInCube(poly, s, dev.nodes, rot[i], dev.u);
    if (!(depth <= allowed(tol, dev.snapped))) push(`Cube ${i} has an edge of the ${name} passing through its interior beyond its anchor cell (depth ${fmt(depth)}).`);
    for (const x of partsOfDevelopment(poly, "cube", i, dev, s)) {
      const P = x.poly!;
      if (polyhedronThickness(P) <= PART_EPS) continue;
      shapes[x.part.cell].push({ piece: i, cell: x.part.cell, sat: satShape(P), mu: dev.snapped });
    }
  }
  if (reasons.length) return reasons;
  // Pairs: a uniform grid of side G = 2 per cell, keyed by the low corner of each part's bounding
  // box. A part's extent is at most the cube's diameter sqrt 3 < G, so two parts whose boxes
  // overlap have low corners within G of each other on every axis: neighbouring grid cells only.
  const G = 2;
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  shapes.forEach((list, cell) => {
    if (reasons.length >= maxReasons) return;
    const grid = new Map<string, number[]>();
    const at = list.map((A) => [Math.floor(A.sat.lo[0] / G), Math.floor(A.sat.lo[1] / G), Math.floor(A.sat.lo[2] / G)]);
    list.forEach((_, a) => {
      const k = key(at[a][0], at[a][1], at[a][2]);
      const l = grid.get(k);
      if (l) l.push(a);
      else grid.set(k, [a]);
    });
    for (let a = 0; a < list.length; a++) {
      if (reasons.length >= maxReasons) return;
      const A = list[a];
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++)
            for (const b of grid.get(key(at[a][0] + dx, at[a][1] + dy, at[a][2] + dz)) ?? []) {
              if (b <= a) continue;
              const B = list[b];
              // the tolerance charged with both pieces' snap displacements (header)
              const thr = allowed(tol, A.mu + B.mu);
              // bounding boxes overlapping by more than thr on every axis
              if (!(Math.min(A.sat.hi[0], B.sat.hi[0]) - Math.max(A.sat.lo[0], B.sat.lo[0]) > thr)) continue;
              if (!(Math.min(A.sat.hi[1], B.sat.hi[1]) - Math.max(A.sat.lo[1], B.sat.lo[1]) > thr)) continue;
              if (!(Math.min(A.sat.hi[2], B.sat.hi[2]) - Math.max(A.sat.lo[2], B.sat.lo[2]) > thr)) continue;
              // stops early once an axis shows an overlap <= thr; otherwise it is the full penetration depth
              const depth = satDepth(A.sat, B.sat, thr);
              if (depth <= thr) continue;
              if (A.piece === B.piece) push(`Cube ${A.piece} overlaps itself in cell ${cell} (depth ${fmt(depth)}).`);
              else {
                const [i, j] = A.piece < B.piece ? [A.piece, B.piece] : [B.piece, A.piece];
                push(`Cubes ${i} and ${j} overlap in cell ${cell} (depth ${fmt(depth)}).`);
              }
            }
    }
  });
  return reasons;
}

/**
 * Validates a configuration (untrusted input) for a problem. Returns ok with the score s, or the
 * reasons it is invalid as plain sentences. Throws a RangeError on a bad tol (a caller's mistake).
 */
export function validateBoundary(problem: BoundaryProblem, config: unknown, opts: ValidateOptions = {}): BoundaryVerdict {
  return run(problem, config, opts);
}

/**
 * The same rule on any polytope built with buildPolytope (for polytopes not yet in the catalogue,
 * and for tests): P pieces of one kind, configuration as for validateBoundary.
 */
export function validateOn(poly: Polytope, piece: PieceName, P: number, config: unknown, opts: ValidateOptions = {}): BoundaryVerdict {
  return run({ polytope: poly.name, piece, P }, config, opts, poly);
}

function run(problem: BoundaryProblem, config: unknown, opts: ValidateOptions, given?: Polytope): BoundaryVerdict {
  const tol = opts.tol ?? 1e-9;
  // a caller's mistake, not the submitter's: no tolerance may make everything pass
  if (!(typeof tol === "number" && Number.isFinite(tol) && tol >= 0)) throw new RangeError(`validateBoundary: tol must be a finite number >= 0, not ${String(tol)}`);
  // at least one reason and one chain, so that the early stops can never accept anything
  const mr = opts.maxReasons ?? 20;
  const maxReasons = mr >= 1 ? Math.floor(mr) : 1;
  const mc = opts.maxChains ?? 4096;
  const maxChains = mc >= 1 ? Math.floor(mc) : 1;
  const reasons: string[] = [];
  const shape = checkShape(problem, config, tol, reasons, maxReasons, given);
  if (!shape) return { ok: false, score: null, reasons: reasons.length ? reasons : ["The configuration is malformed."] };
  const { poly, s, pieces } = shape;
  // Volume bound [CALC]: developments are injective on interiors and interiors are disjoint, so
  // the pieces' volumes add up to at most the boundary's (the relative margin 1e-6 absorbs
  // overlaps within tol). Cheap, and it keeps huge P at small s away from the chain stage.
  const pieceVolume = problem.piece === "ball" ? (4 * Math.PI * BALL_RADIUS ** 3) / 3 : 1;
  const volume = boundaryVolume(poly) * s ** 3;
  if (!(pieces.length * pieceVolume <= volume * (1 + 1e-6)))
    return {
      ok: false,
      score: null,
      reasons: [`${pieces.length} ${problem.piece}s have a total volume of ${fmt(pieces.length * pieceVolume)}, more than the ${fmt(volume)} of the ${poly.name}'s boundary at s = ${fmt(s)}.`],
    };
  const geo = problem.piece === "ball" ? validateBallsSite(poly, s, pieces, tol, maxChains, maxReasons) : validateCubes(poly, s, pieces, tol, maxChains, maxReasons);
  return geo.length ? { ok: false, score: null, reasons: geo } : { ok: true, score: s, reasons: [] };
}
