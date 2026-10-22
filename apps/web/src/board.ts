import {
  Container,
  PackingConfig,
  MOVE_TOL,
  Pose,
  autoOrient,
  boundingRadius,
  enclose,
  findFreeSpot,
  findOverlaps,
  rotateGroup,
  rotatePose,
  slideMove,
  snapDistance,
} from "@polypack/geometry";
import { MagneticSnap, SnapMode, magneticCandidates } from "./snapping";

export interface BoardState {
  N: number;
  M: number;
  P: number;
  pieces: Pose[];
  /** Container orientation. The pieces stay fixed in world coordinates and the container rotates. */
  phi: number;
}

const HISTORY_LIMIT = 300;

/**
 * The board model: problem, pieces, selection and undo history. Every operation that moves a
 * piece goes through the no-overlap moves of the geometry package, so the state is always valid.
 */
export class Board {
  state: BoardState = { N: 7, M: 7, P: 7, pieces: [], phi: 0 };
  selection = new Set<number>();
  container: Container | null = null;
  /**
   * What the latest change was, for listeners that care: "load" when a configuration replaced the
   * board, "history" for undo and redo, "edit" for everything else.
   */
  lastChange: "edit" | "load" | "history" = "edit";
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private gestureStart: string | null = null;
  private listeners = new Set<() => void>();

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  private changed(kind: Board["lastChange"] = "edit"): void {
    this.lastChange = kind;
    const s = this.state;
    this.container = s.pieces.length ? enclose(s.N, s.pieces, s.M, s.phi) : null;
    for (const fn of this.listeners) fn();
  }

