// Streams a copy of a SQLite database to stdout, gzipped, without writing anything to disk and
// without holding a long read. backup-to-mac.sh sends this file to the server and runs it there,
// and backup-rebuild.mjs turns the stream back into a database on the Mac.
//
// A read transaction keeps SQLite's write-ahead log from being emptied for as long as it lasts, so
// one read of the whole database lets the log grow by everything the server writes meanwhile.
// Here no read lasts longer than one chunk:
//   1. The tables whose ids are never reused (AUTOINCREMENT: the entries) are read in rowid order,
//      a chunk of rows per read, with the server writing in between.
//   2. One last read transaction takes, for each of those tables, the rows added since its last
//      chunk and the rowids it holds now, and every other table whole.
// The rebuild drops the rows that step 1 read and that were deleted before step 2. What it leaves
// is the database as it was at step 2, with one exception: a row of a chunked table that was
// changed in place (not replaced) after its chunk was read is as it was when read. The server
// replaces entries and counts in the other tables; only a moderator's edit, a verification
// decision or a start-up migration changes an entry in place.
//
// Why that is exact: an AUTOINCREMENT rowid is larger than every earlier one, so a row added
// after a chunk was read lies beyond that chunk and is read later, and a row present at step 2
// was either read by an earlier chunk or lies beyond the last one.
//
// The stream is newline-delimited JSON, in this order:
//   {"format":"polypack-dump","version":2,"created_at":…,"schema":[…]}   the sqlite_master entries
//   {"table":name,"columns":[…]}, then one JSON array per row             a table may come twice
//   {"present":name,"rowids":[…]}                                        step 2, in several lines
//   {"sequence":[[table, seq], …]}                                       AUTOINCREMENT counters
//   {"end":true,"as_of":…,"rows":{table: count, …}}                      absent if the stream broke
//
// Values must come back exactly as stored, so integers are read as BigInt and plain JSON numbers
// mean integers. Reals that JSON would blur are wrapped in {"$r": …}: integral ones (1.0 vs 1),
// -0 and ±Infinity. Integers outside ±2^53 become {"$i": "…"} and BLOBs {"$b": base64}.
//
// Settings: POLYPACK_DB (default /data/polypack.sqlite), POLYPACK_DUMP_LEVEL (gzip level 0–9,
// default 1, so that compression costs the shared CPU little) and POLYPACK_DUMP_CHUNK (rows per
// read, default 1000).
"use strict";
const { DatabaseSync } = require("node:sqlite");
const { once } = require("node:events");
const zlib = require("node:zlib");

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

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const PRESENT_PER_LINE = 10000;

