import { execFileSync, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { finished } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// deploy/fly/backup-dump.cjs streams a database; deploy/fly/backup-rebuild.mjs rebuilds it.
const dump = resolve(__dirname, "../../deploy/fly/backup-dump.cjs");
const rebuild = resolve(__dirname, "../../deploy/fly/backup-rebuild.mjs");

let dir = "";
let src = "";
let stream: Buffer;
afterAll(() => dir && rmSync(dir, { recursive: true, force: true }));

function everything(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string; sql: string }[];
  const out: Record<string, unknown> = {
    schema: db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),
    sequence: db.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all(),
  };
  for (const t of tables) {
    const s = db.prepare(`SELECT rowid AS _r, *, typeof(v) AS _t FROM "${t.name}" ORDER BY rowid`);
    s.setReadBigInts(true);
    out[t.name] = s.all();
  }
  db.close();
  return out;
}

const PAIRS = 1000;

function sample(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, v, score REAL, note TEXT, data BLOB);
    CREATE INDEX items_score ON items (score, id);
    CREATE TABLE pairs (a INTEGER NOT NULL, b INTEGER NOT NULL, v, PRIMARY KEY (a, b));
  `);
  const put = db.prepare("INSERT INTO items (v, score, note, data) VALUES (?, ?, ?, ?)");
  const f64 = new Uint8Array(new Float64Array([-0, 1e6, Math.PI, -1e-300]).buffer);
  put.run(1.0, 2.0000000000000004, "plain", f64);
  put.run(-0, -0, "négatif ∅ 🧩", new Uint8Array(0));
  put.run(9007199254740993n, 1e308, null, null);
  put.run("text", Infinity, '{"x":1}', new Uint8Array([0, 10, 13, 255]));
  put.run(null, -Infinity, "", null);
  put.run(42n, 0.1, "the last row, deleted below", null);
  db.exec("DELETE FROM items WHERE id = 6");
  const pair = db.prepare("INSERT INTO pairs VALUES (?, ?, ?)");
  // one transaction (a commit per row is what made this slow). A thousand rows of long values give a stream of
  // well over 64 KiB, so that both the compressed file and the decompressed lines reach the rebuild in many chunks
  db.exec("BEGIN");
  for (let i = 0; i < PAIRS; i++)
    pair.run(i % 97, i, i % 3 ? i / 7 : `r${i}-${((i * 2654435761) >>> 0).toString(36).repeat(30)}`);
  db.exec("COMMIT");
  db.close();
}

describe("streaming backup", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "polypack-backup-"));
    src = join(dir, "src.sqlite");
    sample(src);
    stream = execFileSync(process.execPath, [dump], { env: { ...process.env, POLYPACK_DB: src }, maxBuffer: 1 << 28 });
    writeFileSync(join(dir, "dump.gz"), stream);
  });

  it("rebuilds a database exactly, values, types, schema and AUTOINCREMENT counters included", () => {
    // the stream crosses several chunks of the readers (16 KiB of gunzip output), and the 97 keys of `a` repeat
    expect(gunzipSync(stream).length).toBeGreaterThan(4 * 16384);
    const out = join(dir, "out.sqlite");
    const report = JSON.parse(execFileSync(process.execPath, [rebuild, join(dir, "dump.gz"), out]).toString());
    expect(report).toEqual({ rows: { items: 5, pairs: PAIRS }, superseded: 0, check: "ok" });
    expect(everything(out)).toEqual(everything(src));
    // AUTOINCREMENT goes on from the deleted row 6, as it would on the server
    const db = new DatabaseSync(out);
    db.prepare("INSERT INTO items (v) VALUES (1)").run();
    expect(db.prepare("SELECT MAX(id) AS id FROM items").get()).toEqual({ id: 7 });
    db.close();
  });

  it("refuses a stream that was cut short and leaves no database behind", () => {
    // whole gzip members cut at a line boundary: decompress, drop the end marker, recompress
    const lines = gunzipSync(stream).toString().trimEnd().split("\n");
    writeFileSync(join(dir, "short.gz"), gzipSync(lines.slice(0, -1).join("\n") + "\n"));
    writeFileSync(join(dir, "torn.gz"), stream.subarray(0, Math.floor(stream.length / 2)));
    for (const name of ["short.gz", "torn.gz"]) {
      const out = join(dir, `${name}.sqlite`);
      const r = spawnSync(process.execPath, [rebuild, join(dir, name), out]);
      expect(r.status, name).not.toBe(0);
      expect(existsSync(out), name).toBe(false);
    }
    expect(readFileSync(join(dir, "src.sqlite")).length).toBeGreaterThan(0);
  });

  it("sent as backup-to-mac.sh sends it, piped into node without its comment lines, it dumps the same", () => {
    const code = readFileSync(dump, "utf8")
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    const piped = execFileSync(process.execPath, ["--no-warnings", "-"], {
      input: code,
      env: { ...process.env, POLYPACK_DB: src },
      maxBuffer: 1 << 28,
    });
    const rows = (gz: Buffer) => gunzipSync(gz).toString().split("\n").slice(1, -2);
    expect(rows(piped)).toEqual(rows(stream));
  });
});

// The entries are read a chunk at a time with the server writing in between; the copy must be the database as it
// was at the end, and no read may stay open between two chunks (that is what let the write-ahead log grow).
describe("streaming backup of a database that is written to meanwhile", () => {
  const { dump: dumpTo } = createRequire(import.meta.url)(dump) as {
    dump: (o: {
      path: string;
      out: NodeJS.WritableStream;
      chunk?: number;
      between?: (table: string) => void;
    }) => Promise<{ rows: Record<string, number>; chunks: number; last_read_s: number }>;
  };

  it("leaves no read open between chunks and rebuilds the database as it was at the end", async () => {
    const live = join(dir, "live.sqlite");
    const db = new DatabaseSync(live);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, problem INTEGER NOT NULL, v, data BLOB);
      CREATE INDEX entries_problem ON entries (problem, id);
      CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, v);
      CREATE TABLE counts (problem INTEGER PRIMARY KEY, v INTEGER NOT NULL);
    `);
    const add = db.prepare("INSERT INTO entries (problem, v, data) VALUES (?, ?, ?)");
    const count = db.prepare("INSERT INTO counts VALUES (?, 1) ON CONFLICT (problem) DO UPDATE SET v = v + 1");
    // as the server stores a new leader: the new row, the count, and the problem's other rows gone, in one commit
    const submit = (problem: number, v: number) => {
      db.exec("BEGIN IMMEDIATE");
      const id = add.run(problem, v, new Uint8Array(new Float64Array([v, -0, problem]).buffer)).lastInsertRowid;
      count.run(problem);
      db.prepare("DELETE FROM entries WHERE problem = ? AND id != ?").run(problem, id);
      db.exec("COMMIT");
    };
    for (let problem = 0; problem < 200; problem++) submit(problem, problem / 3);
    db.exec("INSERT INTO notes (v) VALUES ('first')");

    let chunks = 0;
    let step = 0;
    const blocked: number[] = [];
    const out = createWriteStream(join(dir, "live.gz"));
    const { rows, chunks: counted } = await dumpTo({
      path: live,
      out,
      chunk: 16,
      between: (table) => {
        if (table !== "entries") return;
        chunks++;
        // leaders replaced behind the chunks already read and ahead of them, problems that are new, an entry
        // removed outright on each side, and a table that is read whole
        submit((step * 37) % 200, 1000 + step);
        submit(199 - ((step * 53) % 200), 2000 + step);
        submit(200 + step, 3000 + step);
        if (step === 2) db.exec("DELETE FROM entries WHERE problem IN (1, 198)");
        if (step === 3) db.exec("INSERT INTO notes (v) VALUES ('added during the dump')");
        step++;
        // a checkpoint that empties the log is refused while any read transaction is open
        blocked.push(Number((db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number | bigint }).busy));
      },
    });
    await finished(out);
    expect(chunks).toBeGreaterThan(10);
    // the chunks of `entries`, and the one of `notes`
    expect(counted).toBe(chunks + 1);
    expect(blocked.every((busy) => busy === 0)).toBe(true);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();

    const copy = join(dir, "live-copy.sqlite");
    const report = JSON.parse(execFileSync(process.execPath, [rebuild, join(dir, "live.gz"), copy]).toString());
    expect(report.check).toBe("ok");
    expect(report.rows).toEqual(rows);
    // rows that a chunk read and a later submission replaced reached the stream and were dropped again
    expect(report.superseded).toBeGreaterThan(5);
    expect(everything(copy)).toEqual(everything(live));
    const check = new DatabaseSync(copy, { readOnly: true });
    expect(check.prepare("SELECT COUNT(*) AS c, COUNT(DISTINCT problem) AS p FROM entries").get()).toEqual({
      c: rows.entries,
      p: rows.entries,
    });
    check.close();
  });

  it("refuses a stream whose chunks miss a row the table held at the end", () => {
    // the same stream with one row of the chunks taken out: the rowids listed at the end no longer all arrive
    const lines = gunzipSync(readFileSync(join(dir, "live.gz")))
      .toString()
      .trimEnd()
      .split("\n");
    const at = lines.findIndex((line) => line.startsWith("[")) + 3;
    writeFileSync(join(dir, "missing.gz"), gzipSync([...lines.slice(0, at), ...lines.slice(at + 1)].join("\n") + "\n"));
    const out = join(dir, "missing.sqlite");
    const r = spawnSync(process.execPath, [rebuild, join(dir, "missing.gz"), out]);
    expect(r.status).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/rows it held at the end/);
    expect(existsSync(out)).toBe(false);
  });
});
