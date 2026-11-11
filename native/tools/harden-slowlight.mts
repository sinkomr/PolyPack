// harden-slowlight.mts PORT OUT (a tool of the hardening, finding 7): which research records, shrunk a little so that they are checked, take longest to check without being heavy
import { writeFileSync } from "node:fs";
import { ndCheckOps, ndIsHeavy } from "@polypack/ndspace";
import { parseSpaceId } from "@polypack/spaces";
import { researchRecords, scaled } from "./serverdiff/scenarios/data.mts";
const port = Number(process.argv[2]);
const out: { id: string; ms: number; status: number; ops: number; body: unknown }[] = [];
const recs = researchRecords("ndim", 100000, 500, 3).filter((r) => {
  const p = parseSpaceId("ndim", r.id);
  if (typeof p === "string") return false;
  const prob = { d: Number(p.fields.d), piece: String(p.fields.piece), container: String(p.fields.container), P: p.P };
  (r as any).ops = ndCheckOps(prob);
  return !ndIsHeavy(prob) && (r as any).ops > 5e6;
});
recs.sort((a: any, b: any) => b.ops - a.ops);
console.log(`${recs.length} ndim records that are not heavy with more than 5e6 operations`);
let k = 0;
for (const r of recs.slice(0, 40)) {
  const body = { space: "ndim", id: r.id, name: "slow", units: "diameter", config: scaled("ndim", r.id, r.config, 0.999) };
  const t = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}/api/spaces/submit`, { method: "POST", body: JSON.stringify(body), headers: { "x-test-client-ip": `10.3.0.${k++ % 250}` } });
  const text = await res.text();
  out.push({ id: r.id, ms: performance.now() - t, status: res.status, ops: (r as any).ops, body });
  if (k <= 3) console.log(r.id, res.status, text.slice(0, 160));
}
out.sort((a, b) => b.ms - a.ms);
for (const o of out.slice(0, 8)) console.log(`${o.id}: ${o.status} in ${o.ms.toFixed(1)} ms (${o.ops.toExponential(2)} operations)`);
writeFileSync(process.argv[3], JSON.stringify(out[0].body));
