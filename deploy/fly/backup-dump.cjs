// Streams one consistent snapshot of a SQLite database to stdout, gzipped, without writing
// anything to disk. backup-to-mac.sh sends this file to the server and runs it there, and
// backup-rebuild.mjs turns the stream back into a database on the Mac.
//
// Everything is read inside a single read transaction. In WAL mode that transaction sees the
// database as it was when it began, while the server goes on writing.
//
// The stream is newline-delimited JSON, in this order:
//   {"format":"polypack-dump","version":1,"created_at":…,"schema":[…]}   the sqlite_master entries
//   {"table":name,"columns":[…]}, then one JSON array per row             for every table
//   {"sequence":[[table, seq], …]}                                       AUTOINCREMENT counters
//   {"end":true,"rows":{table: count, …}}                                absent if the stream broke
//
// Values must come back exactly as stored, so integers are read as BigInt and plain JSON numbers
// mean integers. Reals that JSON would blur are wrapped in {"$r": …}: integral ones (1.0 vs 1),
// -0 and ±Infinity. Integers outside ±2^53 become {"$i": "…"} and BLOBs {"$b": base64}.
//
// Settings: POLYPACK_DB (default /data/polypack.sqlite) and POLYPACK_DUMP_LEVEL (gzip level 0–9,
// default 1, so that compression costs the shared CPU little).
"use strict";
const { DatabaseSync } = require("node:sqlite");
const { once } = require("node:events");
const zlib = require("node:zlib");

const path = process.env.POLYPACK_DB || "/data/polypack.sqlite";
const level = Number(process.env.POLYPACK_DUMP_LEVEL ?? 1);

function enc(v) {
  if (v === null) return null;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : { $i: v.toString() };
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return { $r: String(v) };
    if (Object.is(v, -0)) return { $r: "-0" };
    return Number.isInteger(v) ? { $r: v } : v;
  }
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return { $b: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
  throw new Error(`cannot encode ${typeof v}`);
}

async function main() {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 30000");
  const gz = zlib.createGzip({ level });
  gz.pipe(process.stdout);
  const put = async (obj) => {
    if (!gz.write(JSON.stringify(obj) + "\n")) await once(gz, "drain");
  };

  // The read transaction begins at the first read below; everything after sees that snapshot.
  db.exec("BEGIN");
  const schema = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
    .all();
  await put({ format: "polypack-dump", version: 1, created_at: new Date().toISOString(), schema });

  const rows = {};
  for (const { name } of schema.filter((s) => s.type === "table")) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const columns = db
      .prepare(`PRAGMA table_info(${quoted})`)
      .all()
      .map((c) => c.name);
    await put({ table: name, columns });
    const select = db.prepare(`SELECT * FROM ${quoted} ORDER BY rowid`);
    select.setReadBigInts(true);
    let n = 0;
    for (const row of select.iterate()) {
      await put(columns.map((c) => enc(row[c])));
      n++;
    }
    rows[name] = n;
  }
  const hasSequence = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get();
  const sequence = hasSequence
    ? db
        .prepare("SELECT name, seq FROM sqlite_sequence")
        .all()
        .map((r) => [r.name, r.seq])
    : [];
  await put({ sequence });
  db.exec("COMMIT");
  db.close();
  await put({ end: true, rows });
  // pipe() never ends process.stdout; the pending writes keep the process alive until flushed
  const flushed = once(gz, "end");
  gz.end();
  await flushed;
  process.stderr.write(`dumped ${JSON.stringify(rows)}\n`);
}

main().catch((e) => {
  process.stderr.write(`dump failed: ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
