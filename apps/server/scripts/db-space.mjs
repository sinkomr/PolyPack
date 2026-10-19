// How the server's database file is used, and, on request, giving its free pages back to the disk.
// Plain JavaScript, so that it runs with `node` alone inside the deployed image (see docs/DEPLOY_FLY.md).
//
//   node apps/server/scripts/db-space.mjs [database]            report (JSON); reads only
//   node apps/server/scripts/db-space.mjs [database] --vacuum   VACUUM, then report again
//
// The database defaults to DATABASE_PATH, then /data/polypack.sqlite. SQLite reuses free pages
// for new rows, so the file stops growing once rows are deleted, but it shrinks only by VACUUM.
// VACUUM rewrites the pages in use while the server keeps running: reads go on, but writes
// (submissions) fail until it is done, and it needs free disk for two copies of the pages in use
// (a temporary copy, kept next to the database, and the write-ahead log).
import { existsSync, statSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const vacuum = args.includes("--vacuum");
const path = args.find((a) => !a.startsWith("--")) ?? process.env.DATABASE_PATH ?? "/data/polypack.sqlite";
if (!existsSync(path)) {
  console.error(`no database at ${path}`);
  process.exit(1);
}

const mb = (bytes) => Math.round(bytes / 1e5) / 10;

function report(db) {
  const one = (sql) => Object.values(db.prepare(sql).get() ?? { v: null })[0];
  const pageSize = one("PRAGMA page_size");
  const pages = one("PRAGMA page_count");
  const free = one("PRAGMA freelist_count");
  const hasMeta = !!one("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'meta'");
  const meta = (key) => (hasMeta ? one(`SELECT value FROM meta WHERE key = '${key}'`) : null);
  const disk = statfsSync(dirname(path));
  return {
    file_mb: mb(statSync(path).size),
    wal_mb: existsSync(`${path}-wal`) ? mb(statSync(`${path}-wal`).size) : 0,
    page_size: pageSize,
    page_count: pages,
    freelist_count: free,
    in_use_mb: mb((pages - free) * pageSize),
    free_in_file_mb: mb(free * pageSize),
    disk_free_mb: mb(disk.bavail * disk.bsize),
    rows: one("SELECT COUNT(*) FROM submissions"),
    migration: {
      done: meta("pieces_migrated") === 1,
      cursor: meta("pieces_cursor"),
      last_id: one("SELECT MAX(id) FROM submissions"),
    },
  };
}

// SQLite puts VACUUM's temporary copy in SQLITE_TMPDIR, which it reads once, when the first
// database is opened: next to the database, on the disk whose free space is checked below
if (vacuum) process.env.SQLITE_TMPDIR = dirname(path);
const db = new DatabaseSync(path, { readOnly: !vacuum });
// wait for the server's own short transactions rather than fail at once
db.exec("PRAGMA busy_timeout = 30000");
const before = report(db);
if (!vacuum) {
  console.log(JSON.stringify(before, null, 2));
  process.exit(0);
}
if (!before.migration.done) {
  console.error("the pieces migration has not finished yet (see the server log); VACUUM afterwards");
  process.exit(1);
}
const needed = 2.1 * before.in_use_mb;
if (before.disk_free_mb < needed) {
  console.error(`VACUUM needs about ${needed} MB free on the disk; there are ${before.disk_free_mb}`);
  process.exit(1);
}
const started = Date.now();
db.exec("VACUUM");
// copies the rewritten pages from the log into the file, which is cut to its new size
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
console.log(JSON.stringify({ seconds: (Date.now() - started) / 1000, before, after: report(db) }, null, 2));
db.close();
