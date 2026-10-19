/**
 * Measures the storage diet of the server's database on a synthetic copy: how many bytes a row
 * takes before and after the pieces migration (JSON text to BLOBs, and only the leader of each
 * problem kept), and how long each migration step takes on this machine.
 *
 *   npx tsx scripts/measure-storage.ts                 1000 problems, three entries each
 *   npx tsx scripts/measure-storage.ts --problems 3000 --batch 100
 *   npx tsx scripts/measure-storage.ts --keep /tmp/x     also keep the migrated database there
 *
 * The database is written as the server wrote it before the migration: the deployed schema,
 * pieces as JSON text with full-precision doubles, three entries per problem with P drawn from
 * 50 to 500 (about 20 kB per row, as on the live server), rows of a problem scattered over the
 * ids as submissions arrive, and a few pending claims and rejected rows. Nothing else is touched.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { seededRandom } from "@polypack/solver";
import { SqliteStore } from "../apps/server/src/sqlite-store";

const { values: opts } = parseArgs({
  options: {
    problems: { type: "string", default: "1000" },
    batch: { type: "string", default: "100" },
    seed: { type: "string", default: "1" },
    keep: { type: "string" },
  },
});
const problems = Number(opts.problems);
const batch = Number(opts.batch);
const random = seededRandom(Number(opts.seed));

const dir = mkdtempSync(join(tmpdir(), "polypack-storage-"));
const path = opts.keep ? join(opts.keep, "polypack.sqlite") : join(dir, "polypack.sqlite");
const db = new DatabaseSync(path);
db.exec(`PRAGMA journal_mode = WAL;
  CREATE TABLE submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL, m INTEGER NOT NULL,
    p INTEGER NOT NULL, score REAL NOT NULL, name TEXT NOT NULL, agent TEXT NOT NULL DEFAULT '',
    agent_note TEXT NOT NULL, pieces TEXT NOT NULL, container_phi REAL NOT NULL, created_at TEXT NOT NULL,
    verification TEXT NOT NULL DEFAULT 'none', literature_value REAL, strict_check TEXT, found_with TEXT,
    method TEXT, method_params TEXT, seed INTEGER, budget TEXT, software TEXT);
  CREATE INDEX submissions_verification ON submissions (verification);
  CREATE INDEX submissions_listing
    ON submissions (n, m, p, score, id, verification, name, found_with, agent_note, created_at);
  CREATE TABLE tallies (n INTEGER NOT NULL, m INTEGER NOT NULL, p INTEGER NOT NULL, accepted INTEGER NOT NULL,
    PRIMARY KEY (n, m, p));`);

// Three entries per problem, shuffled so that the rows of one problem lie far apart.
const shapes = [0, ...Array.from({ length: 18 }, (_, i) => i + 3)];
const rows: { n: number; m: number; p: number; score: number; verification: string }[] = [];
const seen = new Set<string>();
while (seen.size < problems) {
  const n = shapes[Math.floor(random() * shapes.length)];
  const m = shapes[Math.floor(random() * shapes.length)];
  const p = 50 + Math.floor(random() * 451);
  const key = `${n}/${m}/${p}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const base = Math.sqrt(p) * (2 + random());
  for (let k = 0; k < 3; k++) {
    const u = random();
    // about 1% of entries are pending claims and 1% were rejected
    const verification = u < 0.01 ? "pending" : u < 0.02 ? "rejected" : "none";
    rows.push({ n, m, p, score: base * (1 + 0.01 * random()), verification });
  }
}
for (let i = rows.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [rows[i], rows[j]] = [rows[j], rows[i]];
}
const add = db.prepare(
  `INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at, verification,
     found_with, method, method_params, seed, budget)
   VALUES (?, ?, ?, ?, 'PolyPack optimizer', '', ?, ?, ?, ?, 'optimizer', 'basin_hopping', ?, ?, '{"evals":20000,"time_s":15}')`,
);
const params = JSON.stringify({ iterations: 200, stepScale: 0.25, temperature: 0.01, operators: ["shift", "swap"] });
db.exec("BEGIN");
for (const r of rows) {
  const side = r.score;
  const pieces = Array.from({ length: r.p }, () => ({
    x: (random() - 0.5) * side,
    y: (random() - 0.5) * side,
    theta: random() * 2 * Math.PI,
  }));
  add.run(
    r.n,
    r.m,
    r.p,
    r.score,
    JSON.stringify(pieces),
    random(),
    new Date(Date.UTC(2026, 9, 12) + random() * 6 * 86400e3).toISOString(),
    r.verification,
    params,
    Math.floor(random() * 2 ** 32),
  );
}
db.exec("COMMIT");
db.exec("INSERT INTO tallies SELECT n, m, p, COUNT(*) FROM submissions GROUP BY n, m, p");
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

/** Bytes of the pages in use (the file without its free pages), the free pages, and the rows. */
function space(label: string) {
  const one = (sql: string) => Object.values(db.prepare(sql).get() as Record<string, number>)[0];
  const pageSize = one("PRAGMA page_size");
  const pages = one("PRAGMA page_count");
  const free = one("PRAGMA freelist_count");
  const count = one("SELECT COUNT(*) FROM submissions");
  const pieces = one("SELECT SUM(octet_length(pieces)) FROM submissions");
  const used = (pages - free) * pageSize;
  console.log(
    `${label}: ${count} rows; file ${(statSync(path).size / 1e6).toFixed(1)} MB, in use ${(used / 1e6).toFixed(1)} MB, ` +
      `free ${((free * pageSize) / 1e6).toFixed(1)} MB; pieces ${(pieces / 1e6).toFixed(1)} MB ` +
      `(${(pieces / count / 1e3).toFixed(2)} kB a row); in use per row ${(used / count / 1e3).toFixed(2)} kB`,
  );
  return { used, count };
}
const pieceBytes = db.prepare("SELECT SUM(octet_length(pieces)) AS b, SUM(p) AS n FROM submissions").get() as {
  b: number;
  n: number;
};
console.log(`JSON pieces: ${(pieceBytes.b / pieceBytes.n).toFixed(1)} bytes per piece`);
const before = space("before");

const store = new SqliteStore(path);
const times: number[] = [];
const total = { converted: 0, deleted: 0, rows: 0 };
for (;;) {
  const t = performance.now();
  const step = store.migratePieces(batch);
  if (step.done) break;
  times.push(performance.now() - t);
  total.converted += step.converted;
  total.deleted += step.deleted;
  total.rows += step.rows;
}
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const after = space("after");
times.sort((a, b) => a - b);
const at = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(1);
console.log(
  `migration: ${times.length} steps of ${batch} rows; ${total.converted} converted, ${total.deleted} deleted; ` +
    `ms per step: median ${at(0.5)}, 90th percentile ${at(0.9)}, max ${at(1)}, total ${times.reduce((a, b) => a + b, 0).toFixed(0)}`,
);
console.log(
  `in use per row of the original database: ${(before.used / before.count / 1e3).toFixed(2)} kB before, ` +
    `${(after.used / before.count / 1e3).toFixed(2)} kB after (${((100 * after.used) / before.used).toFixed(1)}%)`,
);
const compact = join(dir, "compact.sqlite");
db.prepare("VACUUM INTO ?").run(compact);
console.log(`after VACUUM: ${(statSync(compact).size / 1e6).toFixed(1)} MB`);
db.close();
rmSync(dir, { recursive: true, force: true });