// Writes the dump of the database at `path` to the stream `out`. Returns the row counts, the
// number of chunks read and how long the last read transaction (step 2) was open, in seconds.
// `between(table)` is called after each chunk, outside any read (the tests write there).
async function dump({ path, out, level = 1, chunk = 1000, between = () => {} }) {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 30000");
  const gz = zlib.createGzip({ level });
  gz.pipe(out);
  // Lines go to the compressor 64 KiB at a time: a write per line costs a round trip to its thread,
  // which for the millions of short lines of the last read was most of the time that read was open.
  let lines = "";
  const flush = async () => {
    const text = lines;
    lines = "";
    if (text && !gz.write(text)) await once(gz, "drain");
  };
  const put = async (obj) => {
    lines += JSON.stringify(obj) + "\n";
    if (lines.length >= 65536) await flush();
  };
  const bigints = (statement) => (statement.setReadBigInts(true), statement);
  const readSchema = () =>
    db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
      .all();
  const readSequence = () =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()
      ? db.prepare("SELECT name, seq FROM sqlite_sequence").all()
      : [];
  const columnsOf = (name) =>
    db
      .prepare(`PRAGMA table_info(${quote(name)})`)
      .all()
      .map((c) => c.name);

  const schema = readSchema();
  await put({ format: "polypack-dump", version: 2, created_at: new Date().toISOString(), schema });
  const tables = schema.filter((s) => s.type === "table").map((s) => s.name);
  // a table has a counter in sqlite_sequence once an AUTOINCREMENT id was given out in it
  const counters = new Set(readSequence().map((r) => r.name));
  const chunked = tables.filter((t) => counters.has(t));

  // Step 1. Every `all` below is one read transaction of its own: it ends before the rows are sent.
  const last = {};
  let chunks = 0;
  for (const name of chunked) {
    const columns = columnsOf(name);
    await put({ table: name, columns });
    const from = `SELECT rowid AS "_dump_rowid", * FROM ${quote(name)}`;
    const first = bigints(db.prepare(`${from} ORDER BY rowid LIMIT ?`));
    const next = bigints(db.prepare(`${from} WHERE rowid > ? ORDER BY rowid LIMIT ?`));
    for (;;) {
      const rows = name in last ? next.all(last[name], chunk) : first.all(chunk);
      for (const row of rows) await put(columns.map((c) => enc(row[c])));
      if (rows.length) last[name] = rows[rows.length - 1]._dump_rowid;
      chunks++;
      await between(name);
      if (rows.length < chunk) break;
    }
  }

  // Step 2. One read transaction, which begins at its first read.
  const began = process.hrtime.bigint();
  db.exec("BEGIN");
  if (JSON.stringify(readSchema()) !== JSON.stringify(schema)) throw new Error("the schema changed during the dump");
  const counts = {};
  for (const name of tables) {
    const columns = columnsOf(name);
    await put({ table: name, columns });
    const isChunked = chunked.includes(name);
    const tail = isChunked && name in last;
    const select = bigints(db.prepare(`SELECT * FROM ${quote(name)} ${tail ? "WHERE rowid > ?" : ""} ORDER BY rowid`));
    let n = 0;
    for (const row of tail ? select.iterate(last[name]) : select.iterate()) {
      await put(columns.map((c) => enc(row[c])));
      n++;
    }
    if (!isChunked) {
      counts[name] = n;
      continue;
    }
    // no ORDER BY: SQLite may then read the rowids from the table's smallest index
    let rowids = [];
    n = 0;
    for (const row of bigints(db.prepare(`SELECT rowid AS r FROM ${quote(name)}`)).iterate()) {
      rowids.push(enc(row.r));
      n++;
      if (rowids.length === PRESENT_PER_LINE) {
        await put({ present: name, rowids });
        rowids = [];
      }
    }
    await put({ present: name, rowids });
    counts[name] = n;
  }
  await put({ sequence: readSequence().map((r) => [r.name, r.seq]) });
  db.exec("COMMIT");
  const last_read_s = Number(process.hrtime.bigint() - began) / 1e9;
  db.close();
  await put({ end: true, as_of: new Date().toISOString(), rows: counts });
  await flush();
  // pipe() never ends process.stdout; the pending writes keep the process alive until flushed
  const flushed = once(gz, "end");
  gz.end();
  await flushed;
  return { rows: counts, chunks, last_read_s };
}

module.exports = { dump };

// Run as a script: `node backup-dump.cjs`, or piped into `node -`, where this module is "[stdin]".
if (require.main === module || module.id === "[stdin]") {
  dump({
    path: process.env.POLYPACK_DB || "/data/polypack.sqlite",
    out: process.stdout,
    level: Number(process.env.POLYPACK_DUMP_LEVEL ?? 1),
    chunk: Math.max(1, Math.floor(Number(process.env.POLYPACK_DUMP_CHUNK ?? 1000)) || 1000),
  }).then(
    (r) =>
      process.stderr.write(
        `dumped ${JSON.stringify(r.rows)}; chunks read: ${r.chunks}; the last read was open for ${r.last_read_s.toFixed(1)} s\n`,
      ),
    (e) => {
      process.stderr.write(`dump failed: ${e && e.stack ? e.stack : e}\n`);
      process.exit(1);
    },
  );
}
