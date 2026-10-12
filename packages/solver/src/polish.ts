import {
  evaluate as geometryEvaluate,
  areaLowerBound,
  parseConfig,
  pieceSeparation,
  pieceVertices,
  type PackingConfig,
  type Evaluation,
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
  const vertices = new Map<number, Float64Array>();
  return contacts.map((contact) => {
    if (contact.kind === "pair") {
      return pieceSeparation(config.N, config.pieces[contact.i], config.pieces[contact.j]).sep;
    }
    const pose = config.pieces[contact.i];
    let x = pose.x,
      y = pose.y;
    const pad = config.N === 0 ? 1 : 0;
    if (contact.vertex !== undefined) {
      let v = vertices.get(contact.i);
      if (!v) {
        v = pieceVertices(config.N, pose);
        vertices.set(contact.i, v);
      }
      x = v[2 * contact.vertex];
      y = v[2 * contact.vertex + 1];
    }
    if (contact.kind === "radial") return container.size - Math.hypot(x - container.cx, y - container.cy) - pad;
    const angle = container.phi - Math.PI / 2 + (2 * Math.PI * contact.edge) / container.M;
    return (
      container.size / (2 * Math.tan(Math.PI / container.M)) -
      (x - container.cx) * Math.cos(angle) -
      (y - container.cy) * Math.sin(angle) -
      pad
    );
  });
}

/** Yield even inactive candidates, allowing callers to checkpoint during sparse scans. */
function* contactCandidates(
  config: PackingConfig,
  c: Container,
  tolerance: number,
): Generator<ContactConstraint | undefined> {
  const normals = Array.from({ length: c.M }, (_, edge) => {
    const angle = c.phi - Math.PI / 2 + (2 * Math.PI * edge) / c.M;
    return [Math.cos(angle), Math.sin(angle)];
  });
  const apothem = c.M === 0 ? c.size : c.size / (2 * Math.tan(Math.PI / c.M));
  for (let i = 0; i < config.pieces.length; i++) {
    for (let j = i + 1; j < config.pieces.length; j++) {
      yield pieceSeparation(config.N, config.pieces[i], config.pieces[j]).sep <= tolerance
        ? { kind: "pair", i, j }
        : undefined;
    }
    const pose = config.pieces[i];
    const vertices = config.N === 0 ? new Float64Array([pose.x, pose.y]) : pieceVertices(config.N, pose);
    const pad = config.N === 0 ? 1 : 0;
    for (let vertex = 0; vertex < (config.N || 1); vertex++) {
      const point = config.N === 0 ? {} : { vertex };
      const dx = vertices[2 * vertex] - c.cx,
        dy = vertices[2 * vertex + 1] - c.cy;
      for (let edge = 0; edge < (c.M || 1); edge++) {
        const contact: ContactConstraint =
          c.M === 0 ? { kind: "radial", i, ...point } : { kind: "wall", i, edge, ...point };
        const gap =
          c.M === 0 ? c.size - Math.hypot(dx, dy) - pad : apothem - dx * normals[edge][0] - dy * normals[edge][1] - pad;
        yield gap <= tolerance ? contact : undefined;
      }
    }
  }
}

