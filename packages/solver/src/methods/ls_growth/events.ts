import type { Pose } from "@polypack/geometry";

export interface Velocity {
  x: number;
  y: number;
  omega: number;
}

/** Stable quadratic roots: q avoids subtracting nearly equal numbers. */
function roots(a: number, b: number, c: number): number[] {
  if (a === 0) return b === 0 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const d = Math.sqrt(discriminant);
  const q = -0.5 * (b + (b < 0 ? -d : d));
  if (q === 0) return [-b / (2 * a)];
  return [q / a, c / q].sort((x, y) => x - y);
}

/** |d+vt|²=(2r+2gt)²; select the entering root, including immediate contact. */
export function discDiscTime(a: Pose, b: Pose, va: Velocity, vb: Velocity, radius: number, growth: number): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const vx = va.x - vb.x;
  const vy = va.y - vb.y;
  const A = vx * vx + vy * vy - 4 * growth * growth;
  const B = 2 * (dx * vx + dy * vy - 4 * radius * growth);
  const C = dx * dx + dy * dy - 4 * radius * radius;
  if (C <= 0 && B < 0) return 0;
  for (const t of roots(A, B, C)) {
    if (t >= 0 && 2 * A * t + B < 0) return t;
  }
  return Infinity;
}

/** Outward unit normal n; the centre must satisfy p.n+r <= apothem. */
export function discEdgeTime(
  p: Pose,
  v: Velocity,
  radius: number,
  growth: number,
  nx: number,
  ny: number,
  apothem: number,
): number {
  const closing = v.x * nx + v.y * ny + growth;
  if (closing <= 0) return Infinity;
  return Math.max(0, (apothem - p.x * nx - p.y * ny - radius) / closing);
}

/** |p+vt|²=(R-r-gt)²; select the exiting root while the available radius is positive. */
export function discCircleWallTime(
  p: Pose,
  v: Velocity,
  radius: number,
  growth: number,
  containerRadius: number,
): number {
  const free = containerRadius - radius;
  const A = v.x * v.x + v.y * v.y - growth * growth;
  const B = 2 * (p.x * v.x + p.y * v.y + free * growth);
  const C = p.x * p.x + p.y * p.y - free * free;
  if (C >= 0 && (B > 0 || (B === 0 && A > 0))) return 0;
  for (const t of roots(A, B, C)) {
    if (t >= 0 && free - growth * t >= 0 && 2 * A * t + B > 0) return t;
  }
  // A stationary concentric disc has a double root when it fills the wall.
  return growth > 0 && v.x === 0 && v.y === 0 && p.x === 0 && p.y === 0 ? free / growth : Infinity;
}

/** n points from b to a. Relative normal speed changes u -> 4g-u. */
export function collideDiscs(a: Velocity, b: Velocity, nx: number, ny: number, growth: number): void {
  const relative = (a.x - b.x) * nx + (a.y - b.y) * ny;
  const impulse = 2 * growth - relative;
  a.x += impulse * nx;
  a.y += impulse * ny;
  b.x -= impulse * nx;
  b.y -= impulse * ny;
}

export interface Event {
  time: number;
  i: number;
  j: number;
  edge: number;
}

/** Stable tie order makes simultaneous contacts reproducible. */
function before(a: Event, b: Event): boolean {
  return (
    a.time < b.time ||
    (a.time === b.time && (a.i < b.i || (a.i === b.i && (a.j < b.j || (a.j === b.j && a.edge < b.edge)))))
  );
}

export class EventQueue {
  private readonly heap: Event[] = [];

  push(event: Event): void {
    if (!Number.isFinite(event.time)) return;
    let i = this.heap.length;
    this.heap.push(event);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(event, this.heap[parent])) break;
      this.heap[i] = this.heap[parent];
      i = parent;
    }
    this.heap[i] = event;
  }

  pop(): Event | undefined {
    const first = this.heap[0];
    const last = this.heap.pop();
    if (!last || this.heap.length === 0) return first;
    let i = 0;
    while (2 * i + 1 < this.heap.length) {
      let child = 2 * i + 1;
      if (child + 1 < this.heap.length && before(this.heap[child + 1], this.heap[child])) child++;
      if (!before(this.heap[child], last)) break;
      this.heap[i] = this.heap[child];
      i = child;
    }
    this.heap[i] = last;
    return first;
  }
}

/**
 * A pair that can collide within h starts at distance <= 2r+2(g+vmax)h.
 * The inflated grid therefore includes every ballistic collision in the horizon,
 * including neighbours that will cross a cell boundary. Rebuild after an impulse.
 */
export function horizonPairs(pieces: Pose[], reach: number, stopped: () => boolean): [number, number][] {
  const cells = new Map<string, number[]>();
  const pairs: [number, number][] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (stopped()) return pairs;
    const p = pieces[i];
    const x = Math.floor(p.x / reach);
    const y = Math.floor(p.y / reach);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = cells.get(`${x + dx},${y + dy}`);
        if (!cell) continue;
        for (const j of cell) {
          if (Math.hypot(p.x - pieces[j].x, p.y - pieces[j].y) <= reach) pairs.push([j, i]);
        }
      }
    }
    const key = `${x},${y}`;
    const cell = cells.get(key);
    if (cell) cell.push(i);
    else cells.set(key, [i]);
  }
  return pairs;
}
