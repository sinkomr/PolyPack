/**
 * Checks the boundary space's records (data/boundary/records.json) with the engine's float
 * validator: every record's configuration, stored at s = score_cert, must be valid at the touching
 * tolerance 1e-9 and at tolerance 0, with the validator's score equal to score_cert. The exact
 * certificate is python/boundary/certify.py; this is the engine's independent float check.
 *
 * Usage: npx tsx packages/boundary/scripts/check-records.ts [records.json]
 * Exits 1 when any record fails.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BoundaryProblem } from "../src/index";
import { parseBoundaryId, validateBoundary } from "../src/index";

const path = process.argv[2] ?? fileURLToPath(new URL("../../../data/boundary/records.json", import.meta.url));
const data: unknown = JSON.parse(readFileSync(path, "utf8"));
const records =
  typeof data === "object" && data !== null && Array.isArray((data as { records?: unknown }).records)
    ? (data as { records: unknown[] }).records
    : null;

let ok = 0;
const failures: string[] = [];
const t0 = performance.now();
if (!records) failures.push("the file has no records list");
for (const [k, raw] of (records ?? []).entries()) {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : `record ${k}`;
  const problem = parseBoundaryId(id);
  if (typeof problem === "string") {
    failures.push(`${id}: ${problem}`);
    continue;
  }
  const config = r.config as { s?: unknown } | undefined;
  if (typeof r.score_cert !== "number" || !config || config.s !== r.score_cert) {
    failures.push(`${id}: the configuration's s is not score_cert`);
    continue;
  }
  const problems: string[] = [];
  for (const tol of [1e-9, 0]) {
    const t = performance.now();
    const v = validateBoundary(problem as BoundaryProblem, config, { tol });
    const ms = performance.now() - t;
    if (!v.ok) problems.push(`invalid at tol ${tol}: ${v.reasons.slice(0, 3).join(" ")}`);
    else if (v.score !== r.score_cert)
      problems.push(`tol ${tol}: score ${v.score} differs from score_cert ${r.score_cert}`);
    if (tol === 0 && !problems.length) console.log(`OK   ${id} ${String(r.display)} (${ms.toFixed(1)} ms at tol 0)`);
  }
  if (problems.length) failures.push(`${id}: ${problems.join("; ")}`);
  else ok++;
}
for (const f of failures) console.log(`FAIL ${f}`);
console.log(
  `checked ${ok + failures.length} records: ${ok} valid at tol 1e-9 and 0, ${failures.length} failed (${((performance.now() - t0) / 1000).toFixed(2)} s)`,
);
process.exit(failures.length ? 1 : 0);
