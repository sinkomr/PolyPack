import { sym } from "../how";
import type { MethodGame } from "./types";

// seed, from packages/solver/src/methods/seed.ts: boards built from lattices, rows and rings. It has
// no tuning upgrade, so it keeps the solver's defaults.

export const seedGame: MethodGame = {
  effect: "You can run seed, which builds new boards from lattices, rows and rings.",
  how: (select) => ({
    text: [
      "seed builds new boards from scratch instead of improving the current one. Its generators are a square lattice, a hexagonal lattice, a double lattice for pentagons, rows, and rings along the container's edge (when the container's symmetry allows and P ≤ 100). They take turns, and each makes up to 12 boards with different offsets and angles.",
      "A lattice is scaled until neighbouring pieces just touch, and seed keeps the P sites that need the smallest container centred on the origin. Each board is one evaluation. The problem's board changes only when one of them is smaller than your best. The run ends when every generator is done, after a few dozen evaluations.",
    ],
    math: [
      `keep the ${sym("P")} sites ${sym("x")} with the smallest max<sub>${sym("j")}</sub> (${sym("x")} · ${sym("u", "j")} + ${sym("h")}(${sym("u", "j")}))`,
    ],
    vars: [
      [sym("P"), "pieces"],
      [sym("x"), "a lattice site, where a piece's centre goes"],
      [sym("j"), "an edge of the container"],
      [sym("u", "j"), "the outward unit normal of edge j"],
      [`${sym("h")}(${sym("u", "j")})`, "how far a piece reaches past its centre in that direction"],
    ],
    note: select,
  }),
};