  /** True between begin and commit: the board is in the middle of one undoable gesture. */
  get gesturing(): boolean {
    return this.gestureStart !== null;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Start of an undoable gesture (a drag, or one keystroke). */
  begin(): void {
    if (this.gestureStart === null) this.gestureStart = JSON.stringify(this.state);
  }

  /** End of a gesture; records one undo step if anything changed. */
  commit(kind: Board["lastChange"] = "edit"): void {
    if (this.gestureStart !== null && this.gestureStart !== JSON.stringify(this.state)) {
      this.undoStack.push(this.gestureStart);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }
    this.gestureStart = null;
    this.changed(kind);
  }

  /** Run one operation as its own undo step. */
  step<T>(fn: () => T, kind: Board["lastChange"] = "edit"): T {
    this.begin();
    const r = fn();
    this.commit(kind);
    return r;
  }

  private restore(from: string[], to: string[]): void {
    const snap = from.pop();
    if (snap === undefined) return;
    to.push(JSON.stringify(this.state));
    this.state = JSON.parse(snap);
    this.selection.clear();
    this.changed("history");
  }
  undo(): void {
    this.restore(this.undoStack, this.redoStack);
  }
  redo(): void {
    this.restore(this.redoStack, this.undoStack);
  }

  select(ids: Iterable<number>): void {
    this.selection = new Set(ids);
    this.changed();
  }

  toggle(id: number): void {
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
    this.changed();
  }

  private get ids(): number[] {
    return [...this.selection];
  }

  /** Centroid of the selected pieces and the radius of the circle about it that contains them. */
  selectionPivot(): { x: number; y: number; radius: number } | null {
    const ids = this.ids;
    if (!ids.length) return null;
    const ps = ids.map((i) => this.state.pieces[i]);
    const x = ps.reduce((s, p) => s + p.x, 0) / ps.length;
    const y = ps.reduce((s, p) => s + p.y, 0) / ps.length;
    const radius = Math.max(...ps.map((p) => Math.hypot(p.x - x, p.y - y))) + boundingRadius(this.state.N);
    return { x, y, radius };
  }

  /** Changing the piece shape clears the board (undoable); M and P keep the pieces. */
  setProblem(N: number, M: number, P: number): void {
    this.step(() => {
      if (N !== this.state.N) {
        this.state.pieces = [];
        this.selection.clear();
      }
      this.state.N = N;
      this.state.M = M;
      this.state.P = P;
      if (M === 0) this.state.phi = 0;
    });
  }

  /** Add `count` pieces in free space near (nearX, nearY), as one undo step. The last one is selected. */
  addPieces(count: number, nearX: number, nearY: number): void {
    this.step(() => {
      const s = this.state;
      for (let k = 0; k < count; k++) s.pieces.push(findFreeSpot(s.N, s.pieces, nearX, nearY));
      if (count > 0) this.selection = new Set([s.pieces.length - 1]);
    });
  }

  removeSelected(): void {
    this.step(() => {
      this.state.pieces = this.state.pieces.filter((_, i) => !this.selection.has(i));
      this.selection.clear();
    });
  }

  clear(): void {
    this.step(() => {
      this.state.pieces = [];
      this.selection.clear();
    });
  }

  /** Slide the selection toward (dx, dy). Returns the displacement applied. Call inside begin/commit. */
  translateSelection(dx: number, dy: number): { dx: number; dy: number } {
    const s = this.state;
    const d = slideMove(s.N, s.pieces, this.ids, dx, dy);
    if (d.dx !== 0 || d.dy !== 0) {
      for (const i of this.selection) s.pieces[i] = { ...s.pieces[i], x: s.pieces[i].x + d.dx, y: s.pieces[i].y + d.dy };
      this.changed();
    }
    return d;
  }

  /**
   * Rotate the selection about (px, py). A piece resting against a neighbour is nudged away as it
   * turns; a wedged piece stops at contact. Returns the angle applied.
   */
  rotateSelection(angle: number, px: number, py: number): number {
    const s = this.state;
    const r = rotateGroup(s.N, s.pieces, this.ids, px, py, angle);
    if (r.angle !== 0 || r.dx !== 0 || r.dy !== 0) {
      for (const i of this.selection) {
        const q = rotatePose(s.pieces[i], px, py, r.angle);
        s.pieces[i] = { x: q.x + r.dx, y: q.y + r.dy, theta: q.theta };
      }
      this.changed();
    }
    return r.angle;
  }

  /** Trial complete collision-constrained snaps; a blocked attempt leaves the board unchanged. */
  magnetSelection(radius: number, mode: SnapMode): MagneticSnap | null {
    const s = this.state, ids = this.ids;
    const pivot = this.selectionPivot();
    if (!pivot) return null;
    for (const candidate of magneticCandidates(s.N, s.pieces, ids, radius, mode).slice(0, 32)) {
      const r = rotateGroup(s.N, s.pieces, ids, pivot.x, pivot.y, candidate.angle);
      if (Math.abs(r.angle - candidate.angle) > 1e-10) continue;
      const trial = s.pieces.map((p, i) => {
        if (!this.selection.has(i)) return p;
        const q = rotatePose(p, pivot.x, pivot.y, r.angle);
        return { x: q.x + r.dx, y: q.y + r.dy, theta: q.theta };
      });
      const d = slideMove(s.N, trial, ids, candidate.dx - r.dx, candidate.dy - r.dy);
      if (Math.hypot(r.dx + d.dx - candidate.dx, r.dy + d.dy - candidate.dy) > MOVE_TOL) continue;
      for (const i of ids) trial[i] = { ...trial[i], x: trial[i].x + d.dx, y: trial[i].y + d.dy };
      if (findOverlaps(s.N, trial, MOVE_TOL).length) continue;
      s.pieces = trial;
      this.changed();
      return { ...candidate, dx: r.dx + d.dx, dy: r.dy + d.dy };
    }
    return null;
  }

  /** Push the selection along a unit direction until it touches something. Returns the distance moved. */
  snapSelection(ux: number, uy: number): number {
    const s = this.state;
    const t = snapDistance(s.N, s.pieces, this.ids, ux, uy);
    if (t > 0) {
      for (const i of this.selection) s.pieces[i] = { ...s.pieces[i], x: s.pieces[i].x + t * ux, y: s.pieces[i].y + t * uy };
      this.changed();
    }
    return t;
  }

  /** Exact placement from the numeric fields. Refused when it would overlap. */
  setPose(i: number, pose: Pose): boolean {
    const s = this.state;
    const trial = s.pieces.map((p, k) => (k === i ? pose : p));
    if (findOverlaps(s.N, trial).some((o) => o.i === i || o.j === i)) return false;
    this.step(() => {
      s.pieces[i] = pose;
    });
    return true;
  }

  setPhi(phi: number): void {
    if (this.state.M === 0) return;
    this.state.phi = phi;
    this.changed();
  }

  /**
   * Turns the container to the best orientation the search finds, as one undoable step, when that
   * makes it smaller; returns whether it did. The server scores a submission at the orientation it
   * is sent, so the board is turned before every submission.
   */
  autoOrient(): boolean {
    const s = this.state;
    if (!s.pieces.length || s.M === 0 || !this.container) return false;
    const best = autoOrient(s.N, s.pieces, s.M, s.phi);
    if (!(best.size < this.container.size)) return false;
    this.step(() => {
      s.phi = best.phi;
    });
    return true;
  }

  toConfig(): PackingConfig {
    const s = this.state;
    return { N: s.N, M: s.M, P: s.P, pieces: s.pieces.map((p) => ({ ...p })), container_phi: s.phi };
  }

  /** Replace the board with a configuration. Returns an error message when it has overlaps. */
  load(config: PackingConfig, undoable = true): string | null {
    const overlaps = findOverlaps(config.N, config.pieces);
    if (overlaps.length) return `the configuration has ${overlaps.length} overlapping pair(s)`;
    const apply = () => {
      this.state = {
        N: config.N,
        M: config.M,
        P: config.P,
        pieces: config.pieces.map((p) => ({ x: p.x, y: p.y, theta: p.theta })),
        phi: config.M === 0 ? 0 : config.container_phi,
      };
      this.selection.clear();
    };
    if (undoable) this.step(apply, "load");
    else {
      apply();
      this.changed("load");
    }
    return null;
  }
}
