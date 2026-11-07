import {
  evaluate as geometryEvaluate,
  areaLowerBound,
  DISK_RADIUS,
  parseConfig,
  circumradius,
  inradius,
  pairSeparation,
  pieceSeparation,
  pieceVertices,
  separationBelow,
  type PackingConfig,
  type Evaluation,
  type Pose,
  type Container,
} from "@polypack/geometry";

import { createCheckpoint } from "./runtime";

export interface PolishOptions {
  /** Return false to stop at an outer numerical phase. */
  checkpoint?: () => Promise<boolean>;
  /** Framework hook counts shared-geometry evaluations against the run budget. */
  evaluate?: (config: PackingConfig, options?: { autoOrient?: boolean }) => Promise<Evaluation | undefined>;
  /** Reuse an assessment of this exact input supplied by the framework. */
  initialEvaluation?: Evaluation;
  /** Synchronous cancellation/deadline test for numerical inner loops. */
  shouldStop?: () => boolean;
  maxIterations?: number;
  /** @deprecated Use maxIterations. Retained for existing callers. */
  iterations?: number;
  contactTolerance?: number;
}

/** Positive residuals mean separation/containment; vertex is omitted for circle pieces. */
export type ContactConstraint =
  | { kind: "pair"; i: number; j: number }
  | { kind: "wall"; i: number; edge: number; vertex?: number }
  | { kind: "radial"; i: number; vertex?: number };

export function contactResiduals(
  config: PackingConfig,
  container: Container,
  contacts: readonly ContactConstraint[],
): number[] {
  return contacts.map((contact) =>
    contactResidual(
      config.N,
      config.pieces[contact.i],
      contact.kind === "pair" ? config.pieces[contact.j] : undefined,
      container,
      contact,
    ),
  );
}

/** One contact's residual from the poses it involves (b only for a pair). */
function contactResidual(
  N: number,
  pose: Pose,
  b: Pose | undefined,
  container: Container,
  contact: ContactConstraint,
): number {
  if (contact.kind === "pair") return pieceSeparation(N, pose, b!).sep;
  let x = pose.x,
    y = pose.y;
  const pad = N === 0 ? DISK_RADIUS : 0;
  if (contact.vertex !== undefined) {
    const v = pieceVertices(N, pose);
    x = v[2 * contact.vertex];
    y = v[2 * contact.vertex + 1];
  }
  if (contact.kind === "radial") return container.size / 2 - Math.hypot(x - container.cx, y - container.cy) - pad;
  const angle = container.phi - Math.PI / 2 + (2 * Math.PI * contact.edge) / container.M;
  return (
    container.size / (2 * Math.tan(Math.PI / container.M)) -
    (x - container.cx) * Math.cos(angle) -
    (y - container.cy) * Math.sin(angle) -
    pad
  );
}

/**
 * Lower bound on the separation of two congruent pieces whose centres are `distance` apart:
 * along the edge normal of A nearest the line of centres (within pi/N of it) A reaches its
 * inradius r and B at most its circumradius R, so the SAT gap is at least distance cos(pi/N) - r - R.
 * For disks the separation is exactly distance - 1.
 */
function separationFloor(N: number, distance: number): number {
  return N === 0 ? distance - 2 * DISK_RADIUS : distance * Math.cos(Math.PI / N) - inradius(N) - circumradius(N);
}

/**
 * The pair and wall constraints whose residual is within `tolerance`, piece by piece (pairs
 * (i, j > i), then i's vertices against each wall), or undefined once
 * `stopped` says so (tested once per piece). With `first`, stops at the first contact found.
 * A pair is skipped without the SAT kernel when separationFloor proves its separation above the
 * tolerance (with a margin far beyond the rounding of either), which changes no answer.
 */
