import { sym } from "../how";
import type { MethodGame } from "./types";

// morph, from packages/solver/src/methods/morph.ts (its defaults and update rules). It has no tuning
// upgrade, so it keeps the solver's defaults.

export const morphGame: MethodGame = {
  effect: "You can run morph, which solves with rounded pieces and sharpens them step by step.",
  how: (select) => ({
    text: [
      "morph solves a chain of easier problems. It replaces each piece by a soft shape S(t), the polygon shrunk by t and rounded by a disc, which goes from the inscribed disc at t = 0 to the true polygon at t = 1 in 7 steps.",
      "At each step it scales the packing to first contact and runs a penalty solve on the soft shapes, with the objective of the penalty method. After each accepted step of that solve it turns the soft packing back into true pieces, spreading the centres until nothing overlaps, and scores it, which is one evaluation. When a step ends with an overlap or a protrusion above 0.02 piece sides, it halves the next step, at most twice between two planned steps. The run ends after the last step.",
    ],
    math: [
      `${sym("S")}(${sym("t")}) = ${sym("t")} × polygon ⊕ (1 − ${sym("t")}) × ${sym("ρ")} × disc`,
      `${sym("t", "j")} = ${sym("j")} / 6, for ${sym("j")} = 0, 1, …, 6`,
    ],
    vars: [
      [`${sym("S")}(${sym("t")})`, "the soft shape at t"],
      [sym("t"), "how far along the path, from 0 to 1"],
      [sym("ρ"), "the radius of the disc inscribed in the piece"],
      [sym("j"), "the step"],
    ],
    note: `⊕ adds two shapes point by point (a Minkowski sum). ${select}`,
  }),
};
