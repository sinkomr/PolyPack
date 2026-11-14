// The way back from packed pieces: rewrites every packed entry as the Float64 triples that servers
// before 2026-11-14 read, so that such a server can be deployed again (see docs/DEPLOY_FLY.md).
// Plain JavaScript, so that it runs with `node` alone inside the deployed image.
//
//   node apps/server/scripts/pieces-unpack.mjs [database]           count what is packed; reads only
//   node apps/server/scripts/pieces-unpack.mjs [database] --write   unpack, 500 rows per transaction
//
// The database defaults to DATABASE_PATH, then /data/polypack.sqlite. Run it with --write only
// when the older server is the one deployed: the current server packs every new entry, and its
// migration would pack the old ones again. The progress of that migration is cleared here, so a
// later deployment of the current server starts it from the first row.
//
// The packed form is the one of apps/server/src/pieces.ts: a tag (1, or 2 with one zero byte at
// the end), the length of the triples and their CRC-32, and a zstd frame of the doubles grouped as
// every x, every y, every theta. A value that does not unpack to that length and CRC-32 is left
// as it is and counted as unreadable.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { crc32, zstdDecompressSync } from "node:zlib";

const args = process.argv.slice(2);
const write = args.includes("--write");
const path = args.find((a) => !a.startsWith("--")) ?? process.env.DATABASE_PATH ?? "/data/polypack.sqlite";
if (!existsSync(path)) {
  console.error(`no database at ${path}`);
  process.exit(1);
}

/** The triples of a packed value, or null when it is not one. */
function unpack(bytes) {
  const tag = bytes[0];
  if (tag !== 1 && tag !== 2) return null;
  const end = bytes.length - (tag === 2 ? 1 : 0);
  if (end <= 9) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const length = view.getUint32(1, true);
  if (length === 0 || length % 24 !== 0 || length > 1 << 24) return null;
  let grouped;
  try {
    grouped = zstdDecompressSync(bytes.subarray(9, end), { maxOutputLength: length + 1 });
  } catch {
    return null;
  }
  if (grouped.length !== length) return null;
  const count = length / 24;
  const triples = new Uint8Array(length);
  for (let piece = 0; piece < count; piece++)
    for (let field = 0; field < 3; field++) {
      const from = (field * count + piece) * 8;
      triples.set(grouped.subarray(from, from + 8), piece * 24 + field * 8);
    }
  return crc32(triples) === view.getUint32(5, true) ? triples : null;
}

const db = new DatabaseSync(path, { readOnly: !write });
// wait for the server's own short transactions rather than fail at once
db.exec("PRAGMA busy_timeout = 30000");
const total = { rows: 0, packed: 0, unpacked: 0, unreadable: 0, bytes_before: 0, bytes_after: 0 };
// typeof() and octet_length() are answered from the row's header, so this reads no pieces
const page = db.prepare(
  `SELECT id, octet_length(pieces) AS bytes FROM submissions
   WHERE id > ? AND typeof(pieces) = 'blob' ORDER BY id LIMIT 500`,
);
const read = db.prepare("SELECT pieces FROM submissions WHERE id = ?");
const update = write ? db.prepare("UPDATE submissions SET pieces = ? WHERE id = ?") : null;
for (let cursor = 0; ;) {
  const rows = page.all(cursor);
  if (!rows.length) break;
  if (write) db.exec("BEGIN IMMEDIATE");
  for (const r of rows) {
    cursor = r.id;
    total.rows++;
    if (r.bytes % 24 === 0) continue; // triples already
    total.packed++;
    if (!write) continue;
    const held = read.get(r.id)?.pieces;
    const triples = held instanceof Uint8Array ? unpack(held) : null;
    if (!triples) {
      total.unreadable++;
      continue;
    }
    update.run(triples, r.id);
    total.unpacked++;
    total.bytes_before += r.bytes;
    total.bytes_after += triples.length;
  }
  if (write) db.exec("COMMIT");
}
if (write) db.exec("DELETE FROM meta WHERE key IN ('pieces_packed', 'pieces_packed_cursor')");
db.close();
console.log(JSON.stringify(total));
if (total.unreadable) process.exit(1);