function collectContacts(
  config: PackingConfig,
  c: Container,
  tolerance: number,
  stopped: () => boolean,
  first = false,
): ContactConstraint[] | undefined {
  const out: ContactConstraint[] = [];
  const N = config.N;
  const pieces = config.pieces;
  const normals = new Float64Array(2 * Math.max(c.M, 1));
  for (let edge = 0; edge < c.M; edge++) {
    const angle = c.phi - Math.PI / 2 + (2 * Math.PI * edge) / c.M;
    normals[2 * edge] = Math.cos(angle);
    normals[2 * edge + 1] = Math.sin(angle);
  }
  const apothem = c.M === 0 ? c.size / 2 : c.size / (2 * Math.tan(Math.PI / c.M));
  const R = N === 0 ? DISK_RADIUS : circumradius(N);
  const vertices = new Float64Array(2 * Math.max(N, 1));
  const pad = N === 0 ? DISK_RADIUS : 0;
  for (let i = 0; i < pieces.length; i++) {
    if (stopped()) return undefined;
    const pose = pieces[i];
    for (let j = i + 1; j < pieces.length; j++) {
      const q = pieces[j];
      const distance = Math.hypot(q.x - pose.x, q.y - pose.y);
      if (separationFloor(N, distance) > tolerance + 1e-9 * (distance + R)) continue;
      if (pairSeparation(N, pose, q) <= tolerance) {
        out.push({ kind: "pair", i, j });
        if (first) return out;
      }
    }
    if (N === 0) {
      vertices[0] = pose.x;
      vertices[1] = pose.y;
    } else pieceVertices(N, pose, 1, vertices);
    for (let vertex = 0; vertex < (N || 1); vertex++) {
      const dx = vertices[2 * vertex] - c.cx,
        dy = vertices[2 * vertex + 1] - c.cy;
      for (let edge = 0; edge < (c.M || 1); edge++) {
        const gap =
          c.M === 0
            ? c.size / 2 - Math.hypot(dx, dy) - pad
            : apothem - dx * normals[2 * edge] - dy * normals[2 * edge + 1] - pad;
        if (gap <= tolerance) {
          if (c.M === 0) out.push(N === 0 ? { kind: "radial", i } : { kind: "radial", i, vertex });
          else out.push(N === 0 ? { kind: "wall", i, edge } : { kind: "wall", i, edge, vertex });
          if (first) return out;
        }
      }
    }
  }
  return out;
}

/** Includes penetrations as well as near contacts, so the same system can repair a start. */
export function identifyContacts(config: PackingConfig, container?: Container, tolerance = 0.05): ContactConstraint[] {
  const c = container ?? geometryEvaluate(config, { autoOrient: true }).container;
  if (!c) return [];
  return collectContacts(config, c, tolerance, () => false)!;
}

/** Portable contact-system ordering: piece (x,y,theta) triples, then cx,cy,phi,size. */
export function packContactVariables(config: PackingConfig, container: Container): number[] {
  return [
    ...config.pieces.flatMap((p) => [p.x, p.y, p.theta]),
    container.cx,
    container.cy,
    container.phi,
    container.size,
  ];
}

export function unpackContactVariables(
  config: PackingConfig,
  variables: readonly number[],
): { config: PackingConfig; container: Container } {
  const offset = 3 * config.pieces.length;
  return {
    config: {
      ...config,
      pieces: config.pieces.map((_, i) => ({
        x: variables[3 * i],
        y: variables[3 * i + 1],
        theta: variables[3 * i + 2],
      })),
      container_phi: variables[offset + 2],
    },
    container: {
      M: config.M,
      cx: variables[offset],
      cy: variables[offset + 1],
      phi: variables[offset + 2],
      size: variables[offset + 3],
    },
  };
}

function dot(a: readonly number[], b: readonly number[]): number {
  let v = 0;
  for (let i = 0; i < a.length; i++) v += a[i] * b[i];
  return v;
}

/**
 * The contact Jacobian: dense rows, zero outside each contact's own variables, with those
 * variables listed per row in increasing order (`cols`). The row products below run over the
 * listed columns only. Every term they skip is a zero times a finite number, a zero, and adding a
 * zero leaves every sum here as it was (a sum that starts at +0 never becomes -0), so they give
 * the dense loops' doubles while the direction is finite. Once a direction entry is not finite
 * (0 * Infinity is NaN, which the sparse loop would miss) the dense loops take over for good.
 */
interface ContactRows {
  rows: number[][];
  cols: number[][];
}

class RowSolver {
  dense = false;
  constructor(
    readonly jacobian: ContactRows,
    readonly direction: number[],
  ) {}
  /** rows[k] . direction */
  product(k: number): number {
    const row = this.jacobian.rows[k];
    if (this.dense) return dot(row, this.direction);
    const cols = this.jacobian.cols[k];
    const direction = this.direction;
    let v = 0;
    for (let n = 0; n < cols.length; n++) v += row[cols[n]] * direction[cols[n]];
    return v;
  }
  /** direction += delta rows[k] */
  step(k: number, delta: number): void {
    const row = this.jacobian.rows[k];
    const direction = this.direction;
    if (this.dense || !Number.isFinite(delta)) {
      this.dense = true;
      for (let j = 0; j < direction.length; j++) direction[j] += delta * row[j];
      return;
    }
    const cols = this.jacobian.cols[k];
    for (let n = 0; n < cols.length; n++) {
      const c = cols[n];
      direction[c] += delta * row[c];
      if (!Number.isFinite(direction[c])) this.dense = true;
    }
  }
}

