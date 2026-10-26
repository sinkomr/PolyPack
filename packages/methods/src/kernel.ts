/**
 * The geometry kernel of one space problem: what the generic search methods of this package need
 * to know about a space (docs/methods/dimensions/README.md). Each space implements it once, in its
 * own package (packages/<space>/src/kernel.ts), on top of its existing energy and validator; the
 * methods (penalty, mc_compress, asc, basin_hopping, shrink_repair, harden, morph, seed) are
 * written once against it and so run in every space.
 *
 * A state holds each piece's variables in a local chart around a per-piece anchor that the kernel
 * keeps in `aux` (a cell, a base orientation, a lattice cell): positions as lengths and turns as
 * angles or rotation vectors, `dim` numbers per piece. They are offsets in a chart, not positions in a
 * common frame: right after a rebase they are about zero, so scaling them, or comparing two
 * pieces' variables, means nothing. A method moves pieces only through jiggle, randomPose, swap
 * and the local solves, and changes the arrangement as a whole only through setSize. `rebase` folds the chart offsets into the
 * anchors, so the methods can move pieces freely without knowing the space's topology. The size
 * the methods minimise is the problem's score itself (a container side, a sphere's rho, a torus
 * lattice's score, a polytope's edge): smaller is tighter.
 *
 * Rules every kernel follows (checked by contract.ts):
 *  - Units: lengths in units of the piece's own size (side 1 or radius 1, as the space defines),
 *    so one `steps` entry moves a piece by about its inradius.
 *  - Energy: a sum of squared hinge terms, pair penetrations and wall protrusions measured as
 *    lengths, so it is zero for a packing that is valid at its size by the kernel's own model and
 *    positive with a continuous gradient otherwise. `grad` receives dE/dx for every variable and,
 *    in its last entry, dE/dsize (central differences are fine).
 *  - Monotone in size, where the space allows it: setSize to a larger size never raises the
 *    energy of a state with zero energy (it keeps the normalized arrangement: centres scale with
 *    the container, and pieces keep their size).
 *  - finish() is the space's exact finishing (a bisection on the size with the float validator, a
 *    legalisation, a polish): it returns a configuration that the space's validator accepts at
 *    tolerance 0 at the stated size, or null. Only finish() and validate() decide validity; the
 *    energy is a model.
 *  - Determinism: all randomness comes from the `rng` argument; nothing reads the clock.
 *  - Purity: a kernel holds no state of its own beyond what it was built with (the problem, its
 *    caches); every method call takes the state it works on.
 */

/** A uniform random number in [0, 1), from the method's seeded stream. */
export type Rng = () => number;

/** The variables of a packing as the methods see them. */
export interface KernelState {
  /**
   * P * dim + globals numbers: piece i owns x[i * dim] ... x[i * dim + dim - 1], in its chart;
   * the last `globals` entries are variables of the whole packing (a free torus lattice's shear).
   */
  x: Float64Array;
  /** The size being minimised, which is the problem's score at this state. */
  size: number;
  /** The kernel's own data: anchors, cells, base orientations, the soft-shape parameter. clone() copies it. */
  aux: unknown;
}

/** A valid configuration with its size. */
export interface Finished {
  /** In the space's submission format (docs/spaces/<SPACE>.md). */
  config: unknown;
  /** Its score, as the validator states it. */
  score: number;
}

export interface Validation {
  valid: boolean;
  score: number | null;
  reasons: string[];
}

/** Optional abilities; a method that needs one is offered only for kernels that have it. */
export type KernelCapability = "shape" | "seeds" | "swap";

