/**
 * The polygon solver's methods in the board's words: their names, in the order the Method menu
 * lists them, and a description each. The Flat board's Solve panel (solve-panel.ts) uses them, and
 * the space mode for nofold surface problems, which run the polygon solver on one face
 * (space/model.ts boardMethods).
 */
export const POLYGON_METHOD_NAMES: Record<string, string> = {
  basin_hopping: "Basin hopping",
  penalty: "Penalty / augmented Lagrangian",
  mc_compress: "Monte Carlo compression",
  asc: "Adaptive shrinking container",
  ls_growth: "Lubachevsky–Stillinger growth",
  morph: "Shape continuation",
  harden: "Soft-to-rigid hardening, after Yohei Nakajima",
  shrink_repair: "Shrink and repair",
  seed: "Lattice & symmetry seeds",
  polish: "Contact polish",
};

/** The Method menu's order. */
export const POLYGON_METHOD_ORDER = Object.keys(POLYGON_METHOD_NAMES);

export const POLYGON_METHOD_DESCRIPTIONS: Record<string, string> = {
  basin_hopping:
    "Perturbs and improves a packing repeatedly to escape local minima. A useful starting choice for polygons.",
  penalty: "Compresses the packing with continuous optimization, then refines its contacts.",
  mc_compress: "Tries small random moves while gradually shrinking the container.",
  asc: "Adjusts the pieces and container together to find a tighter packing.",
  ls_growth:
    "Moves and grows pieces until they settle into contact. Circle collisions are event-driven; polygon dynamics are approximate.",
  morph: "Starts with rounded pieces and gradually changes them to the chosen shape.",
  harden:
    "Soft-to-rigid hardening, after Yohei Nakajima: squeezes soft inscribed disks together, hardens them into the true shapes and keeps the best of several seeded runs.",
  shrink_repair:
    "Shrinks the container below the best packing, then removes the overlaps by moving, relocating and regrouping pieces. Good at escaping the grid arrangement for pieces that tile the container.",
  seed: "Generates arrangements from lattices, rings, rows, or an adjacent record.",
  polish: "Fine-tunes the contacts and positions in a complete packing.",
};
