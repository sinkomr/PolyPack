/**
 * The unit change's database conversion (apps/server/src/units-migration.ts) on a database file.
 *
 *   tsx scripts/units-migrate.ts --dry-run <db>   convert inside a transaction, verify, check the round trip, roll back
 *   tsx scripts/units-migrate.ts --apply <db>     convert (once; the epoch marker stops a second run)
 *   tsx scripts/units-migrate.ts --reverse <db>   convert back to radius-1 disks and balls
 *
 * The server converts by itself at start-up; this tool is for a dry run on a COPY of the volume (the dry run changes
 * nothing, but run it on a copy anyway) and for a rollback. --dry-run reports counts and timing, then checks that
 * the conversion is exact: row counts, leaders by id, the real validators on the converted rows (every 2D row, and a
 * sample of the spaces' entries), a second forward run that changes nothing, and a reverse that restores a digest of
 * every row bit for bit. `--spot N` prints N entries before and after (default 5).
 */
import { DatabaseSync } from "node:sqlite";
import { evaluate, type PackingConfig } from "@polypack/geometry";
import { SPACE_NAMES, isSpaceName, validateSpaceSubmissionAsync, type SpaceName } from "@polypack/spaces";
import { decodePieces } from "../apps/server/src/pieces";
import { applyUnits, migrateUnits, planarFactors, unitsDigest, unitsEpoch } from "../apps/server/src/units-migration";

type Row = Record<string, unknown>;

function leaders(db: DatabaseSync): Map<string, number> {
  const best = new Map<string, { score: number; id: number }>();
  for (const r of db.prepare("SELECT n, m, p, score, id FROM submissions WHERE verification != 'rejected'").all() as Row[]) {
    const k = `${r.n}/${r.m}/${r.p}`;
    const b = best.get(k);
    const score = r.score as number;
    const id = r.id as number;
    if (!b || score < b.score || (score === b.score && id < b.id)) best.set(k, { score, id });
  }
  return new Map([...best].map(([k, v]) => [k, v.id]));
}

function counts(db: DatabaseSync): { submissions: number; entries: number; archive: number } {
  const n = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  const hasArchive = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'space_entries_units_archive'").get();
  return {
    submissions: n("SELECT COUNT(*) AS c FROM submissions"),
    entries: n("SELECT COUNT(*) AS c FROM space_entries"),
    archive: hasArchive ? n("SELECT COUNT(*) AS c FROM space_entries_units_archive") : 0,
  };
}

/** A few affected entries (a 2D row of each class, and space entries), as plain text. */
function sample(db: DatabaseSync, wanted: number): { key: string; text: () => string }[] {
  const out: { key: string; text: () => string }[] = [];
  const classes: [string, string][] = [
    ["2D disks in a polygon", "n = 0 AND m >= 3"],
    ["2D disks in a circle", "n = 0 AND m = 0"],
    ["2D polygons in a circle", "n >= 3 AND m = 0"],
  ];
  for (const [label, where] of classes) {
    const r = db.prepare(`SELECT id FROM submissions WHERE ${where} ORDER BY id DESC LIMIT 1`).get() as Row | undefined;
    if (r) out.push({ key: `${label} (submission ${r.id})`, text: () => describeSubmission(db, r.id as number) });
  }
  const space = db
    .prepare("SELECT id, space, problem FROM space_entries WHERE space IN ('balls', 'boundary', 'torus', 'sphere', 'surface', 'curved') ORDER BY id DESC")
    .all() as Row[];
  const seen = new Set<string>();
  for (const r of space) {
    if (out.length >= wanted) break;
    const key = r.space as string;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key: `${r.problem} (entry ${r.id})`, text: () => describeEntry(db, r.id as number) });
  }
  return out.slice(0, wanted);
}

function describeSubmission(db: DatabaseSync, id: number): string {
  const r = db.prepare("SELECT n, m, p, score, pieces, literature_value, strict_check FROM submissions WHERE id = ?").get(id) as Row | undefined;
  if (!r) return "(no longer present)";
  const first = r.pieces instanceof Uint8Array ? decodePieces(r.pieces)[0] : r.pieces;
  return `N/M/P ${r.n}/${r.m}/${r.p}  score ${r.score}  first piece ${JSON.stringify(first)}  literature_value ${r.literature_value}  strict ${r.strict_check}`;
}

