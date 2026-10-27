// Shared by import-packomania.ts and attach-packomania-coords.ts: reading a Packomania coordinate
// file and deciding whether its configuration may be stored.
import { Pose, evaluate } from "@polypack/geometry";

/**
 * Largest n whose coordinates are stored, per family. cci goes to the site's cap on P; csq stays
 * where the first import (2026-10-07) stopped, because no csq coordinates beyond it were read.
 */
export const MAX_P_WITH_COORDINATES: Record<string, number> = { cci: 500, csq: 100 };

/**
 * Reads the "index x y ..." lines of a coordinate file. The source normalises the container, so
 * every coordinate is multiplied by `scale` = 1 / (2 circle radius) to give pieces of diameter 1 (site units
 * since 2026-10-27; they had radius 1 and scale 1 / circle radius).
 * Lines that do not start with an index and two decimals (headers, the empty csq1 line) are ignored.
 */
export function readCoordinates(text: string, scale: number): Pose[] {
  const pieces: Pose[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*\d+\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/.exec(line);
    if (m) pieces.push({ x: Number(m[1]) * scale, y: Number(m[2]) * scale, theta: 0 });
  }
  return pieces;
}

/**
 * Coordinates are only kept when this site's own checker accepts them (overlap tolerance 1e-9, the
 * same rule as for a submission) and their own score reproduces the published value to 1e-8.
 * Returns null when they may be stored, otherwise the reason.
 */
export function coordinatesProblem(M: number, P: number, pieces: Pose[], value: number): string | null {
  const e = evaluate({ N: 0, M, P, pieces, container_phi: 0 });
  if (!e.valid) return e.reasons.join("; ");
  if (!(Math.abs(e.score! - value) < 1e-8)) return `score ${e.score} against ${value}`;
  return null;
}
