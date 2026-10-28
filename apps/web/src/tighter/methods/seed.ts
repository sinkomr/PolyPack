import { sym } from "../how";
import { HEX_BUILD, HEX_ONLY, LATTICE_AFTER, LATTICE_LARGE, LATTICE_TRIES, latticeParams } from "./lattice";
import type { MethodGame } from "./types";

// seed, from packages/solver/src/methods/seed.ts: boards built from lattices, rows and rings. The
// game runs it as Lattice, a build once on each problem (lattice.ts says when), and never as a run
// the player chooses. It has no tuning upgrade.

const int = (n: number) => n.toLocaleString("en-US");

export const seedGame: MethodGame = {
  label: "lattice",
  name: "Lattice",
  effect: "Once on each problem, the game builds a lattice packing and keeps it if it is smaller.",
  // the build has no use for the shared sentence on the Method list: it is not there
  how: () => ({
    text: [
      `A lattice packing puts the centres of the pieces on the points of a lattice, which is a pattern that repeats in two directions, with every piece turned the same way. For pieces with ${HEX_ONLY} or more sides the game tries a hexagonal lattice. For pieces with fewer sides it also tries a square lattice, rows and a few other patterns.`,
      `Each lattice is scaled until neighbouring pieces just touch, and the game keeps the smallest container that holds the pieces. Each kind of lattice is tried at up to ${LATTICE_TRIES} offsets and angles, and each try is one evaluation. For pieces with ${HEX_ONLY} or more sides a build is ${HEX_BUILD} evaluations, the scoring of your board included.`,
      `On a problem with ${LATTICE_LARGE} pieces or more, the build runs right after Compact. On a smaller problem it runs once the problem has had ${int(LATTICE_AFTER)} evaluations, or a run on it has ended by itself, or the problem is about to stall, whichever comes first. It runs only once on each problem, and your board changes only when the lattice packing is smaller.`,
    ],
    math: [
      `build right after Compact when ${sym("P")} ≥ ${LATTICE_LARGE}`,
      `otherwise build when ${sym("e")} ≥ ${int(LATTICE_AFTER)}, or ${sym("r")} ≥ 1, or ${sym("n")} + ${sym("b")} ≥ ${sym("W")}`,
      `keep the ${sym("P")} points ${sym("x")} with the smallest max<sub>${sym("j")}</sub> (${sym("x")} · ${sym("u", "j")} + ${sym("h")}(${sym("u", "j")}))`,
      `${sym("s")} ← ${sym("s", "lat")} when ${sym("s", "lat")} &lt; ${sym("s")}`,
    ],
    vars: [
      [sym("P"), "pieces"],
      [sym("e"), "the evaluations run on the problem, Compact's included"],
      [sym("r"), "the runs on the problem that ended by themselves"],
      [sym("n"), "the evaluations run on the problem since its last progress"],
      [sym("b"), "the evaluations of the click or auto-eval batch about to run on it"],
      [
        sym("W"),
        "the patience, 1,000 evaluations at first, or as Auto-advance sets it from 250 to 20,000 (1,000 with Never)",
      ],
      [sym("x"), "a point of the lattice, where a piece's centre goes"],
      [sym("j"), "an edge of the container"],
      [sym("u", "j"), "the outward unit normal of edge j"],
      [`${sym("h")}(${sym("u", "j")})`, "how far a piece reaches past its centre in that direction"],
      [sym("s"), "your board's side"],
      [sym("s", "lat"), "the side of the best lattice packing"],
    ],
    note: "Stalling means that the next click or auto-eval batch would take the problem to W evaluations without progress. The extra patterns are a lattice of pentagon pairs for pentagons, and rings along the container's edge when its symmetry allows and P is at most 100. It does not run under the One method rule, and a problem that leaves the queue before its turn gets no build. It is not in the Method list, Method match or Pipelines, and it does not count as a run that ended by itself.",
  }),
  selectable: false,
  runParams: (_base, p) => latticeParams(p.N),
  runEnds: "A Lattice build ends after its last lattice, and it does not count as a run that ended by itself.",
};
