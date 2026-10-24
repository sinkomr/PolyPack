import { solve, polishAt, continueTo } from "../../src/index";
const cases: [number, number, number, number][] = [[0,0,7,0.1],[0,0,7,-0.5],[4,4,5,0.0],[4,4,5,-0.3],[3,3,6,-0.3],[0,0,12,-0.5],[3,3,9,0.3]];
for (const [N,M,P,K] of cases) {
  const t0 = Date.now();
  const r = solve({N,M,P}, K, { seed: 1, restarts: 4, hops: 15 });
  const t1 = Date.now();
  let tc = 0;
  if (r.config) { const s = Date.now(); const c = continueTo({N,M,P}, K, K+0.05, r.config, 10); tc = Date.now()-s; console.log(c.map(x=>x.size.toFixed(6)).join(' ')); }
  console.log(N,M,P,K, r.found, r.config?.size, (t1-t0)/1000, 's solve;', tc/1000, 's cont10', r.optima.length);
}
