import {
  boundingRadius,
  containerInradius,
  enclose,
  findOverlaps,
  MAX_COORD,
  pieceSeparation,
  visitContainerProtrusions,
  type Container,
  type PackingConfig,
  type Pose,
} from "@polypack/geometry";

export const MIN_STEP = 1e-7;

/** Shared enclosures can round inward; add free room rather than accepting protrusion. */
export function strictEnclose(config: PackingConfig, phi = config.container_phi): Container {
  const container = enclose(config.N, config.pieces, config.M, phi);
  const wallScale = containerInradius(config.M);
  return { ...container, size: container.size + (2e-13 * Math.max(1, container.size)) / wallScale };
}

/** Mutable centre grid. Query the destination, so arbitrarily long proposals are safe. */
export class CellGrid {
  private readonly cells = new Map<string, Set<number>>();
  private readonly keys: string[] = [];
  readonly reach: number;

  constructor(
    readonly N: number,
    readonly pieces: Pose[],
  ) {
    this.reach = 2 * boundingRadius(N);
    for (let i = 0; i < pieces.length; i++) this.insert(i);
  }

  private key(p: Pose): string {
    return `${Math.floor(p.x / this.reach)},${Math.floor(p.y / this.reach)}`;
  }

  private insert(i: number): void {
    const key = this.key(this.pieces[i]);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = new Set();
      this.cells.set(key, cell);
    }
    cell.add(i);
    this.keys[i] = key;
  }

  clear(i: number, trial: Pose): boolean {
    const x = Math.floor(trial.x / this.reach);
    const y = Math.floor(trial.y / this.reach);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.cells.get(`${x + dx},${y + dy}`);
        if (!cell) continue;
        for (const j of cell) {
          if (i === j) continue;
          const other = this.pieces[j];
          // Bounding disks rigorously exclude contacts outside the 3x3 block.
          if ((trial.x - other.x) ** 2 + (trial.y - other.y) ** 2 > this.reach ** 2) continue;
          if (pieceSeparation(this.N, trial, other).sep < 0) return false;
        }
      }
    }
    return true;
  }

  move(i: number, trial: Pose): void {
    const old = this.keys[i];
    const cell = this.cells.get(old)!;
    cell.delete(i);
    if (cell.size === 0) this.cells.delete(old);
    this.pieces[i] = trial;
    this.insert(i);
  }
}

export function contained(N: number, pose: Pose, container: Container): boolean {
  let valid = Number.isFinite(container.size) && container.size > 0;
  visitContainerProtrusions(
    N,
    pose,
    container,
    (depth) => {
      if (!Number.isFinite(depth) || depth > 0) valid = false;
    },
    true,
  );
  return valid;
}

export function feasible(config: PackingConfig, container: Container): boolean {
  return (
    config.pieces.length === config.P &&
    config.pieces.every((p) => bounded(p) && contained(config.N, p, container)) &&
    findOverlaps(config.N, config.pieces, 0).length === 0
  );
}

function bounded(p: Pose): boolean {
  return [p.x, p.y, p.theta].every(Number.isFinite) && Math.abs(p.x) <= MAX_COORD && Math.abs(p.y) <= MAX_COORD;
}

export function adaptStep(step: number, rate: number, target: number, gain: number, maximum: number): number {
  if (gain === 0) return step;
  return Math.max(MIN_STEP, Math.min(maximum, step * Math.exp(gain * (rate - target))));
}

/** Energy is exactly the explicit container side (polygon) or diameter (circle). */
export function acceptSize(before: number, after: number, temperature: number, random: () => number): boolean {
  return after <= before || (temperature > 0 && random() < Math.exp(-(after - before) / temperature));
}

export class CompressionState {
  grid: CellGrid;

  constructor(
    public config: PackingConfig,
    public container: Container,
  ) {
    this.config = { ...config, container_phi: container.phi };
    this.grid = new CellGrid(config.N, config.pieces);
  }

  move(i: number, trial: Pose): boolean {
    if (!bounded(trial) || !contained(this.config.N, trial, this.container) || !this.grid.clear(i, trial)) return false;
    this.grid.move(i, trial);
    return true;
  }

  replace(config: PackingConfig, container: Container, temperature: number, random: () => number): boolean {
    // A tight enclosure supplied by callers can round inward by a few ulps.
    // Correct its size explicitly; never interpret that positive depth as room.
    let protrusion = 0;
    for (const p of config.pieces) {
      visitContainerProtrusions(
        config.N,
        p,
        container,
        (depth) => {
          protrusion = Math.max(protrusion, depth);
        },
        true,
      );
    }
    if (protrusion > 0 && protrusion <= 1e-12) {
      const wallScale = containerInradius(container.M);
      container = { ...container, size: container.size + (protrusion + 2e-13) / wallScale };
    }
    if (!feasible(config, container) || !acceptSize(this.container.size, container.size, temperature, random))
      return false;
    this.config = { ...config, container_phi: container.phi };
    this.container = container;
    this.grid = new CellGrid(config.N, config.pieces);
    return true;
  }

  contracted(factor: number): PackingConfig {
    const { cx, cy } = this.container;
    return {
      ...this.config,
      pieces: this.config.pieces.map((p) => ({ ...p, x: cx + factor * (p.x - cx), y: cy + factor * (p.y - cy) })),
    };
  }

  /** Initial homothetic shrink preserves a supplied loose arrangement's contact topology. */
  initialContraction(stopped: () => boolean, room = 0): boolean {
    let lo = 0;
    let hi = 1;
    // For fixed centre rays, convex centrally-containing pieces' pair gaps are
    // monotone with dilation. Bisection retains only the non-overlapping side.
    for (let k = 0; k < 40; k++) {
      if (stopped()) return false;
      const mid = (lo + hi) / 2;
      const trial = this.contracted(mid);
      if (findOverlaps(trial.N, trial.pieces, 0).length) lo = mid;
      else hi = mid;
    }
    const trial = this.contracted(hi);
    const container = strictEnclose(trial, this.container.phi);
    return this.replace(trial, { ...container, size: container.size * (1 + room) }, 0, () => 0);
  }
}
