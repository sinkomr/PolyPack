/**
 * The elementary bounds of every problem at P = 2, 13 and 100, and the geometry of every solid they rest on, for the
 * certifier's test (python/balls/test_certify.py compares its own bound() and solid geometry with them), and
 * packages/balls/test/containers.test.ts checks that the file is current.
 *
 *   npx tsx scripts/gen-bounds.ts > ../../python/balls/fixtures/bounds.json
 */
import { SOLID_NAMES } from "@polypack/polyhedra";
import { BALLS_PROBLEMS, ballsBound } from "../src";
import { containerOf } from "../src/container";

const solids: Record<string, unknown> = {};
for (const name of SOLID_NAMES) {
  const c = containerOf(name);
  solids[name] = { volume: c.volume, inradius: c.inradius, circumradius: c.circumradius, diameter: c.diameter, tangential: c.tangential };
}
const bounds = BALLS_PROBLEMS.flatMap((p) =>
  [2, 13, 100].map((P) => {
    const b = ballsBound(p, P);
    return { code: p.code, P, value: b.value, kind: b.kind };
  }),
);
process.stdout.write(JSON.stringify({ generated: "2026-10-27", solids, bounds }) + "\n");
