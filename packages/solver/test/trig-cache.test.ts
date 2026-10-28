import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { run } from "../src/index";

// Expected values were produced by origin/main 10b69de (before the per-piece trigonometry cache in
// packages/geometry/src/trig.ts), seed 7, 1500 evaluations, finalPolish false, and were also the
// same under Node 24 and Node 26. The cache is a memo of pure functions, so a seeded run must stay
// bit-identical: same score double, same evaluation count, same best configuration (sha256 of its JSON).
const EXPECTED: [string, string, number, number, string][] = [
  ["mc_compress", "5/4/9", 4.636105932519068, 1500, "010e21a9879b171146267ee279ba8a96918d71df5b5141d87caca8bfd38be629"],
  ["mc_compress", "12/6/14", 8.833853213910475, 1500, "5bc3532475e34a460cc887f30bd74d3de071cfc5cb8e2f8338dd8ab80d797885"],
  ["mc_compress", "3/0/12", 3.0550504633045406, 1500, "f75491ff04ef7d36fb22497b01fead6954623bc8983c66d0a6b7b81b5c6d651a"],
  ["basin_hopping", "5/4/9", 4.623096645905388, 1500, "8026ac9a120d8f487b1e7ef7d38c5818ca355c50c69a9e3d9c55a8e8ec631ac5"],
  ["basin_hopping", "12/6/14", 8.759685397123084, 1500, "d2f0f13d8e63b46b1c755aba45a45724ead503a5e01ad552d2c3b0ef2aeb1431"],
  ["basin_hopping", "3/0/12", 3.0550504633045112, 1500, "e8e98be7e8073c6f1612af454866b31a5abd471a14f47253567c4972d3d5fe28"],
];

describe("trig cache leaves seeded solver runs bit-identical to origin/main", () => {
  for (const [method, shape, score, evaluations, hash] of EXPECTED) {
    it(`${method} on N/M/P = ${shape}`, async () => {
      const [N, M, P] = shape.split("/").map(Number);
      const r = await run({ N, M, P }, { method, budget: { evals: 1500 }, seed: 7, finalPolish: false });
      expect(r.evaluations).toBe(evaluations);
      expect(Object.is(r.score, score)).toBe(true);
      expect(createHash("sha256").update(JSON.stringify(r.best)).digest("hex")).toBe(hash);
    });
  }
});
