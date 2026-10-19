import { Pose } from "@polypack/geometry";

/**
 * How the `pieces` column stores an arrangement. SQLite keeps a BLOB exactly as given, also in a
 * column declared TEXT, so the two forms live side by side in the same column:
 *  - BLOB: little-endian Float64 triples [x, y, theta] per piece, 24 bytes each (the format
 *    written since 2026-10-18). Every double comes back bit for bit, -0 included;
 *  - TEXT holding a JSON array of {x, y, theta}: the older format (about 73 bytes per piece),
 *    still read, and converted by the background migration (see SqliteStore.migratePieces).
 */
export const PIECE_BYTES = 24;

export function encodePieces(pieces: readonly Pose[]): Uint8Array {
  const bytes = new Uint8Array(pieces.length * PIECE_BYTES);
  const view = new DataView(bytes.buffer);
  pieces.forEach((p, i) => {
    view.setFloat64(i * PIECE_BYTES, p.x, true);
    view.setFloat64(i * PIECE_BYTES + 8, p.y, true);
    view.setFloat64(i * PIECE_BYTES + 16, p.theta, true);
  });
  return bytes;
}

export function decodePieces(bytes: Uint8Array): Pose[] {
  if (bytes.length % PIECE_BYTES !== 0)
    throw new RangeError(`stored pieces have ${bytes.length} bytes, not a multiple of ${PIECE_BYTES}`);
  // a DataView, because the driver's buffer need not be aligned for a Float64Array
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const pieces: Pose[] = [];
  for (let at = 0; at < bytes.length; at += PIECE_BYTES)
    pieces.push({
      x: view.getFloat64(at, true),
      y: view.getFloat64(at + 8, true),
      theta: view.getFloat64(at + 16, true),
    });
  return pieces;
}

/** The arrangement held by a `pieces` value in either form. */
export function readPieces(value: unknown): Pose[] {
  if (value instanceof Uint8Array) return decodePieces(value);
  if (typeof value === "string") return JSON.parse(value) as Pose[];
  throw new TypeError(`unexpected stored pieces of type ${typeof value}`);
}

/**
 * The BLOB for a value in the older JSON format, or null when the text is not exactly a list of
 * {x, y, theta} with finite numbers: such a row is left as it is rather than changed by guesswork.
 */
export function blobFromJson(text: string): Uint8Array | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const p of parsed) {
    if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
    const keys = Object.keys(p);
    if (keys.length !== 3 || !["x", "y", "theta"].every((k) => Number.isFinite((p as Record<string, unknown>)[k])))
      return null;
  }
  return encodePieces(parsed as Pose[]);
}
