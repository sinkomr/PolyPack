import { sym } from "../how";
import type { MethodGame } from "./types";

// basin_hopping, from packages/solver/src/methods/basin_hopping.ts (its defaults and update rules).

export const basinHoppingGame: MethodGame = {
  effect: "You can run basin_hopping, which kicks the packing out of a local optimum and repairs it.",
  how: (select) => ({
    text: [
      "basin_hopping jumps from one local optimum to the next. Each hop changes the current packing with one of several moves, chosen by how often each has paid. The main move, a kick, shifts 40 % of the pieces (at least one) by up to m in x and y and turns them by up to 90°. The others swap pieces, move a cluster, take a piece out and put it back elsewhere, or start afresh.",
      "A short penalty solve of at most 150 evaluations then repairs the overlaps and squeezes the container. Its best packing becomes the current one when it is smaller, or else with the probability below. After each kick, m grows if the hop was accepted and shrinks if not, so that about half the kicks are accepted.",
      "It has no rule to stop early. The hops go on until 3,000 evaluations of the run's budget of 100,000 are left, and a long penalty solve then refines the best packing.",
    ],
    math: [
      `accept when ${sym("s")}′ &lt; ${sym("s")}, else with probability exp(−(${sym("s")}′ − ${sym("s")}) / ${sym("T")})`,
      `${sym("m")} ← ${sym("m")} × exp(0.15 × (${sym("a")} − 0.5))`,
    ],
    vars: [
      [sym("s"), "the side of the current packing"],
      [`${sym("s")}′`, "the side after the hop"],
      [sym("T"), "the temperature, 0.04 (in piece sides)"],
      [
        sym("m"),
        "the kick size in piece sides, 0.35 at first (0.25 with basin_hopping tuning), kept between 0.001 and 10",
      ],
      [sym("a"), "1 if the hop was accepted, else 0"],
    ],
    note: select,
  }),
  /**
   * Bench (presets.ts), 2500 evaluations (it gains nothing for its first 1000 or so on these
   * boards): kicks of 0.25 instead of 0.35 gave −7.87 / −7.83 / −8.68 % against −7.82 / −7.87 /
   * −8.44 %, the one loss within the tolerance. Not kept: a deeper local search (localEvals 200 and
   * its penalty's innerIterations 200: −8.22 / −7.72 / −8.81, a loss of 0.15 points on the 80
   * pieces), a shorter refinement (refinementEvals 500 to 2000: no change, or a loss), shallower
   * local searches (localEvals 100: −7.58 / −7.85 / −8.39) and a higher temperature (0.08: no gain).
   * One level.
   */
  presets: [{}, { kickMagnitude: 0.25 }],
  tunedDefaults: { kickMagnitude: 0.35 },
  tunedMeaning: { kickMagnitude: "the kick size at the start of a run, in piece sides" },
};
