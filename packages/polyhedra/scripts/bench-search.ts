/**
 * Search quality against the records: from a warm start (the record) and from scratch, at fixed evaluation
 * budgets, for a list of cases. Prints one JSON line per run.
 *
 * Usage: npx tsx packages/polyhedra/scripts/bench-search.ts <evals> <id> [<id> ...]
 */
import { readFileSync } from "node:fs";
import { getProblem, searchPolyhedra, validatePolyhedra } from "../src/index";

const [evalsArg, ...ids] = process.argv.slice(2);
const evals = Number(evalsArg);
const doc = JSON.parse(readFileSync(new URL("../../../data/polyhedra/records.json", import.meta.url), "utf8"));
for (const id of ids) {
  const r = doc.records.find((x: { id: string }) => x.id === id);
  const p = getProblem(r.code)!;
  for (const mode of ["warm", "fresh"] as const) {
    const t0 = performance.now();
    const res = searchPolyhedra(p, r.P, { seed: 1, maxEvals: evals, start: mode === "warm" ? r.config : undefined });
    const sec = (performance.now() - t0) / 1000;
    const ok = res.config ? validatePolyhedra(p, res.config, { tol: 0 }).valid : false;
    console.log(
      JSON.stringify({
        id,
        mode,
        record: r.score_cert,
        s_tight: r.s_tight ?? null,
        score: res.score,
        rel: res.score / r.score_cert - 1,
        startScore: res.startScore,
        hops: res.hops,
        evaluations: res.evaluations,
        seconds: +sec.toFixed(1),
        valid: ok,
      }),
    );
  }
}
