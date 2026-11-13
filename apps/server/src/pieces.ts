import { constants, crc32, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { Pose } from "@polypack/geometry";

/**
 * How the `pieces` column stores an arrangement. SQLite keeps a BLOB exactly as given, also in a
 * column declared TEXT, so the three forms live side by side in the same column:
 *  - BLOB whose length is a multiple of 24, the triples: little-endian Float64 [x, y, theta] per
 *    piece, 24 bytes each (the format written since 2026-10-18). Every double comes back bit for
 *    bit, -0 included;
 *  - BLOB of any other length, the packed form (written since 2026-11-14, see packPieces): the
 *    triples compressed without loss, to a little over half on the entries of November 2026;
 *  - TEXT holding a JSON array of {x, y, theta}: the oldest format (about 73 bytes per piece).
 * All three are read. The background migration (see SqliteStore.migratePieces) packs the first and
 * the last.
 */
export const PIECE_BYTES = 24;

/**
 * The packed form: a tag byte, the length of the triples and their CRC-32 (little-endian Uint32s),
 * one zstd frame of the doubles regrouped (every x, then every y, then every theta; like values
 * side by side compress better), and for tag 2 one zero byte. The writer takes tag 2 exactly when
 * tag 1 would give a length that is a multiple of 24, so the length alone tells a packed value
 * from triples, whatever the doubles are.
 *
 * A packed value is read only when it is exactly that: one whole frame and nothing else, which
 * unpacks to the length written and to triples of the CRC-32 written. A value cut short or damaged
 * on disk is then refused instead of read as other pieces, and by the same rule in every
 * implementation (zstd libraries differ in what they make of a frame that is cut or followed by
 * other bytes, hence frameLength below).
 */
const PACKED = 1;
const PACKED_PADDED = 2;
/** zstd's own default; level 6 gives 1 % more on real entries for twice the time (docs/DEPLOY_FLY.md). */
const ZSTD_LEVEL = 3;
/** The most a packed value may unpack to, so that a damaged row cannot ask for the memory of the machine. */
const UNPACKED_LIMIT = 1 << 24;

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

/** The doubles of triples moved to the grouped order (every x, every y, every theta), or back. */
function regroup(from: Uint8Array, toTriples: boolean): Uint8Array {
  const count = from.length / PIECE_BYTES;
  const to = new Uint8Array(from.length);
  for (let piece = 0; piece < count; piece++)
    for (let field = 0; field < 3; field++) {
      const triple = piece * PIECE_BYTES + field * 8;
      const grouped = (field * count + piece) * 8;
      const [source, target] = toTriples ? [grouped, triple] : [triple, grouped];
      to.set(from.subarray(source, source + 8), target);
    }
  return to;
}

/** Bytes of a packed value before its frame: the tag, the length of the triples and their CRC-32. */
const PACKED_HEAD = 9;

/**
 * The value to store for triples (see encodePieces): the packed form when that is shorter, and
 * the triples themselves when it is not (a few pieces with nothing in common).
 */
export function packPieces(triples: Uint8Array): Uint8Array {
  if (triples.length % PIECE_BYTES !== 0)
    throw new RangeError(`pieces to pack have ${triples.length} bytes, not a multiple of ${PIECE_BYTES}`);
  if (triples.length === 0 || triples.length > UNPACKED_LIMIT) return triples;
  const frame = zstdCompressSync(regroup(triples, false), {
    params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
  });
  const padded = (PACKED_HEAD + frame.length) % PIECE_BYTES === 0;
  const length = PACKED_HEAD + frame.length + (padded ? 1 : 0);
  if (length >= triples.length) return triples;
  const packed = new Uint8Array(length); // zeros: the last byte of the padded form
  const view = new DataView(packed.buffer);
  packed[0] = padded ? PACKED_PADDED : PACKED;
  view.setUint32(1, triples.length, true);
  view.setUint32(5, crc32(triples), true);
  packed.set(frame, PACKED_HEAD);
  return packed;
}

/**
 * The length of the zstd frame that `bytes` begins with, from its header and the headers of its
 * blocks (RFC 8878, section 3.1.1), or -1 when they do not describe a frame that ends within
 * `bytes`. Skippable frames and dictionaries, which packPieces never writes, are not frames here.
 */
function frameLength(bytes: Uint8Array): number {
  if (bytes.length < 6 || bytes[0] !== 0x28 || bytes[1] !== 0xb5 || bytes[2] !== 0x2f || bytes[3] !== 0xfd) return -1;
  const descriptor = bytes[4];
  const singleSegment = (descriptor >> 5) & 1;
  if (descriptor & 0x0b) return -1; // a reserved bit, or a dictionary
  const contentSize = [singleSegment, 2, 4, 8][descriptor >> 6];
  let at = 5 + (1 - singleSegment) + contentSize;
  for (;;) {
    if (at + 3 > bytes.length) return -1;
    const header = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
    const type = (header >> 1) & 3;
    if (type === 3) return -1;
    // a run-length block holds one byte, whatever size it unpacks to
    at += 3 + (type === 1 ? 1 : header >> 3);
    if (header & 1) break;
  }
  at += descriptor & 4; // the four bytes of a content checksum
  return at <= bytes.length ? at : -1;
}

/** The triples of a stored BLOB in either form. */
export function unpackPieces(bytes: Uint8Array): Uint8Array {
  if (bytes.length % PIECE_BYTES === 0) return bytes;
  const tag = bytes[0];
  if (tag !== PACKED && tag !== PACKED_PADDED)
    throw new RangeError(
      `stored pieces have ${bytes.length} bytes, not a multiple of ${PIECE_BYTES}, and are not packed (they begin with ${tag})`,
    );
  const refuse = () => new RangeError(`stored pieces of ${bytes.length} bytes cannot be unpacked`);
  const end = bytes.length - (tag === PACKED_PADDED ? 1 : 0);
  if (end <= PACKED_HEAD || (tag === PACKED_PADDED && bytes[end] !== 0)) throw refuse();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const length = view.getUint32(1, true);
  if (length === 0 || length % PIECE_BYTES !== 0 || length > UNPACKED_LIMIT) throw refuse();
  const frame = bytes.subarray(PACKED_HEAD, end);
  if (frameLength(frame) !== frame.length) throw refuse();
  let grouped: Uint8Array;
  try {
    // one byte more than expected is allowed out, so that a frame holding more is seen below
    grouped = zstdDecompressSync(frame, { maxOutputLength: length + 1 });
  } catch {
    throw refuse();
  }
  if (grouped.length !== length) throw refuse();
  const triples = regroup(grouped, true);
  if (crc32(triples) !== view.getUint32(5, true)) throw refuse();
  return triples;
}

/** The arrangement held by a stored BLOB in either form. */
export function decodePieces(stored: Uint8Array): Pose[] {
  const bytes = unpackPieces(stored);
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

/** The arrangement held by a `pieces` value in any form. */
export function readPieces(value: unknown): Pose[] {
  if (value instanceof Uint8Array) return decodePieces(value);
  if (typeof value === "string") return JSON.parse(value) as Pose[];
  throw new TypeError(`unexpected stored pieces of type ${typeof value}`);
}

/**
 * The triples for a value in the oldest, JSON format, or null when the text is not exactly a list of
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