/** rows[k] . rows[k] for every row, over its listed columns (the rest are zeros). */
function rowNorms({ rows, cols }: ContactRows): number[] {
  return rows.map((row, k) => {
    let v = 0;
    for (const c of cols[k]) v += row[c] * row[c];
    return v;
  });
}

/**
 * Central derivatives on only the variables participating in each contact. Only the poses and
 * container that a contact reads are copied and perturbed, with the same values the packed
 * variable vector would give them.
 */
function contactJacobian(
  config: PackingConfig,
  container: Container,
  contacts: readonly ContactConstraint[],
  stopped: () => boolean,
): ContactRows | undefined {
  const width = 3 * config.P + 4;
  const offset = 3 * config.P;
  const rows: number[][] = [];
  const cols: number[][] = [];
  const h = 2e-6;
  const pose: Pose = { x: 0, y: 0, theta: 0 };
  const other: Pose = { x: 0, y: 0, theta: 0 };
  const box: Container = { ...container };
  const key = ["x", "y", "theta"] as const;
  const boxKey = ["cx", "cy", "phi", "size"] as const;
  for (const contact of contacts) {
    if (stopped()) return undefined;
    const row = Array<number>(width).fill(0);
    const written: number[] = [];
    const pair = contact.kind === "pair";
    const variables = pair
      ? [3 * contact.i, 3 * contact.i + 1, 3 * contact.i + 2, 3 * contact.j, 3 * contact.j + 1, 3 * contact.j + 2]
      : [3 * contact.i, 3 * contact.i + 1, 3 * contact.i + 2, offset, offset + 1, offset + 2, offset + 3];
    for (const variable of variables) {
      if (stopped()) return undefined;
      if (config.N === 0 && variable < offset && variable % 3 === 2) continue;
      if (config.M === 0 && variable === offset + 2) continue;
      // x - h is x + (-h) exactly, so both sides match the packed vector's x[v] + h and x[v] - h
      const residual = (delta: number): number => {
        const a = config.pieces[contact.i];
        pose.x = a.x;
        pose.y = a.y;
        pose.theta = a.theta;
        if (pair) {
          const b = config.pieces[contact.j];
          other.x = b.x;
          other.y = b.y;
          other.theta = b.theta;
        }
        box.cx = container.cx;
        box.cy = container.cy;
        box.phi = container.phi;
        box.size = container.size;
        if (variable >= offset) box[boxKey[variable - offset]] += delta;
        else (variable >= 3 * contact.i && variable < 3 * contact.i + 3 ? pose : other)[key[variable % 3]] += delta;
        return contactResidual(config.N, pose, pair ? other : undefined, box, contact);
      };
      row[variable] = (residual(h) - residual(-h)) / (2 * h);
      written.push(variable);
    }
    rows.push(row);
    cols.push(written);
  }
  return { rows, cols };
}

/**
 * Geometric restoration uses a much tighter margin than the server's touching tolerance.
 * Pairs whose centres are farther apart than twice the bounding radius (with a relative margin
 * of 1e-6) are disjoint by a clear positive gap, so the SAT kernel would neither move them nor
 * raise `worst`; they are skipped without it, which leaves every move as it was.
 */
