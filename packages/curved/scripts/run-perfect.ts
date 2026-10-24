/**
 * Exact tile packings: q unit triangles around a vertex fill a regular q-gon of side 1 at the
 * curvature K* where the unit triangle's angle is 2 pi / q (the {3, q} tiling):
 *   cos(pi/3) = cs_K(1/2) sin(pi/q)   =>   cs_K(1/2) = 1 / (2 sin(pi/q)).
 * By area these packings are optimal (s = 1 cannot shrink: a smaller container has smaller area).
 *   npx tsx packages/curved/scripts/run-perfect.ts --out DIR
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { certifyPrep, polishAt, sensitivity, validate, pieceGeometry, type CurvedPose } from "../src/index";
import { multiplierRange } from "../src/sensitivity";

const i = process.argv.indexOf("--out");
const out = i > 0 ? process.argv[i + 1] : "perfect";
mkdirSync(out, { recursive: true });
for (const q of [5, 7, 8, 9, 10, 12]) {
  const c = 1 / (2 * Math.sin(Math.PI / q));
  const K = c < 1 ? (2 * Math.acos(c)) ** 2 : -((2 * Math.acosh(c)) ** 2);
  const g = pieceGeometry(3, K);
  const poses: CurvedPose[] = [];
  for (let k = 0; k < q; k++) {
    const b = -Math.PI / 2 + (2 * Math.PI * k) / q; // wall normal k: triangle k has its outer edge on wall k
    poses.push({ x: g.R * Math.cos(b), y: g.R * Math.sin(b), theta: b + Math.PI / 2 });
  }
  const prob = { N: 3, M: q, P: q };
  const v = validate(prob, K, { size: 1 + 1e-9, pieces: poses });
  const pc = polishAt(prob, K, { size: 1 + 1e-9, pieces: poses });
  const best = pc.validation.valid ? pc : undefined;
  const cfg = best ? best.config : { size: 1 + 1e-9, pieces: poses };
  const pol = best ? best.polish : polishAt(prob, K, cfg).polish;
  const cert = certifyPrep(prob, K, cfg, 1e-11);
  const sens = sensitivity(prob, K, cfg, pol);
  const range = multiplierRange(prob, K, cfg, pol);
  const rec = {
    K,
    N: 3,
    M: q,
    P: q,
    perfect: `{3,${q}} tiling: ${q} unit triangles fill the regular ${q}-gon of side 1`,
    found: true,
    seed: 0,
    budget: { construction: "exact tiling, then polish" },
    score_float: cfg.size,
    config_float: cfg,
    validation_float: { valid: v.valid, minGap: v.minGap },
    kktResidual: pol.kktResidual,
    rattlers: pol.rattlers,
    dsdK: sens.dsdK,
    dsdK_range: range,
    margin: 1e-11,
    config_cert: cert.config,
    score_cert: cert.config.size,
    validation_cert: { valid: cert.validation.valid, minGap: cert.validation.minGap },
    witnesses: cert.witnesses,
  };
  writeFileSync(join(out, `${K}_3_${q}_${q}.json`), JSON.stringify(rec));
  console.log(
    `{3,${q}}: K* = ${K}, s_float = ${cfg.size}, s_cert = ${cert.config.size}, valid ${cert.validation.valid}, dsdK range [${range.min.toFixed(4)}, ${range.max.toFixed(4)}]`,
  );
}
