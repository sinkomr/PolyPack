// Shape paths of soft-to-rigid hardening, after Yohei Nakajima
// (https://github.com/yoheinakajima/soft-to-rigid, MIT licence; engine/engine2d.js, paper Section "Method").
import { boundingRadius, inradius, pieceArea } from "@polypack/geometry";

export const HARDEN_PATHS = ["harden", "grow", "rigid", "snap", "grow-area"] as const;
export type HardenPath = (typeof HARDEN_PATHS)[number];

/** A point of the reference's shape family: piece(gamma, tau) = gamma * [(1 - tau) P (+) tau rho D]. */
export interface ShapeState {
  /** Overall scale of the piece. */
  gamma: number;
  /** Softness: 1 is the inscribed disk, 0 the true polygon. Always 0 for circle pieces. */
  tau: number;
}

/** The same shape in the shared penalty geometry's terms: a scaled core dilated by a disk. */
export interface SoftShape extends ShapeState {
  /** Core scale gamma (1 - tau) about the piece centre; gamma for circle pieces. */
  scale: number;
  /** Disk radius gamma tau rho added to the core; 0 for circle pieces, whose diameter is the scale. */
  padding: number;
}

export interface PathOptions {
  tau0: number;
  gamma0: number;
}

/**
 * Shape state at progress u in [0, 1] of the middle phase. Compression holds u = 0 and settling
 * u = 1. Every path ends at exactly (gamma, tau) = (1, 0), the true piece: the endpoint is
 * returned literally so rounding in a schedule cannot leave a slightly soft or small piece.
 *
 * A circle piece has no softer state inside it (its inscribed disk is itself), so harden, snap
 * and grow-area all reduce to the rigid path for N = 0; only grow changes a circle.
 */
export function pathShape(path: HardenPath, u: number, N: number, options: PathOptions): ShapeState {
  if (u >= 1 || path === "rigid") return { gamma: 1, tau: 0 };
  const progress = Math.max(0, u);
  if (path === "grow") return { gamma: options.gamma0 + (1 - options.gamma0) * progress, tau: 0 };
  if (N === 0) return { gamma: 1, tau: 0 };
  if (path === "harden") return { gamma: 1, tau: options.tau0 * (1 - progress) };
  // snap: inscribed disks through compression and the first path step, then the polygon at once.
  if (path === "snap") return { gamma: 1, tau: progress === 0 ? 1 : 0 };
  // grow-area: a rigid polygon whose area follows hardening's area schedule
  // A(tau) = A - (A - pi rho^2) tau^2 with tau = 1 - u.
  const rho = inradius(N);
  const diskShare = (Math.PI * rho * rho) / pieceArea(N);
  const t = 1 - progress;
  return { gamma: Math.sqrt(1 - (1 - diskShare) * t * t), tau: 0 };
}

/** Core scale and disk padding of a shape state; a circle piece is a disk of diameter gamma. */
export function softShape(N: number, state: ShapeState): SoftShape {
  if (N === 0) return { gamma: state.gamma, tau: 0, scale: state.gamma, padding: 0 };
  return {
    gamma: state.gamma,
    tau: state.tau,
    scale: state.gamma * (1 - state.tau),
    padding: state.gamma * state.tau * inradius(N),
  };
}

/** Largest distance from the piece centre to a point of the soft piece. */
export function shapeReach(N: number, shape: SoftShape): number {
  return shape.scale * boundingRadius(N) + shape.padding;
}

/** Area of a shape state; at gamma = 1 this is A - (A - pi rho^2) tau^2. */
export function shapeArea(N: number, state: ShapeState): number {
  if (N === 0) return pieceArea(0) * state.gamma * state.gamma;
  const rho = inradius(N);
  const area = pieceArea(N);
  return state.gamma * state.gamma * (area - (area - Math.PI * rho * rho) * state.tau * state.tau);
}
