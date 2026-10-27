/**
 * Search-quality benchmark of the board's space search with the panel's default budget: a run from a
 * tight packing gains clearly on its start. It takes about half a minute, so it is not part of
 * `npm test`; run it with `npm run test:quality`.
 */
import { validateSpaceSubmission } from "@polypack/spaces";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { type SpaceJob, type SpaceJobResult, parseSearchProblem, runSpaceJob } from "@polypack/spaces/search";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type RoundRunner, SpaceSearch } from "../src/space/search";

const root = resolve(__dirname, "../../..");
const index = loadSpacesIndex(root);

function problemOf(id: string) {
  const space = id.split("/")[0] as "sphere";
  const p = index[space]!.byId.get(id)!;
  return {
    search: parseSearchProblem(id)!,
    rule: { bound: p.bound?.value ?? null, certified: p.certified?.score ?? null },
  };
}

/** Runs each round at once on this thread. */
class LocalRunner implements RoundRunner {
  run(job: SpaceJob): Promise<SpaceJobResult> {
    return Promise.resolve(runSpaceJob(job, { aborted: false, paused: false }));
  }
  cancel(): void {}
  dispose(): void {}
}

describe("a run from a tight packing, with the panel's default budget", () => {
  // the start: the best of a new arrangement with seed 4 (10,000 evaluations), then a run from
  // it with 20,000 evaluations (the default, without the time limit) and seed 9
  // A clear gain, not an exact value: seeded results differ between Node versions (CI runs Node 24),
  // and ten rounds of 2,000 evaluations from such a start gained nothing at all.
  for (const [id, gain] of [
    ["sphere/4/30", 0.005],
    ["torus/free/4/12", 0.005],
  ] as const)
    it(`improves ${id} by more than ${gain * 100}%`, async () => {
      const p = problemOf(id);
      const fresh = await new SpaceSearch(
        p.search,
        null,
        { seed: 4, budget: { evals: 10000 }, fresh: true, rule: p.rule },
        new LocalRunner(),
      ).done;
      const start = fresh.best!;
      const r = await new SpaceSearch(
        p.search,
        start.config,
        { seed: 9, budget: { evals: 20000 }, fresh: false, rule: p.rule },
        new LocalRunner(),
      ).done;
      expect(r.best!.score).toBeLessThan(start.score * (1 - gain));
      expect(validateSpaceSubmission(p.search.space, id, r.best!.config, p.rule).valid).toBe(true);
    });
});
