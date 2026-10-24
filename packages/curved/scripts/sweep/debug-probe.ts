import { readFileSync } from "node:fs";
import { validate } from "../../src/index";
import { tryPolish, feasibleAt } from "../../src/sweep";
import { rng, gaussian } from "../../src/optim";
const [file, bid, Kq] = process.argv.slice(2);
const run = JSON.parse(readFileSync(file, "utf8"));
const b = run.branches.find((x: any) => x.id === +bid);
const p = b.points.reduce((a: any, q: any) => (Math.abs(q.K - +Kq) < Math.abs(a.K - +Kq) ? q : a));
const prob = run.problem;
console.log("point", p.K, p.size, p.sym, validate(prob, p.K, { size: p.size, pieces: p.pieces }).minGap);
const R = rng(12345);
for (let t = 0; t < 3; t++) {
  const pieces = p.pieces.map((q: any) => ({ x: q.x + 1e-3 * gaussian(R), y: q.y + 1e-3 * gaussian(R), theta: q.theta + 1e-3 * gaussian(R) }));
  const pc = tryPolish(prob, p.K, { size: p.size * (1 + 1e-4), pieces });
  if (!pc) { console.log("no pc"); continue; }
  const v = validate(prob, p.K, pc.config);
  console.log(t, pc.config.size, "feasibleAt", feasibleAt(prob, p.K, pc), "valid", v.valid, "minGap", v.minGap, "tight", v.tightSize, "feas", pc.polish.feasibility, "it", pc.polish.iterations, pc.polish.t);
}
