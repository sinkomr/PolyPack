import { describe, expect, it } from "vitest";
import { methodGame } from "../src/tighter/methods";
import type { RunView } from "../src/tighter/methods";
import { hardenLarger } from "../src/tighter/methods/harden";

const view = (over: Partial<RunView> = {}): RunView => ({
  evaluations: 130,
  budget: 361,
  params: {},
  last: 10.38,
  runBest: 10,
  found: 10.38,
  startScore: 10,
  problemBest: 10,
  ...over,
});

describe("harden in Tighter", () => {
  it("shows how much larger the run's latest packing is than the board, and how far the run has got", () => {
    const g = methodGame("harden");
    expect(hardenLarger(view())).toBeCloseTo(0.038, 12);
    expect(g.runNote!(view())).toBe(" · its latest packing is 3.8 % larger than your board");
    expect(g.runNote!(view({ last: 10.031 }))).toBe(" · its latest packing is 0.31 % larger than your board");
    // the run's own new best is the board
    expect(g.runNote!(view({ last: 9.9, problemBest: 9.9 }))).toBe(" · its latest packing is as small as your board");
    // nothing before the run has scored a packing of its own: its first evaluation is the board
    expect(g.runNote!(view({ evaluations: 1, last: 10 }))).toBe("");
    expect(g.runNote!(view({ last: null }))).toBe("");
    // the board before any best is known: the score the run opened from
    expect(g.runNote!(view({ problemBest: null }))).toBe(" · its latest packing is 3.8 % larger than your board");
    expect(g.stepNote!(view())).toBe(
      "The run is at 130 of 361 evaluations, and its latest packing is 3.8 % larger than your board.",
    );
    expect(g.stepNote!(view({ evaluations: 1, budget: 1_201 }))).toBe("The run is at 1 of 1,201 evaluations.");
    // plain sentences, and never a seed
    for (const t of [g.runNote!(view()), g.stepNote!(view())]) expect(t).not.toMatch(/[;—]|seed/i);
  });
});
