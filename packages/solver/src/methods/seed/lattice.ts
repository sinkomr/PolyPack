import { boundingRadius, defaultTheta, inradius, pieceSeparation, pieceVertices, type Pose } from "@polypack/geometry";
import type { MethodContext } from "../../framework";

export interface Cell {
  a: [number, number];
  b: [number, number];
  motif: Pose[];
}

/**
 * Side-one ice-ray cell reconstructed from the contacts of the double lattice
 * attributed to Kuperberg & Kuperberg (1990). See the derivation in seed.md.
 * The second centre is deliberately NOT halfway up the rectangular cell.
 */
export function pentagonCell(): Cell {
  const R = boundingRadius(5);
  const x = R * Math.sin((2 * Math.PI) / 5);
  const y = R * Math.cos((2 * Math.PI) / 5);
  return {
    a: [3 * x, 0],
    b: [0, R + inradius(5)],
    motif: [
      { x: 0, y: 0, theta: 0 },
      { x: (3 * x) / 2, y: (R + 3 * y) / 2, theta: Math.PI },
    ],
  };
}

export function rotate(pose: Pose, angle: number): Pose {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: c * pose.x - s * pose.y, y: s * pose.x + c * pose.y, theta: pose.theta + angle };
}

export function baseCell(N: number, hex: boolean, theta: number, stagger = false): Cell {
  const h = Math.sqrt(3) / 2;
  if (N === 3) {
    // A honeycomb of triangle centroids: two orientations per triangular cell,
    // or four per rectangular cell. Both decorate the same exact plane tiling.
    const cell: Cell = hex
      ? {
          a: [1, 0],
          b: [0.5, h],
          motif: [
            { x: 0, y: 0, theta: 0 },
            { x: 0.5, y: h / 3, theta: Math.PI },
          ],
        }
      : {
          a: [1, 0],
          b: [0, 2 * h],
          motif: [
            { x: 0, y: 0, theta: 0 },
            { x: 0.5, y: h / 3, theta: Math.PI },
            { x: 0.5, y: h, theta: 0 },
            { x: 1, y: (4 * h) / 3, theta: Math.PI },
          ],
        };
    return {
      a: [cell.a[0] * Math.cos(theta), cell.a[0] * Math.sin(theta)],
      b: [
        cell.b[0] * Math.cos(theta) - cell.b[1] * Math.sin(theta),
        cell.b[0] * Math.sin(theta) + cell.b[1] * Math.cos(theta),
      ],
      motif: cell.motif.map((p) => rotate(p, theta)),
    };
  }
  return {
    a: [1, 0],
    b: hex ? [0.5, h] : [stagger ? 0.5 : 0, 1],
    motif: [{ x: 0, y: 0, theta }],
  };
}

/** Smallest uniform dilation, testing only translates that can still contact. */
export async function tightScale(ctx: MethodContext, cell: Cell): Promise<number | undefined> {
  const N = ctx.problem.N;
  const reach = 2 * boundingRadius(N);
  const vectors: { dx: number; dy: number; a: Pose; b: Pose; distance: number }[] = [];
  let shortest = Infinity;
  for (let i = -4; i <= 4; i++) {
    for (let j = -4; j <= 4; j++) {
      for (let u = 0; u < cell.motif.length; u++) {
        for (let v = 0; v < cell.motif.length; v++) {
          if (i === 0 && j === 0 && u === v) continue;
          const a = cell.motif[u];
          const b = cell.motif[v];
          const dx = i * cell.a[0] + j * cell.b[0] + b.x - a.x;
          const dy = i * cell.a[1] + j * cell.b[1] + b.y - a.y;
          const distance = Math.hypot(dx, dy);
          shortest = Math.min(shortest, distance);
          vectors.push({ dx, dy, a, b, distance });
        }
      }
    }
  }
  // Inscribed disks give a rigorous lower bound on any feasible dilation.
  // Outside 2R at that bound, a translate cannot determine the tight spacing.
  let scale = (2 * (N === 0 ? 1 : inradius(N))) / shortest;
  vectors.sort((a, b) => a.distance - b.distance);
  for (const vector of vectors) {
    if (!(await ctx.checkpoint())) return undefined;
    if (vector.distance * scale > reach * (1 + 1e-12)) continue;
    const { dx, dy, a, b, distance } = vector;
    let lo = 0;
    let hi = reach / distance;
    for (let step = 0; step < 44; step++) {
      if (ctx.shouldStop()) return undefined;
      const mid = (lo + hi) / 2;
      if (pieceSeparation(N, { x: 0, y: 0, theta: a.theta }, { x: mid * dx, y: mid * dy, theta: b.theta }).sep < 0)
        lo = mid;
      else hi = mid;
    }
    scale = Math.max(scale, hi);
  }
  return scale * (1 + 2e-13);
}