export interface SpaceKernel {
  /** The space's API name ("sphere", "boundary", ...). */
  readonly space: string;
  /** The problem id ("sphere/4/12"). */
  readonly id: string;
  readonly P: number;
  /** Variables per piece. */
  readonly dim: number;
  /** One typical step per variable of a piece (length dim): a move of this size shifts a piece by about its inradius. */
  readonly steps: Float64Array;
  /** Variables of the whole packing after the pieces' (usually 0). */
  readonly globals: number;
  /** One typical step per global variable (length globals). */
  readonly globalSteps: Float64Array;
  /** The piece's inradius in the units of the size (the score's units): a length for pressures, noise and size steps. */
  readonly inradius: number;
  /**
   * The problem's lower bound on the score, or null. It holds for the true shapes only: a method
   * working with soft shapes (setShape, t < 1) must not floor the size at it.
   */
  readonly bound: number | null;
  /** Energy evaluations one finish() or validate() call costs, for the methods' budgets. */
  readonly finishCost: number;
  /**
   * Energy evaluations an energy() call with a gradient costs (default 1). A kernel whose gradient
   * is a central difference sets it to what it measures, so a budget buys about the same work in
   * every space.
   */
  readonly gradCost?: number;
  /** Energy evaluations one validate() call costs, when it is cheaper than a finish (default finishCost). */
  readonly validateCost?: number;
  readonly capabilities: readonly KernelCapability[];
  /**
   * True where growing a valid state with setSize can itself open small overlaps: in curved
   * space the turns between neighbours around a closed chain must add up to K times the area it
   * encloses (Gauss-Bonnet), so flush polygons turn against each other as the container grows.
   * Methods then relax a grown state before counting on its pieces being clear, and the contract
   * checks "grow, relax, no energy left" instead of "grow, no energy".
   */
  readonly growthMayOverlap?: boolean;

  /**
   * A clean state from a configuration in the space's format (any size, valid or not), or null
   * when it is malformed or outside the server's limits (coordinates, sizes, a lattice's skew): a
   * method may be handed any start, and must never work on a state no submission could have.
   */
  fromConfig(config: unknown): KernelState | null;
  /** The configuration of a state at its size; it need not be valid. */
  toConfig(s: KernelState): unknown;
  clone(s: KernelState): KernelState;
  /** Folds the chart offsets into the anchors; the configuration does not change. Safe to call at any time. */
  rebase(s: KernelState): void;
  /** Random poses at a size roomy enough that a short relaxation separates them. */
  randomStart(rng: Rng): KernelState;
  /*
   * randomPose and jiggle change piece i's dim entries of x and nothing else (not aux, not other
   * pieces, not the globals): a method undoes a rejected move by writing those numbers back.
   * Anchors change only in rebase.
   */
  /** Re-places piece i at a uniformly random pose in the container. */
  randomPose(s: KernelState, i: number, rng: Rng): void;
  /** Moves piece i by a uniform random amount of up to `amount` steps in each of its variables. */
  jiggle(s: KernelState, i: number, amount: number, rng: Rng): void;
  /** Changes the size, keeping the normalized arrangement (centres move with the container, pieces keep their size). */
  setSize(s: KernelState, size: number): void;
  /**
   * Penalty energy at the state's size. With `grad` (length P * dim + globals + 1), writes dE/dx
   * and, last, dE/dsize. `weights` (length P, default all 1) scale every term of piece i: a pair term by
   * (w_i + w_j) / 2, a wall term by w_i.
   */
  energy(s: KernelState, grad?: Float64Array, weights?: Float64Array): number;
  /** The terms of piece i alone: its pairs and its walls, weighted as in energy(). */
  pieceEnergy(s: KernelState, i: number, weights?: Float64Array): number;
  /** True when piece i overlaps no other piece and no wall by more than `tol` (a length). */
  clear(s: KernelState, i: number, tol: number): boolean;
  /**
   * The space's exact finishing from s (see above), or null when it finds no valid configuration
   * near s. A long finishing (a polish) polls `shouldStop` when given and, once it is true, ends
   * early with the best valid configuration it has, or null.
   */
  finish(s: KernelState, shouldStop?: () => boolean): Finished | null;
  /** The server's rule for this problem, for a configuration in the space's format. */
  validate(config: unknown): Validation;

  /**
   * Capability "shape": soft pieces for harden and morph. t = 0 makes every piece its inscribed
   * disk or ball, t = 1 its true shape; in between, the piece scaled by t about its centre and
   * dilated by (1 - t) times its inradius. Where a space has no scaling (curved space), any nested
   * family will do that runs from the inscribed disk to the piece, every member inside the piece
   * and growing with t (the curved kernel cuts the piece by a disk of growing radius). energy, pieceEnergy and clear use the current shape;
   * finish and validate always use the true shape. The shape is part of the state (in aux).
   */
  setShape?(s: KernelState, t: number): void;
  /**
   * Capability "seeds": structured starts (lattices, rings, symmetric layouts), at most `count`.
   * A kernel may return the same layouts on every call, so a method must not count on new ones.
   */
  seeds?(rng: Rng, count: number): KernelState[];
  /** Capability "swap": exchanges the orientations of pieces i and j, leaving their positions. */
  swap?(s: KernelState, i: number, j: number): void;
}