function restoreSeparation(config: PackingConfig, stopped: () => boolean): boolean {
  const reach = 2 * (config.N === 0 ? DISK_RADIUS : circumradius(config.N));
  const far2 = reach * reach * (1 + 1e-6);
  const pieces = config.pieces;
  for (let sweep = 0; sweep < 48; sweep++) {
    let worst = 0;
    for (let i = 0; i < config.P; i++) {
      if (stopped()) return false;
      const a = pieces[i];
      for (let j = i + 1; j < config.P; j++) {
        const b = pieces[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if (dx * dx + dy * dy > far2) continue;
        const contact = pieceSeparation(config.N, a, b);
        worst = Math.max(worst, -contact.sep);
        if (contact.sep < (config.N === 0 ? 0 : -2e-14)) {
          const move = (-contact.sep + 2e-13) / 2;
          a.x += move * contact.nx;
          a.y += move * contact.ny;
          b.x -= move * contact.nx;
          b.y -= move * contact.ny;
        }
      }
    }
    if (config.N === 0 ? worst === 0 : worst < 2e-14) return true;
  }
  for (let i = 0; i < config.P; i++) {
    if (stopped()) return false;
    for (let j = i + 1; j < config.P; j++) {
      const dx = pieces[i].x - pieces[j].x;
      const dy = pieces[i].y - pieces[j].y;
      if (dx * dx + dy * dy > far2) continue;
      if (separationBelow(config.N, pieces[i], pieces[j], config.N === 0 ? 0 : -1e-12)) return false;
    }
  }
  return true;
}

/** Apply the polish tolerance to both the initial fallback and every scored container. */
function strictlyFeasible(config: PackingConfig, container: Container, stopped: () => boolean): boolean {
  const contacts = collectContacts(config, container, -1e-12, stopped, true);
  return contacts !== undefined && contacts.length === 0;
}

const IMPROVEMENT_FLOOR = 2e-13;

/** Solve the final contact equalities by rank-tolerant row projections (Newton's step). */
function contactNewton(
  jacobian: ContactRows,
  gaps: readonly number[],
  stopped: () => boolean,
): number[] | undefined {
  const rows = jacobian.rows;
  if (!rows.length) return [];
  const direction = Array<number>(rows[0].length).fill(0);
  const solver = new RowSolver(jacobian, direction);
  const norms = rowNorms(jacobian);
  for (let sweep = 0; sweep < 1000; sweep++) {
    let largest = 0;
    for (let k = 0; k < rows.length; k++) {
      if (stopped()) return undefined;
      if (norms[k] < 1e-20) continue;
      const residual = 2e-13 - gaps[k] - solver.product(k);
      largest = Math.max(largest, Math.abs(residual));
      const delta = residual / norms[k];
      solver.step(k, delta);
    }
    if (largest < 5e-14) break;
  }
  return direction;
}

/**
 * Float64 sequential quadratic programming. Each subproblem projects a shrinking-container
 * Newton target onto linearized contact inequalities. Nonnegative dual multipliers release
 * inactive contacts; shared geometry, rather than the local model, accepts the final poses.
 */
export async function polish(config: PackingConfig, options: PolishOptions = {}): Promise<PackingConfig | undefined> {
  const parsed = parseConfig(config);
  if (!parsed.ok || parsed.config.pieces.length !== parsed.config.P) return undefined;
  const requestedIterations = options.maxIterations ?? options.iterations ?? 300;
  const requestedTolerance = options.contactTolerance ?? 0.05;
  if (
    !Number.isFinite(requestedIterations) ||
    !Number.isFinite(requestedTolerance) ||
    requestedIterations < 0 ||
    requestedTolerance < 0
  ) {
    throw new RangeError("polish maxIterations and contactTolerance must be finite and nonnegative");
  }
  const iterations = Math.min(300, Math.floor(requestedIterations));
  const tolerance = Math.max(1e-7, Math.min(1, requestedTolerance));
  const stopped = options.shouldStop ?? (() => false);
  const checkpoint = options.checkpoint ?? createCheckpoint();
  const assess =
    options.evaluate ?? (async (c: PackingConfig, opts: { autoOrient?: boolean } = {}) => geometryEvaluate(c, opts));
  if (stopped() || !(await checkpoint())) return undefined;
  let current = parsed.config;
  let evaluation = options.initialEvaluation ?? (await assess(current, { autoOrient: true }));
  if (!evaluation?.container || evaluation.score === null) return undefined;
  const initialStrict = evaluation.valid && strictlyFeasible(current, evaluation.container, stopped);
  let best = initialStrict ? { ...current, container_phi: evaluation.container.phi } : undefined;
  let bestScore = evaluation.valid ? evaluation.score : Infinity;
  let bestEvaluation = initialStrict ? evaluation : undefined;
  // Bound dense Jacobian work; large problems retain their already validated fallback.
  if (current.P > 100) return best;
  const maxTrust = Math.min(
    0.5,
    Math.max(0.05, 0.1 * Math.max(0, evaluation.score - areaLowerBound(current.N, current.M, current.P))),
  );
  let trust = Math.min(0.05, maxTrust);
  let stalled = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    if (stopped() || !(await checkpoint())) break;
    const container = evaluation.container!;
    current = { ...current, container_phi: container.phi };
    const contacts = collectContacts(current, container, tolerance, stopped);
    if (!contacts || contacts.length > 2048 || contacts.length * Math.max(current.N, 1) > 50000) return best;
    const x = packContactVariables(current, container);
    const gaps = contactResiduals(current, container, contacts);
    const jacobian = contactJacobian(current, container, contacts, stopped);
    if (!jacobian) return best;
    const rows = jacobian.rows;
    const direction = Array<number>(x.length).fill(0);
    direction[x.length - 1] = -trust;
    const solver = new RowSolver(jacobian, direction);
    const multipliers = Array<number>(rows.length).fill(0);
    const norms = rowNorms(jacobian);
    // Hildreth coordinate descent solves the convex QP dual without singular KKT matrices.
    for (let sweep = 0; sweep < 300; sweep++) {
      if (stopped()) return best;
      let largest = 0;
      for (let k = 0; k < rows.length; k++) {
        if (stopped()) return best;
        if (norms[k] < 1e-20) continue;
        const next = Math.max(0, multipliers[k] + (-gaps[k] + 2e-13 - solver.product(k)) / norms[k]);
        const delta = next - multipliers[k];
        multipliers[k] = next;
        largest = Math.max(largest, Math.abs(delta));
        solver.step(k, delta);
      }
      if (largest < 1e-12) break;
    }
    const maxMove = Math.max(...direction.map(Math.abs));
    if (evaluation.valid && maxMove < 5e-14) break;
    const scale = maxMove > trust ? trust / maxMove : 1;
    let accepted = false;
    for (let line = 0; line < 16; line++) {
      if (stopped()) return best;
      const fraction = scale * 2 ** -line;
      const trial = unpackContactVariables(
        current,
        x.map((v, i) => v + fraction * direction[i]),
      ).config;
      // The local container is only a model; shared geometry recomputes containment.
      if (!restoreSeparation(trial, stopped)) {
        if (stopped()) return best;
        continue;
      }
      if (!parseConfig(trial).ok) continue;
      const result = await assess(trial, { autoOrient: false });
      if (!result) return best;
      const strict = result.valid && result.container && strictlyFeasible(trial, result.container, stopped);
      if (strict && result.score !== null && result.score < bestScore - IMPROVEMENT_FLOOR) {
        bestScore = result.score;
        best = trial;
        bestEvaluation = result;
      }
      const oldPenetration = evaluation.overlaps.reduce((s, c) => s - c.sep, 0);
      const newPenetration = result.overlaps.reduce((s, c) => s - c.sep, 0);
      if (
        result.container &&
        result.score !== null &&
        ((strict && (!evaluation.valid || result.score < evaluation.score! - IMPROVEMENT_FLOOR)) ||
          (!evaluation.valid && newPenetration < oldPenetration * 0.9))
      ) {
        current = trial;
        evaluation = result;
        accepted = true;
        break;
      }
    }
    if (accepted) {
      stalled = 0;
      trust = Math.min(maxTrust, trust * 1.3);
    } else {
      trust *= 0.4;
      stalled++;
    }
    if (stalled >= 5 || trust < 1e-12) break;
  }
  // Once the trust-region search has settled, snap its final active contacts with Newton.
  // A redundant contact graph is handled by row projections, rather than a singular inverse.
  if (iterations > 0)
    for (let refinement = 0; refinement < 8; refinement++) {
      if (!best) break;
      if (stopped() || !(await checkpoint())) return best;
      const base = bestEvaluation;
      if (!base?.container) return best;
      const contacts = collectContacts(best, base.container, 2e-7, stopped);
      if (!contacts || contacts.length > 2048 || contacts.length * Math.max(best.N, 1) > 50000) return best;
      const gaps = contactResiduals(best, base.container, contacts);
      const jacobian = contactJacobian(best, base.container, contacts, stopped);
      if (!jacobian) return best;
      const direction = contactNewton(jacobian, gaps, stopped);
      if (!direction) return best;
      if (!direction.length || Math.max(...direction.map(Math.abs)) < 5e-14) break;
      const variables = packContactVariables(best, base.container);
      let improved = false;
      for (let line = 0; line < 8; line++) {
        if (stopped()) return best;
        const trial: PackingConfig = unpackContactVariables(
          best,
          variables.map((v, i) => v + 2 ** -line * direction[i]),
        ).config;
        if (!restoreSeparation(trial, stopped) || !parseConfig(trial).ok) continue;
        const result = await assess(trial, { autoOrient: false });
        if (!result) return best;
        if (
          result.valid &&
          result.container &&
          result.score !== null &&
          result.score < bestScore - IMPROVEMENT_FLOOR &&
          strictlyFeasible(trial, result.container, stopped)
        ) {
          best = trial;
          bestScore = result.score;
          bestEvaluation = result;
          improved = true;
          break;
        }
      }
      if (!improved) break;
    }
  if (best && !stopped() && iterations > 0 && (await checkpoint())) {
    const final = await assess(best, { autoOrient: true });
    if (
      final?.valid &&
      final.container &&
      final.score !== null &&
      final.score <= bestScore &&
      strictlyFeasible(best, final.container, stopped)
    ) {
      best = { ...best, container_phi: final.container.phi };
    }
  }
  return best;
}