/** Cache contact calculations within a run, not across jobs or random streams. */
export class SpacingCache {
  private readonly scales = new Map<string, number>();
  private readonly orientations = new Map<string, number>();
  constructor(private readonly ctx: MethodContext) {}
  async scale(kind: string, cell: Cell, orientation: number): Promise<number | undefined> {
    const key = `${kind}:${this.ctx.problem.N === 3 ? 0 : orientation}`;
    if (this.scales.has(key)) return this.scales.get(key);
    const scale = await tightScale(this.ctx, cell);
    if (scale !== undefined) this.scales.set(key, scale);
    return scale;
  }
  async optimum(hex: boolean): Promise<number | undefined> {
    const N = this.ctx.problem.N;
    const key = `${N}:${hex}`;
    if (this.orientations.has(key)) return this.orientations.get(key);
    if (N === 0 || N === 3 || N === 4 || N === 8 || (N === 6 && hex)) return automaticTheta(N);
    const end = Math.PI / N;
    const steps = 24;
    let best = 0;
    let smallest = Infinity;
    const value = async (theta: number) =>
      (await this.scale(`orientation-${hex}`, baseCell(N, hex, theta), theta)) ?? Infinity;
    for (let i = 0; i <= steps; i++) {
      if (this.ctx.shouldStop()) return undefined;
      const theta = (end * i) / steps;
      const scale = await value(theta);
      if (scale < smallest) {
        smallest = scale;
        best = theta;
      }
    }
    let lo = Math.max(0, best - end / steps);
    let hi = Math.min(end, best + end / steps);
    const golden = (Math.sqrt(5) - 1) / 2;
    let left = hi - golden * (hi - lo);
    let right = lo + golden * (hi - lo);
    let lv = await value(left);
    let rv = await value(right);
    for (let i = 0; i < 30; i++) {
      if (this.ctx.shouldStop()) return undefined;
      if (lv < rv) {
        hi = right;
        right = left;
        rv = lv;
        left = hi - golden * (hi - lo);
        lv = await value(left);
      } else {
        lo = left;
        left = right;
        lv = rv;
        right = lo + golden * (hi - lo);
        rv = await value(right);
      }
    }
    if (Math.min(lv, rv) < smallest) best = lv < rv ? left : right;
    this.orientations.set(key, best);
    return best;
  }
}

/** Support tables are per motif orientation, not per translated lattice site. */
function ranker(N: number, M: number, theta: number): (x: number, y: number) => number {
  const vertices = N === 0 ? new Float64Array([0, 0]) : pieceVertices(N, { x: 0, y: 0, theta });
  if (M === 0)
    return (x, y) => {
      let rank = 0;
      for (let k = 0; k < vertices.length; k += 2)
        rank = Math.max(rank, Math.hypot(x + vertices[k], y + vertices[k + 1]) + (N === 0 ? 1 : 0));
      return rank;
    };
  const normals = Array.from({ length: M }, (_, edge) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * edge) / M;
    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    let support = -Infinity;
    for (let k = 0; k < vertices.length; k += 2)
      support = Math.max(support, nx * vertices[k] + ny * vertices[k + 1] + (N === 0 ? 1 : 0));
    return { nx, ny, support };
  });
  return (x, y) => {
    let rank = -Infinity;
    for (const normal of normals) rank = Math.max(rank, x * normal.nx + y * normal.ny + normal.support);
    return rank;
  };
}

export function cutRank(N: number, M: number, p: Pose): number {
  return ranker(N, M, p.theta)(p.x, p.y);
}

export async function latticeCut(
  ctx: MethodContext,
  cell: Cell,
  scale: number,
  angle: number,
  offset: [number, number],
): Promise<Pose[] | undefined> {
  const { N, M, P } = ctx.problem;
  const extent = Math.ceil(Math.sqrt(P / cell.motif.length)) + 3;
  const sites: { pose: Pose; rank: number }[] = [];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const ranks = cell.motif.map((p) => ranker(N, M, p.theta + angle));
  for (let i = -extent; i <= extent; i++) {
    if (!(await ctx.checkpoint())) return undefined;
    for (let j = -extent; j <= extent; j++) {
      for (let k = 0; k < cell.motif.length; k++) {
        const p = cell.motif[k];
        const x = scale * ((i + offset[0]) * cell.a[0] + (j + offset[1]) * cell.b[0] + p.x);
        const y = scale * ((i + offset[0]) * cell.a[1] + (j + offset[1]) * cell.b[1] + p.y);
        const pose = { x: c * x - s * y, y: s * x + c * y, theta: p.theta + angle };
        sites.push({ pose, rank: ranks[k](pose.x, pose.y) });
      }
    }
  }
  sites.sort((a, b) => a.rank - b.rank || a.pose.y - b.pose.y || a.pose.x - b.pose.x);
  return sites.slice(0, P).map((site) => site.pose);
}

/** k² unit triangles tile a triangle of side k; partial cuts stay valid. */
export function triangleBlock(P: number, angle: number): Pose[] {
  const k = Math.ceil(Math.sqrt(P));
  const h = Math.sqrt(3) / 2;
  const pieces: Pose[] = [];
  for (let row = 0; row < k; row++) {
    for (let col = 0; col < k - row; col++) {
      pieces.push(rotate({ x: -k / 2 + 0.5 + col + row / 2, y: (-k * h) / 3 + h / 3 + row * h, theta: 0 }, angle));
      if (col < k - row - 1)
        pieces.push(
          rotate({ x: -k / 2 + 1 + col + row / 2, y: (-k * h) / 3 + (2 * h) / 3 + row * h, theta: Math.PI }, angle),
        );
    }
  }
  return pieces.slice(0, P);
}

export function automaticTheta(N: number): number {
  return defaultTheta(N);
}
