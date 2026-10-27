import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  for (let i = 0; i < PAIRS; i++) pair.run(i % 97, i, i % 3 ? i / 7 : `r${i}-${(i * 2654435761 >>> 0).toString(36).repeat(30)}`);
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
    expect(report).toEqual({ rows: { items: 5, pairs: PAIRS }, check: "ok" });
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
});
