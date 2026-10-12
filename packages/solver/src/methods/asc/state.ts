import {
  MAX_COORD,
  visitContainerProtrusions,
  type Container,
  type PackingConfig,
  type Pose,
} from "@polypack/geometry";
import { acceptSize, CellGrid, feasible } from "../mc_compress/state";

export function fullyContained(N: number, pose: Pose, container: Container): boolean {
  let valid = Number.isFinite(container.size) && container.size > 0;
  // The support shortcut can select a different vertex for enormous finite
  // angles. Check actual shared vertices, as the enclosing solver does.
  visitContainerProtrusions(N, pose, container, (depth) => {
    if (!Number.isFinite(depth) || depth > 0) valid = false;
  });
  return valid;
}

export const moveKinds = [
  "translation",
  "rotation",
  "containerTranslation",
  "containerRotation",
  "scale",
  "balanced",
  "uniaxial",
  "sector",
  "radial",
] as const;
export type MoveKind = (typeof moveKinds)[number];
export type CollectiveKind = "balanced" | "uniaxial" | "sector" | "radial";

/** Only centres are strained: applying this map to vertices would deform the unit pieces. */
export function collectiveTrial(
  config: PackingConfig,
  container: Container,
  kind: CollectiveKind,
  amplitude: number,
  angle: number,
  halfWidth = Math.PI / 2,
): PackingConfig {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const along = 1 - amplitude;
  // det(A)=1 exactly in real arithmetic; this is a compensating transverse dilation.
  const across = kind === "balanced" ? 1 / along : 1;
  return {
    ...config,
    pieces: config.pieces.map((p) => {
      const x = p.x - container.cx;
      const y = p.y - container.cy;
      const a = x * ux + y * uy;
      const b = -x * uy + y * ux;
      if (kind === "sector" && a < Math.hypot(x, y) * Math.cos(halfWidth)) return { ...p };
      if (kind === "radial" || kind === "sector")
        return { ...p, x: container.cx + along * x, y: container.cy + along * y };
      return {
        ...p,
        x: container.cx + along * a * ux - across * b * uy,
        y: container.cy + along * a * uy + across * b * ux,
      };
    }),
  };
}

/** Explicit container trials are never re-enclosed or silently enlarged on acceptance. */
export class AscState {
  private grid: CellGrid;

  constructor(
    public config: PackingConfig,
    public container: Container,
  ) {
    this.config = { ...config, container_phi: container.phi };
    this.grid = new CellGrid(config.N, config.pieces);
  }

  move(i: number, p: Pose): boolean {
    const old = this.config.pieces[i];
    if (p.x === old.x && p.y === old.y && p.theta === old.theta) return false;
    if (
      ![p.x, p.y, p.theta].every(Number.isFinite) ||
      Math.abs(p.x) > MAX_COORD ||
      Math.abs(p.y) > MAX_COORD ||
      !fullyContained(this.config.N, p, this.container) ||
      !this.grid.clear(i, p)
    )
      return false;
    this.grid.move(i, p);
    return true;
  }

  replace(config: PackingConfig, container: Container, temperature: number, random: () => number): boolean {
    if (
      ![container.cx, container.cy, container.phi, container.size].every(Number.isFinite) ||
      !feasible(config, container) ||
      !config.pieces.every((p) => fullyContained(config.N, p, container)) ||
      !acceptSize(this.container.size, container.size, temperature, random)
    )
      return false;
    this.config = { ...config, container_phi: container.phi };
    this.container = container;
    this.grid = new CellGrid(config.N, config.pieces);
    return true;
  }
}

/** The public configuration omits explicit size and centre; those are not new assessments. */
export function configurationKey(config: PackingConfig): string {
  return JSON.stringify([config.container_phi, config.pieces.map((p) => [p.x, p.y, p.theta])]);
}
