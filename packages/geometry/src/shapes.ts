/** Position and orientation of one piece. theta is in radians and ignored for circles. */
export interface Pose {
  x: number;
  y: number;
  theta: number;
}

/**
 * Enclosing container. `size` is the side length s for a polygon container
 * and the diameter for a circle container (M = 0).
 */
export interface Container {
  M: number;
  cx: number;
  cy: number;
  phi: number;
  size: number;
}

/** Radius of a disk piece (N = 0): disk pieces have diameter 1. */
export const DISK_RADIUS = 0.5;

export const MAX_SIDES = 100;
export const MAX_PIECES = 500;
export const MAX_COORD = 1e6;

/** A shape code is 0 (circle) or an integer number of sides from 3 to MAX_SIDES. */
export function isShapeCode(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && (n === 0 || (n >= 3 && n <= MAX_SIDES));
}

/** Circumradius of a regular n-gon with side length 1. */
export function circumradius(n: number): number {
  return 1 / (2 * Math.sin(Math.PI / n));
}

/** Inradius (apothem) of a regular n-gon with side length 1. */
export function inradius(n: number): number {
  return 1 / (2 * Math.tan(Math.PI / n));
}

/** Radius of the smallest circle about the piece centre that contains the piece. */
export function boundingRadius(N: number): number {
  return N === 0 ? DISK_RADIUS : circumradius(N);
}

export function pieceArea(N: number): number {
  return N === 0 ? Math.PI * DISK_RADIUS * DISK_RADIUS : N / (4 * Math.tan(Math.PI / N));
}

export function containerArea(M: number, size: number): number {
  return M === 0 ? (Math.PI * size * size) / 4 : (M * size * size) / (4 * Math.tan(Math.PI / M));
}

/**
 * Vertices of an N-gon piece as a flat [x0, y0, x1, y1, ...] array, counter-clockwise.
 * Vertex k is at angle theta + pi/2 + 2 pi k / N, so theta = 0 puts a vertex straight up.
 * `scale` shrinks or grows the piece about its centre (used by the strict verifier).
 */
export function pieceVertices(N: number, pose: Pose, scale = 1, out?: Float64Array): Float64Array {
  const v = out ?? new Float64Array(2 * N);
  const R = circumradius(N) * scale;
  const step = (2 * Math.PI) / N;
  const a0 = pose.theta + Math.PI / 2;
  for (let k = 0; k < N; k++) {
    const a = a0 + k * step;
    v[2 * k] = pose.x + R * Math.cos(a);
    v[2 * k + 1] = pose.y + R * Math.sin(a);
  }
  return v;
}

/**
 * Vertices of a polygon container, counter-clockwise.
 * Vertex k is at angle phi - pi/2 + pi/M + 2 pi k / M, so phi = 0 gives a horizontal bottom edge.
 */
export function containerVertices(c: Container): Float64Array {
  const M = c.M;
  const v = new Float64Array(2 * M);
  const R = c.size / (2 * Math.sin(Math.PI / M));
  const a0 = c.phi - Math.PI / 2 + Math.PI / M;
  const step = (2 * Math.PI) / M;
  for (let k = 0; k < M; k++) {
    const a = a0 + k * step;
    v[2 * k] = c.cx + R * Math.cos(a);
    v[2 * k + 1] = c.cy + R * Math.sin(a);
  }
  return v;
}

/**
 * Area lower bound on the container size: P * A_piece <= A_container.
 * Returns the side length (polygon container) or diameter (circle container).
 */
export function areaLowerBound(N: number, M: number, P: number): number {
  const total = P * pieceArea(N);
  return M === 0 ? 2 * Math.sqrt(total / Math.PI) : Math.sqrt((total * 4 * Math.tan(Math.PI / M)) / M);
}
