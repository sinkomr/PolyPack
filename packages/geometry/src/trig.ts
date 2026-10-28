/**
 * Memo of the per-orientation trigonometry of a regular N-gon piece (internal, not exported from the index).
 *
 * Invariant: an entry holds only pure functions of (N, theta): the SAT edge-normal angles with their
 * cos and sin, and the vertex-direction cos and sin. It never depends on x, y, the container or the
 * other piece. Every lookup compares (N, theta) with Object.is against the entry it finds, so a pose
 * that changed theta (or N) can never read another orientation's values: a stale entry is a miss, and
 * is refilled. Poses are not tagged or watched, so there is nothing to invalidate by hand, and
 * `{ ...p, x }` copies hit the entry of `p`. The expressions are the ones the kernels used inline
 * (same operand order), so every value is bit-equal to computing it in place.
 *
 * An entry is overwritten in place when its slot is taken by another orientation, so a caller must
 * not hold one across a call that can look up another (a visitor callback, say) and must pass the
 * entry it holds as `keep` when it fetches a second one.
 */
export interface PieceTrig {
  N: number;
  theta: number;
  /** [angle, cos, sin] per edge normal, as penaltyEdgeNormals lays them out; valid when axesReady, or per edge once its cos is not NaN (see axisOf). */
  axes: Float64Array;
  axesReady: boolean;
  /** cos and sin of vertex angle theta + PI/2 + k * step, NaN until computed (a NaN result is just recomputed). */
  vcos: Float64Array;
  vsin: Float64Array;
}

const SLOTS = 2048;
const slots: (PieceTrig | undefined)[] = new Array<PieceTrig | undefined>(SLOTS);
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

function fill(e: PieceTrig, N: number, theta: number): void {
  e.N = N;
  e.theta = theta;
  e.axesReady = false;
  e.axes.fill(NaN, 0, 3 * N);
  e.vcos.fill(NaN, 0, N);
  e.vsin.fill(NaN, 0, N);
}

function make(N: number, theta: number): PieceTrig {
  const e: PieceTrig = {
    N,
    theta,
    axes: new Float64Array(3 * N).fill(NaN),
    axesReady: false,
    vcos: new Float64Array(N).fill(NaN),
    vsin: new Float64Array(N).fill(NaN),
  };
  return e;
}

/** The entry for (N, theta), reusing a slot (never `keep`'s) on a miss. */
export function pieceTrig(N: number, theta: number, keep?: PieceTrig): PieceTrig {
  f64[0] = theta;
  // N is mixed in before the multiply, so it reaches the top bits the shift keeps
  let idx = Math.imul(u32[0] ^ Math.imul(u32[1], 0x9e3779b1) ^ Math.imul(N, 0x27d4eb2f), 0x85ebca6b) >>> 21; // 11 bits
  let e = slots[idx];
  if (e !== undefined && e.N === N && Object.is(e.theta, theta)) return e;
  if (e === keep && e !== undefined) {
    idx = (idx + 1) & (SLOTS - 1);
    e = slots[idx];
    if (e !== undefined && e.N === N && Object.is(e.theta, theta)) return e;
  }
  if (e === undefined || e.axes.length < 3 * N) {
    e = make(N, theta);
    slots[idx] = e;
  } else {
    // arrays at least as long as N needs are reused
    fill(e, N, theta);
  }
  return e;
}

/** Fill the SAT axes of an entry: the expressions of regularPolygonSeparation and penaltyEdgeNormals. */
export function axesOf(e: PieceTrig): Float64Array {
  const axes = e.axes;
  if (!e.axesReady) {
    const N = e.N;
    const step = (2 * Math.PI) / N;
    for (let k = 0; k < N; k++) {
      const angle = e.theta + Math.PI / 2 + Math.PI / N + k * step;
      axes[3 * k] = angle;
      axes[3 * k + 1] = Math.cos(angle);
      axes[3 * k + 2] = Math.sin(angle);
    }
    e.axesReady = true;
  }
  return axes;
}

/**
 * cos and sin of vertex `vertex`'s angle `(theta + PI/2) + vertex * step` (step = 2 PI / N).
 * Returns the cos; the sin is left in `lastVertexSin`. Looks the entry up afresh each call, so a
 * visitor that runs other kernels between calls cannot leave the caller with an overwritten entry.
 */
export let lastVertexSin = 0;
export function vertexCos(N: number, theta: number, vertex: number, step: number): number {
  const e = pieceTrig(N, theta);
  let c = e.vcos[vertex];
  let s = e.vsin[vertex];
  if (c !== c || s !== s) {
    const angle = theta + Math.PI / 2 + vertex * step;
    c = e.vcos[vertex] = Math.cos(angle);
    s = e.vsin[vertex] = Math.sin(angle);
  }
  lastVertexSin = s;
  return c;
}

/** Edge normal `k` of an entry on demand (for kernels that visit few axes): fills [angle, cos, sin] if not yet there. */
export function axisOf(e: PieceTrig, k: number): Float64Array {
  const axes = e.axes;
  if (!e.axesReady && (axes[3 * k + 1] !== axes[3 * k + 1] || axes[3 * k + 2] !== axes[3 * k + 2])) {
    const N = e.N;
    const step = (2 * Math.PI) / N;
    const angle = e.theta + Math.PI / 2 + Math.PI / N + k * step;
    axes[3 * k] = angle;
    axes[3 * k + 1] = Math.cos(angle);
    axes[3 * k + 2] = Math.sin(angle);
  }
  return axes;
}