function describeEntry(db: DatabaseSync, id: number): string {
  const r = db.prepare("SELECT problem, score, config FROM space_entries WHERE id = ?").get(id) as Row | undefined;
  if (!r) return "(moved to the archive)";
  const c = JSON.parse(r.config as string) as Record<string, unknown>;
  const head = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Array.isArray(v) ? `${JSON.stringify(v[0])} (+${v.length - 1} more)` : v]));
  return `${r.problem}  score ${r.score}  config ${JSON.stringify(head)}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args.includes("--dry-run") ? "dry-run" : args.includes("--reverse") ? "reverse" : args.includes("--apply") ? "apply" : null;
  const spotAt = args.indexOf("--spot");
  const spot = spotAt >= 0 ? Number(args[spotAt + 1]) : 5;
  const path = args.filter((a, i) => !a.startsWith("--") && !(spotAt >= 0 && i === spotAt + 1)).pop();
  if (!mode || !path) {
    console.error("usage: tsx scripts/units-migrate.ts (--dry-run | --apply | --reverse) [--spot N] <database file>");
    process.exit(2);
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  console.log(`epoch before: ${unitsEpoch(db)}`);
  if (mode === "apply" || mode === "reverse") {
    const report = migrateUnits(db, mode === "reverse");
    console.log(JSON.stringify(report, null, 2));
    console.log(`epoch after: ${unitsEpoch(db)}`);
    return;
  }

  // dry run: everything below happens inside one transaction that is rolled back
  const t0 = performance.now();
  const digest0 = unitsDigest(db);
  const c0 = counts(db);
  const lead0 = leaders(db);
  const picks = sample(db, spot);
  const before = picks.map((p) => p.text());
  console.log(`rows: ${JSON.stringify(c0)}; digest and samples read in ${(performance.now() - t0).toFixed(0)} ms`);

  db.exec("BEGIN IMMEDIATE");
  try {
    const report = applyUnits(db, false);
    console.log("forward:", JSON.stringify(report, null, 2));
    console.log(`forward took ${report.ms.toFixed(0)} ms; epoch ${unitsEpoch(db)}`);
    const c1 = counts(db);
    const lead1 = leaders(db);
    const fails: string[] = [];
    if (c1.submissions !== c0.submissions) fails.push("submission count changed");
    if (c1.entries + c1.archive !== c0.entries + c0.archive) fails.push("space entry count (with the archive) changed");
    if (unitsEpoch(db) !== 2) fails.push("epoch is not 2");
    let leaderDiff = 0;
    for (const [k, id] of lead0) if (lead1.get(k) !== id) leaderDiff++;
    if (leaderDiff || lead1.size !== lead0.size) fails.push(`leaders changed in ${leaderDiff} problems`);
    console.log(`after: ${JSON.stringify(c1)}; leaders: ${lead0.size} problems, ${leaderDiff} changed`);
    picks.forEach((p, i) => console.log(`\n${p.key}\n  before: ${before[i]}\n  after:  ${p.text()}`));

    // the real 2D validator on every converted row: the stored score must be the score of the converted pieces
    const v0 = performance.now();
    let checked = 0;
    let equal = 0;
    let legacy = 0;
    let bad = 0;
    const worst: string[] = [];
    for (const r of db.prepare("SELECT id, n, m, p, score, pieces, container_phi FROM submissions WHERE n = 0 OR m = 0 ORDER BY id").all() as Row[]) {
      if (!planarFactors(r.n as number, r.m as number) || !(r.pieces instanceof Uint8Array)) continue;
      const cfg: PackingConfig = {
        N: r.n as number,
        M: r.m as number,
        P: r.p as number,
        pieces: decodePieces(r.pieces),
        container_phi: r.container_phi as number,
      };
      const ev = evaluate(cfg, { stopWhenInvalid: true });
      checked++;
      const stored = r.score as number;
      if (!ev.valid || !ev.container) {
        bad++;
        if (worst.length < 5) worst.push(`submission ${r.id} invalid: ${ev.reasons[0]}`);
      } else if (Math.abs(ev.container.size - stored) <= 1e-12 * stored) equal++;
      else if (ev.container.size < stored) legacy++;
      else {
        bad++;
        if (worst.length < 5) worst.push(`submission ${r.id}: stored ${stored}, recomputed ${ev.container.size}`);
      }
    }
    console.log(`validator on ${checked} converted 2D rows in ${(performance.now() - v0).toFixed(0)} ms: ${equal} equal to 1e-12, ${legacy} stored larger than recomputed (older scoring rule), ${bad} invalid or smaller`);
    for (const w of worst) console.log("  " + w);
    if (bad) fails.push(`${bad} converted 2D rows do not validate`);

    // a sample of the space entries through the real validators
    const entries = db.prepare("SELECT id, space, problem, score, config FROM space_entries ORDER BY id").all() as Row[];
    const affected = entries.filter((r) => isSpaceName(r.space as string));
    const step = Math.max(1, Math.floor(affected.length / 200));
    let sv = 0;
    let svBad = 0;
    for (let i = 0; i < affected.length; i += step) {
      const r = affected[i];
      const verdict = await validateSpaceSubmissionAsync(r.space as SpaceName, r.problem as string, JSON.parse(r.config as string));
      sv++;
      if (!verdict.valid || verdict.score === null || Math.abs(verdict.score - (r.score as number)) > 1e-12 * (r.score as number)) {
        svBad++;
        if (svBad <= 5) console.log(`  entry ${r.id} ${r.problem}: ${verdict.valid ? `score ${verdict.score} vs stored ${r.score}` : verdict.reasons[0]}`);
      }
    }
    console.log(`validators on ${sv} of ${affected.length} space entries (every ${step}th): ${svBad} failed or differ (all of ${SPACE_NAMES.join(", ")})`);
    if (svBad) fails.push(`${svBad} space entries do not validate`);

    // idempotent: a second forward run does nothing
    const again = applyUnits(db, false);
    if (again.action !== "none") fails.push("a second forward run did something");
    // reversible: the reverse restores every row bit for bit
    const back = applyUnits(db, true);
    const digest1 = unitsDigest(db);
    if (digest1 !== digest0) fails.push("reverse did not restore the original digest");
    console.log(`second forward: ${again.action}; reverse: ${JSON.stringify({ archived: back.archived, restored: back.restored })}, digest ${digest1 === digest0 ? "identical to the original" : "DIFFERENT"}; epoch ${unitsEpoch(db)}`);
    console.log(fails.length ? `FAILED: ${fails.join("; ")}` : "dry run OK");
    process.exitCode = fails.length ? 1 : 0;
  } finally {
    db.exec("ROLLBACK");
  }
  console.log(`rolled back; epoch ${unitsEpoch(db)}; total ${(performance.now() - t0).toFixed(0)} ms`);
}

await main();
