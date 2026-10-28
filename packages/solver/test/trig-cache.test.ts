import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// The geometry kernel memoises each piece's trigonometry (packages/geometry/src/trig.ts). A seeded
// run must not notice. This test runs the same seeded cases twice in one process: once with the
// solver loading geometry's overlap.ts and penalty.ts replaced by origin/main's copies (inline trig,
// packages/geometry/test/reference), once with the real modules, and compares score, evaluation
// count and a hash of the best configuration. Nothing is pinned, so it is portable across platforms.
const overlapPath = fileURLToPath(new URL("../../geometry/src/overlap.ts", import.meta.url));
const penaltyPath = fileURLToPath(new URL("../../geometry/src/penalty.ts", import.meta.url));

const CASES: [string, number, number, number][] = [
  ["mc_compress", 5, 4, 9],
  ["mc_compress", 12, 6, 14],
  ["mc_compress", 3, 0, 12],
  ["basin_hopping", 5, 4, 9],
  ["basin_hopping", 12, 6, 14],
  ["basin_hopping", 3, 0, 12],
];

async function runAll() {
  const { run } = await import("../src/index");
  const out: unknown[] = [];
  for (const [method, N, M, P] of CASES) {
    const r = await run({ N, M, P }, { method, budget: { evals: 500 }, seed: 7, finalPolish: false });
    out.push({
      score: r.score,
      evaluations: r.evaluations,
      best: createHash("sha256").update(JSON.stringify(r.best)).digest("hex"),
    });
  }
  return out;
}

describe("trig cache leaves seeded solver runs identical to the inline-trig kernel", () => {
  afterEach(() => {
    vi.doUnmock(overlapPath);
    vi.doUnmock(penaltyPath);
    vi.resetModules();
  });

  it("gives the same score, evaluation count and best configuration", async () => {
    const calls = { pieceSeparation: 0, visitContainerProtrusions: 0 };
    vi.resetModules();
    vi.doMock(overlapPath, async () => {
      const ref = await import("../../geometry/test/reference/overlap");
      return {
        ...ref,
        pieceSeparation: (...args: Parameters<typeof ref.pieceSeparation>) => (calls.pieceSeparation++, ref.pieceSeparation(...args)),
      };
    });
    vi.doMock(penaltyPath, async () => {
      const ref = await import("../../geometry/test/reference/penalty");
      return {
        ...ref,
        visitContainerProtrusions: (...args: Parameters<typeof ref.visitContainerProtrusions>) => (
          calls.visitContainerProtrusions++, ref.visitContainerProtrusions(...args)
        ),
      };
    });
    const before = await runAll();
    // the reference kernel really was the one the solver called
    expect(calls.pieceSeparation).toBeGreaterThan(0);
    expect(calls.visitContainerProtrusions).toBeGreaterThan(0);

    vi.doUnmock(overlapPath);
    vi.doUnmock(penaltyPath);
    vi.resetModules();
    const calledBefore = { ...calls };
    const after = await runAll();
    expect(calls).toEqual(calledBefore); // the real modules ran this time
    for (let i = 0; i < CASES.length; i++) {
      const b = before[i] as { score: number; evaluations: number; best: string };
      const a = after[i] as typeof b;
      expect(a.evaluations, CASES[i].join(" ")).toBe(b.evaluations);
      expect(Object.is(a.score, b.score), CASES[i].join(" ")).toBe(true);
      expect(a.best, CASES[i].join(" ")).toBe(b.best);
    }
  }, 600000);
});
