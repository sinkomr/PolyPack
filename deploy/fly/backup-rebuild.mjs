// Rebuilds a SQLite database from a stream written by backup-dump.cjs (see its header for the
// format), then checks it. Exits non-zero, leaving no database behind, when the stream is cut
// short, a table's row count differs from the dump's own count, or the check fails.
//   node backup-rebuild.mjs dump.ndjson.gz out.sqlite
// Prints {"rows": {...}, "check": "ok"} on success.
import { createReadStream, rmSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node backup-rebuild.mjs dump.ndjson.gz out.sqlite");
  process.exit(2);
}
if (existsSync(output)) {
  console.error(`${output} exists; refusing to overwrite it`);
  process.exit(2);
}

function dec(v) {
  if (v === null || typeof v === "string") return v;
  // a plain JSON integer is an INTEGER; integral reals are wrapped in $r (see backup-dump.cjs)
  if (typeof v === "number") return Number.isInteger(v) ? BigInt(v) : v;
  if ("$r" in v) return Number(v.$r);
  if ("$i" in v) return BigInt(v.$i);
  if ("$b" in v) return new Uint8Array(Buffer.from(v.$b, "base64"));
  throw new Error(`cannot decode ${JSON.stringify(v)}`);
}

const quote = (name) => `"${name.replaceAll('"', '""')}"`;

async function rebuild() {
  const db = new DatabaseSync(output);
  db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;");
  const lines = createInterface({ input: createReadStream(input).pipe(createGunzip()), crlfDelay: Infinity });
  let schema = null;
  let insert = null;
  let table = null;
  let pending = 0;
  const counted = {};
  let end = null;
  let sequence = [];
  const flush = () => {
    if (pending) db.exec("COMMIT");
    pending = 0;
  };
  for await (const line of lines) {
    if (end) throw new Error("data after the end marker");
    const item = JSON.parse(line);
    if (Array.isArray(item)) {
      if (!insert) throw new Error("a row before its table");
      if (pending === 0) db.exec("BEGIN");
      insert.run(...item.map(dec));
      counted[table]++;
      if (++pending >= 5000) flush();
    } else if (item.format) {
      if (item.format !== "polypack-dump" || item.version !== 1) throw new Error("not a version 1 polypack dump");
      schema = item.schema;
      // tables first; indexes, triggers and views once the rows are in (faster, same result)
      for (const s of schema.filter((s) => s.type === "table")) db.exec(s.sql);
    } else if (item.table !== undefined) {
      flush();
      if (!schema) throw new Error("a table before the header");
      table = item.table;
      counted[table] = 0;
      const cols = item.columns.map(quote).join(", ");
      insert = db.prepare(`INSERT INTO ${quote(table)} (${cols}) VALUES (${item.columns.map(() => "?").join(", ")})`);
    } else if (item.sequence) {
      flush();
      sequence = item.sequence;
    } else if (item.end) {
      flush();
      end = item;
    } else throw new Error(`unexpected line ${line.slice(0, 80)}`);
  }
  if (!end) throw new Error("the dump stops before its end marker (the stream was cut short)");
  for (const [name, n] of Object.entries(end.rows))
    if (counted[name] !== n) throw new Error(`${name}: ${counted[name]} rows rebuilt, the dump counted ${n}`);
  for (const s of schema.filter((s) => s.type !== "table")) db.exec(s.sql);
  if (sequence.length) {
    // AUTOINCREMENT never reuses an id, even of a deleted row; keep its counters
    db.exec("DELETE FROM sqlite_sequence");
    const put = db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)");
    for (const [name, seq] of sequence) put.run(name, seq);
  }
  const check = Object.values(db.prepare("PRAGMA quick_check").get())[0];
  db.close();
  if (check !== "ok") throw new Error(`quick_check: ${check}`);
  return { rows: end.rows, check };
}

rebuild().then(
  (r) => console.log(JSON.stringify(r)),
  (e) => {
    console.error(`rebuild failed: ${e.message}`);
    rmSync(output, { force: true });
    process.exit(1);
  },
);
