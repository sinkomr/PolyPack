import { describe, expect, it } from "vitest";
import { mulberry32, runMethod } from "@polypack/methods";
import { checkSpaceConfig, parseSearchProblem, spaceKernel } from "@polypack/spaces/search";
import { UNITS_AT_20, unitsFor, unitsRow } from "../src/tighter/families";
import { countedEvals } from "../src/tighter/game";
import { LOOSE_ROOM, spaceStart } from "../src/tighter/space-run";
import { COMPACT_EVALS } from "../src/tighter/upgrades";

// Load all on a space problem serves a loose start, and Compact then runs mc_compress until it hands
// back its first finished packing. One problem of each family.

const PROBLEMS = [
  ["surface", "surface/cube/fold/4/24"],
  ["sphere", "sphere/4/12"],
  ["torus", "torus/hex/0/20"],
  ["polyhedra", "polyhedra/cubintet/12"],
  ["balls", "balls/ballinball/13"],
  ["curved", "curved/-1/5/0/40"],
] as const;

/** The start the game served before: the kernel's first seed layout, else a random start, finished. */
function finishedStartScore(id: string, seed: number): number | null {
  const p = parseSearchProblem(id)!;
  const k = spaceKernel(p)!;
  const rng = mulberry32(seed);
  const s = (k.seeds ? k.seeds(rng, 5)[0] : undefined) ?? k.randomStart(rng);
  const f = k.finish(s);
  if (!f) return null;
  const c = checkSpaceConfig(p.space, p.id, f.config, { noRecord: true });
  return c.valid ? c.score : null;
}

describe("Tighter loose starts", () => {
  it("LOOSE_ROOM is more than 1", () => {
    expect(LOOSE_ROOM).toBeGreaterThan(1);
  });

  it.each(PROBLEMS)(
    "%s: %s is served loose, valid and well above the finished start",
    (family, id) => {
      const a = spaceStart({ family, id, seed: 1 });
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      expect(a.loose).toBe(true);
      const c = checkSpaceConfig(parseSearchProblem(id)!.space, id, a.config, { noRecord: true });
      expect(c.valid).toBe(true);
      expect(c.score).toBe(a.score);
      const today = finishedStartScore(id, 1);
      if (today !== null) expect(a.score).toBeGreaterThanOrEqual(1.2 * today);
    },
    30_000,
  );

  it.each(PROBLEMS)(
    "%s: %s mc_compress hands back a finished packing below the loose start",
    (family, id) => {
      const a = spaceStart({ family, id, seed: 1 });
      if (!a.ok) throw new Error(a.message);
      const p = parseSearchProblem(id)!;
      const k = spaceKernel(p)!;
      const unit = unitsFor(
        UNITS_AT_20[unitsRow({ family, id, P: (p as { P: number }).P } as never)],
        (p as { P: number }).P,
      );
      let offers = 0;
      let stop = false;
      let best = Infinity;
      runMethod(
        { ...k, validate: (c: never) => checkSpaceConfig(p.space, id, c, { noRecord: true }) as never },
        "mc_compress",
        {
          seed: 7,
          start: a.config,
          budget: { evals: 20_000 * unit, time_s: 60 },
          onOffer: () => {
            offers++;
            stop = true;
          },
          onImprove: (f: { score: number }) => {
            best = Math.min(best, f.score);
          },
          shouldStop: (_u: number, fin: boolean) => stop && !fin,
        } as never,
      );
      expect(offers).toBeGreaterThanOrEqual(1);
      expect(best).toBeLessThan(a.score);
    },
    60_000,
  );
});

describe("Tighter Compact's count", () => {
  it("a space Compact counts as COMPACT_EVALS however long it ran, and never more than it ran", () => {
    expect(countedEvals(12_500, true, COMPACT_EVALS)).toBe(COMPACT_EVALS);
    expect(countedEvals(300, true, COMPACT_EVALS)).toBe(COMPACT_EVALS);
    expect(countedEvals(40, true, COMPACT_EVALS)).toBe(40);
  });

  it("every other job counts what it ran", () => {
    expect(countedEvals(12_500, false, COMPACT_EVALS)).toBe(12_500);
    expect(countedEvals(100, false, COMPACT_EVALS)).toBe(100);
  });
});