/** Includes penetrations as well as near contacts, so the same system can repair a start. */
export function identifyContacts(config: PackingConfig, container?: Container, tolerance = 0.05): ContactConstraint[] {
  const c = container ?? geometryEvaluate(config, { autoOrient: true }).container;
  if (!c) return [];
  const out: ContactConstraint[] = [];
  for (const contact of contactCandidates(config, c, tolerance)) if (contact) out.push(contact);
  return out;
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

/** Central derivatives on only the variables participating in each contact. */
function contactJacobian(
  config: PackingConfig,
  container: Container,
  contacts: readonly ContactConstraint[],
  stopped: () => boolean,
): number[][] | undefined {
  const x = packContactVariables(config, container);
  const offset = 3 * config.P;
  const rows: number[][] = [];
  for (const contact of contacts) {
    if (stopped()) return undefined;
    const row = Array<number>(x.length).fill(0);
    const variables =
      contact.kind === "pair"
        ? [3 * contact.i, 3 * contact.i + 1, 3 * contact.i + 2, 3 * contact.j, 3 * contact.j + 1, 3 * contact.j + 2]
        : [3 * contact.i, 3 * contact.i + 1, 3 * contact.i + 2, offset, offset + 1, offset + 2, offset + 3];
    for (const variable of variables) {
      if (stopped()) return undefined;
      if (config.N === 0 && variable < offset && variable % 3 === 2) continue;
      if (config.M === 0 && variable === offset + 2) continue;
      const h = 2e-6;
      const plus = x.slice(),
        minus = x.slice();
      plus[variable] += h;
      minus[variable] -= h;
      const p = unpackContactVariables(config, plus),
        m = unpackContactVariables(config, minus);
      row[variable] =
        (contactResiduals(p.config, p.container, [contact])[0] -
          contactResiduals(m.config, m.container, [contact])[0]) /
        (2 * h);
    }
    rows.push(row);
  }
  return rows;
}

/** Geometric restoration uses a much tighter margin than the server's touching tolerance. */
function restoreSeparation(config: PackingConfig, stopped: () => boolean): boolean {
  for (let sweep = 0; sweep < 48; sweep++) {
    let worst = 0;
    for (let i = 0; i < config.P; i++)
      for (let j = i + 1; j < config.P; j++) {
        if (stopped()) return false;
        const contact = pieceSeparation(config.N, config.pieces[i], config.pieces[j]);
        worst = Math.max(worst, -contact.sep);
        if (contact.sep < (config.N === 0 ? 0 : -2e-14)) {
          const move = (-contact.sep + 2e-13) / 2;
          config.pieces[i].x += move * contact.nx;
          config.pieces[i].y += move * contact.ny;
          config.pieces[j].x -= move * contact.nx;
          config.pieces[j].y -= move * contact.ny;
        }
      }
    if (config.N === 0 ? worst === 0 : worst < 2e-14) return true;
  }
  for (let i = 0; i < config.P; i++)
    for (let j = i + 1; j < config.P; j++) {
      if (
        stopped() ||
        pieceSeparation(config.N, config.pieces[i], config.pieces[j]).sep < (config.N === 0 ? 0 : -1e-12)
      )
        return false;
    }
  return true;
}

/** Apply the polish tolerance to both the initial fallback and every scored container. */
function strictlyFeasible(config: PackingConfig, container: Container, stopped: () => boolean): boolean {
  let scanned = 0;
  for (const contact of contactCandidates(config, container, -1e-12)) {
    if (scanned++ % 256 === 0 && stopped()) return false;
    if (contact) return false;
  }
  return true;
}

const IMPROVEMENT_FLOOR = 2e-13;

/** Solve the final contact equalities by rank-tolerant row projections (Newton's step). */
function contactNewton(
  rows: readonly number[][],
  gaps: readonly number[],
  stopped: () => boolean,
): number[] | undefined {
  if (!rows.length) return [];
  const direction = Array<number>(rows[0].length).fill(0);
  const norms = rows.map((row) => dot(row, row));
  for (let sweep = 0; sweep < 1000; sweep++) {
    let largest = 0;
    for (let k = 0; k < rows.length; k++) {
      if (stopped()) return undefined;
      if (norms[k] < 1e-20) continue;
      const residual = 2e-13 - gaps[k] - dot(rows[k], direction);
      largest = Math.max(largest, Math.abs(residual));
      const delta = residual / norms[k];
      for (let j = 0; j < direction.length; j++) direction[j] += delta * rows[k][j];
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
    const contacts: ContactConstraint[] = [];
    for (const contact of contactCandidates(current, container, tolerance)) {
      if (stopped()) return best;
      if (contact) contacts.push(contact);
      if (contacts.length > 2048 || contacts.length * Math.max(current.N, 1) > 50000) return best;
    }
    const x = packContactVariables(current, container);
    const gaps = contactResiduals(current, container, contacts);
    const rows = contactJacobian(current, container, contacts, stopped);
    if (!rows) return best;
    const direction = Array<number>(x.length).fill(0);
    direction[x.length - 1] = -trust;
    const multipliers = Array<number>(rows.length).fill(0);
    const norms = rows.map((row) => dot(row, row));
    // Hildreth coordinate descent solves the convex QP dual without singular KKT matrices.
    for (let sweep = 0; sweep < 300; sweep++) {
      if (stopped()) return best;
      let largest = 0;
      for (let k = 0; k < rows.length; k++) {
        if (stopped()) return best;
        if (norms[k] < 1e-20) continue;
        const next = Math.max(0, multipliers[k] + (-gaps[k] + 2e-13 - dot(rows[k], direction)) / norms[k]);
        const delta = next - multipliers[k];
        multipliers[k] = next;
        largest = Math.max(largest, Math.abs(delta));
        for (let j = 0; j < direction.length; j++) direction[j] += delta * rows[k][j];
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
      const contacts: ContactConstraint[] = [];
      for (const contact of contactCandidates(best, base.container, 2e-7)) {
        if (stopped()) return best;
        if (contact) contacts.push(contact);
        if (contacts.length > 2048 || contacts.length * Math.max(best.N, 1) > 50000) return best;
      }
      const gaps = contactResiduals(best, base.container, contacts);
      const rows = contactJacobian(best, base.container, contacts, stopped);
      if (!rows) return best;
      const direction = contactNewton(rows, gaps, stopped);
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
