import { PackingConfig, parseConfig } from "@polypack/geometry";

/**
 * Units of what the main board saves (localStorage), exports and shares. Before 2026-10-27 disks had radius 1, so a board
 * with disk pieces (N = 0) saved then has its centres twice as far apart as the same board now. A board's container is
 * derived from its pieces, so the centres are all there is to convert: x and y of disk pieces times 1/2 (exact in
 * binary64; polygon pieces, with side 1 in both, are unchanged). The same factors as apps/server/src/units-migration.ts.
 */
export const BOARD_UNITS = "diameter";

/** A board of the radius-1 disks as the board's current units. Polygon boards are returned as they are. */
export function boardFromOldUnits(c: PackingConfig): PackingConfig {
  if (c.N !== 0) return c;
  return { ...c, pieces: c.pieces.map((p) => ({ ...p, x: p.x * 0.5, y: p.y * 0.5 })) };
}

/** What the board stores or exports: its configuration with the units tag. */
export function taggedBoard(c: PackingConfig): PackingConfig & { units: string } {
  return { ...c, units: BOARD_UNITS };
}

/** A stored or exported board (parsed JSON): untagged ones are from the old units and are converted once. */
export function readStoredBoard(json: unknown): ReturnType<typeof parseConfig> {
  const r = parseConfig(json);
  if (!r.ok) return r;
  const tag = typeof json === "object" && json !== null ? (json as { units?: unknown }).units : undefined;
  return tag === BOARD_UNITS ? r : { ok: true, config: boardFromOldUnits(r.config) };
}
