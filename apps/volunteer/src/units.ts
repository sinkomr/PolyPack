/**
 * The unit change of 2026-10-27, as the client needs it for its own saved state: disk pieces (N = 0) and ball pieces have
 * DIAMETER 1 (they had radius 1), and a circle container (M = 0) and a ball container are scored by their DIAMETER (they were
 * scored by their radius). A problem of the change is the old one scaled by 1/2 and, where the container went from radius to
 * diameter, its score then doubled; every factor is a power of two, so a conversion is exact. The server holds the same rules
 * for its database (apps/server/src/units-migration.ts; a test compares the two).
 */
import { type SpaceName, isSpaceName, parseSpaceId } from "@polypack/spaces";

/** Factors for a flat problem: of the lengths of disk pieces (x, y), and of the score; null when the change left it alone. */
export function planarFactors(N: number, M: number): { len: number; score: number } | null {
  if (N === 0) return { len: 0.5, score: M === 0 ? 1 : 0.5 };
  if (M === 0) return { len: 1, score: 2 };
  return null;
}

/**
 * What the change did to a problem of a space: its score factor, or "set-aside" for a curved disk problem at K other than 0
 * (the old radius-1 disks at K are diameter-1 disks at 4K, a different problem), or null when it did not touch it.
 */
export function spaceScoreFactor(space: string, id: string): number | "set-aside" | null {
  if (!isSpaceName(space)) return null;
  const parsed = parseSpaceId(space as SpaceName, id);
  if (typeof parsed === "string") return null;
  const f = parsed.fields as Record<string, string | number>;
  switch (space) {
    case "surface":
    case "sphere":
    case "torus":
      return f.N === 0 ? 0.5 : null;
    case "boundary":
      return f.piece === "ball" ? 0.5 : null;
    case "balls":
      if (f.piece === "ball") return f.container === "ball" ? 1 : 0.5;
      return f.container === "ball" ? 2 : null;
    case "curved": {
      if (f.N === 0) return f.K !== 0 ? "set-aside" : f.M === 0 ? 1 : 0.5;
      return f.M === 0 ? 2 : null;
    }
    default:
      return null;
  }
}
