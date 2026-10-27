/**
 * The ball model in site units (balls of diameter 1, units.ts): a wrapper that hands the working model of balls.ts
 * (written for balls of radius 1) the lengths x BALL_WORK and gives back lengths / BALL_WORK. Both factors are 2, so
 * every conversion is exact in binary64 and the wrapped model computes exactly what it computed for radius 1: its
 * random draws are the same stream, so a seed's trajectory is the old one scaled by 1/2.
 *
 * Quantities: a length l (U, s, a violation, the floor, the longest step) converts by l / W; an energy, a sum of
 * squared lengths, by E / W^2; its gradient with respect to a length (E / W^2 differentiated by l = l_w / W) by g / W;
 * the target (an energy) by target / W^2.
 */
import { BALL_WORK } from "../units";
import type { BoundaryConfig, BoundaryPiece } from "../types";
import type { BallModel } from "./balls";
import type { PieceModel, State, TermOptions } from "./model";

const W = BALL_WORK;

export class SiteBallModel implements PieceModel {
  readonly P: number;
  readonly target: number;
  readonly floor: number;
  readonly maxStep: number;
  private readonly work: State;
  private readonly gw: Float64Array;
  private readonly dsw = new Float64Array(1);

  constructor(readonly inner: BallModel) {
    this.P = inner.P;
    this.target = inner.target / (W * W);
    this.floor = inner.floor / W;
    this.maxStep = inner.maxStep / W;
    this.work = { cells: new Int32Array(this.P), U: new Float64Array(3 * this.P) };
    this.gw = new Float64Array(3 * this.P);
  }

  /** The state in working units (the model's scratch: valid until the next call). */
  private up(st: State): State {
    this.work.cells.set(st.cells);
    for (let i = 0; i < st.U.length; i++) this.work.U[i] = st.U[i] * W;
    return this.work;
  }

  private static down(st: State): State {
    const U = new Float64Array(st.U.length);
    for (let i = 0; i < U.length; i++) U[i] = st.U[i] / W;
    return { cells: Int32Array.from(st.cells), U };
  }

  energy(st: State, s: number, g: Float64Array): number {
    const e = this.inner.energy(this.up(st), s * W, this.gw);
    for (let i = 0; i < g.length; i++) g[i] = this.gw[i] / W;
    return e / (W * W);
  }

  violation(st: State, s: number): number {
    return this.inner.violation(this.up(st), s * W) / W;
  }

  terms(st: State, s: number, g: Float64Array | null, violation: boolean, o: TermOptions): number {
    const ds = o.ds ?? null;
    const r = this.inner.terms(this.up(st), s * W, g ? this.gw : null, violation, ds ? { ...o, ds: this.dsw } : o);
    if (g) for (let i = 0; i < g.length; i++) g[i] = this.gw[i] / W;
    if (ds) ds[0] = this.dsw[0] / W;
    return violation ? r / W : r / (W * W);
  }

  startEdge(): number {
    return this.inner.startEdge() / W;
  }

  randomState(s: number, rand: () => number): State {
    return SiteBallModel.down(this.inner.randomState(s * W, rand));
  }

  hop(st: State, s: number, rand: () => number): State {
    return SiteBallModel.down(this.inner.hop(this.up(st), s * W, rand));
  }

  constructedStart(): null {
    return null;
  }

  stateOf(config: BoundaryConfig): State | null {
    if (!config || !Array.isArray(config.pieces)) return null;
    const scaled: BoundaryConfig = {
      s: config.s * W,
      pieces: config.pieces.map((p) => (p && Array.isArray(p.u) ? { cell: p.cell, u: p.u.map((x) => x * W) } : p)),
    };
    const st = this.inner.stateOf(scaled);
    return st ? SiteBallModel.down(st) : null;
  }

  pieces(st: State, s: number): BoundaryPiece[] {
    return this.inner.pieces(this.up(st), s * W).map((p) => ({ cell: p.cell, u: p.u.map((x) => x / W) }));
  }
}
