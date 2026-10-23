import type { ProblemState } from "../game";

// Lattice: the solver method "seed" (packages/solver/src/methods/seed.ts), which the game runs as a
// build, once on each problem, and never as a run the player chooses. Its card (seed.ts) stays in the
// tree as "Lattice", but the method is not in the Method list, Method match or Pipelines. The server
// still records the method as "seed": it refuses method names the solver has not registered.
//
// Measured on game boards, 2026-10-22 (the lattice report in the design folder, §3):
// - the best hexagonal lattice beat Compact on all 11 open problems tried, by 0.9 % to 9.9 %;
// - with 40 to 80 pieces, mc_compress passed the lattice within 101 to 1,557 evaluations (5 of 5);
// - with 100 pieces or more, the lattice was still smaller than mc_compress after 2,100
//   evaluations (3 of 3: 0.05 %, 1.0 % and 2.1 % smaller);
// - on open problems the hexagonal lattice won every time (16 of 16), and its 12 trials found the
//   board that the 45-evaluation build of every generator found; more trials or other seeds gained
//   nothing.

/** Pieces from which the build runs right after Compact: there it beats what mc_compress reaches. */
export const LATTICE_LARGE = 100;
/**
 * Evaluations on a smaller problem after which the build runs: by then mc_compress has had its
 * cheap gains, and on these problems it had passed the lattice by 1,557.
 */
export const LATTICE_AFTER = 2000;
/** Sides from which the build tries the hexagonal lattice alone. */
export const HEX_ONLY = 9;
/** Tries of each kind of lattice, each at its own offset and angle: the solver's trials. */
export const LATTICE_TRIES = 12;
/** Evaluations of a build of the hexagonal lattice alone: the board's own scoring, then its tries. */
export const HEX_BUILD = 1 + LATTICE_TRIES;

/**
 * The solver's parameters for a build on pieces with `N` sides: the hexagonal lattice alone from 9
 * sides, otherwise every generator that applies (square and hexagonal lattices, rows, rings, the
 * pentagon pair). No pool: the game passes no boards on to a next stage, and each emit would score
 * a board again.
 */
export function latticeParams(N: number): Record<string, unknown> {
  return N >= HEX_ONLY ? { kind: "hex_lattice", poolLimit: 0 } : { poolLimit: 0 };
}

/** A problem's build, once it is over: the side of the best lattice packing, and when it ended. */
export interface LatticeResult {
  /** The best strict lattice packing's score (the build's own boards, the board it opened on excluded); null if none. */
  score: number | null;
  /** The problem's evaluations when the build ended. */
  at: number;
}

/** A saved build's result, or null when there is none or it cannot be read (a save from before it was kept). */
export function readLattice(v: unknown): LatticeResult | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const { score, at } = v as Record<string, unknown>;
  const s = score === null || (typeof score === "number" && Number.isFinite(score) && score > 0) ? score : undefined;
  if (s === undefined || !Number.isSafeInteger(at) || (at as number) < 0) return null;
  return { score: s, at: at as number };
}

/** What latticeDue needs besides the problem. */
export interface LatticeCheck {
  /** The player owns Lattice. */
  owns: boolean;
  /** The cycle's rule allows the method (One method allows only mc_compress). */
  ruleOk: boolean;
  /** W: evaluations without progress after which the problem has stalled (game.ts stallAfter). */
  stall: number;
  /** The evaluations of the click or auto-eval batch about to run on the problem. */
  evals: number;
  /** The lane already has the problem's build open: it goes on until it ends. */
  building?: boolean;
}

type DueView = Pick<
  ProblemState,
  "P" | "phase" | "run" | "lattice" | "leaving" | "closed" | "evaluations" | "sinceGain" | "endedRuns"
>;

/**
 * Whether the next click or auto-eval batch on `p` runs its build. Never twice: a problem with a
 * result is done. Only once Compact has run (the board is a run's, as game.ts evolvable says), on a
 * problem in play, with Lattice owned and the rule allowing it. Then:
 * - with P ≥ 100 pieces, at once: right after Compact;
 * - with fewer, once the problem has had 2,000 evaluations, or a run on it has ended by itself, or
 *   this batch would take its evaluations since progress to W. The last is checked before the batch
 *   runs, because with Auto-advance a stalled problem gets no more batches while others make
 *   progress, and leaves at the next deal.
 * A build already open goes on until it ends, whatever its trigger has become since.
 */
export function latticeDue(p: DueView, c: LatticeCheck): boolean {
  if (!c.owns || !c.ruleOk || p.lattice !== null || p.leaving || p.closed) return false;
  if (!(p.phase === "ready" || (p.phase === "loaded" && p.run !== null))) return false;
  if (c.building || p.P >= LATTICE_LARGE) return true;
  return p.evaluations >= LATTICE_AFTER || p.endedRuns >= 1 || p.sinceGain + Math.max(0, c.evals) >= c.stall;
}

/** The end of a build as the problem's events say it: on the notice line when it changed the board. */
export interface LatticeEvent {
  text: string;
  notice: boolean;
}

/** A step of the build's run, as the lane reports it (open-run.ts RunState). */
interface BuildStep {
  ended: boolean;
  closed: boolean;
  error?: string;
  found: number | null;
}

/**
 * A step of the problem's build, after the game has applied it (the board takes the lattice when it
 * is smaller). Once the build is over, by itself or with an error, its result goes on the problem,
 * so it never runs there again, and the event is returned. A build closed before its end (the lane
 * moved, a reload) records nothing and runs again at the next click or batch. `before` is the
 * problem's best when the build opened, `title` the problem's and `side` "side" or "radius".
 */
export function latticeStep(
  p: ProblemState,
  st: BuildStep,
  before: number | null,
  title: string,
  side: string,
): LatticeEvent | null {
  if (!st.ended || (st.closed && !st.error)) return null;
  p.lattice = { score: st.error ? null : st.found, at: p.evaluations };
  if (st.error)
    return { text: `The Lattice build on ${title} stopped (${st.error}), so your board stays.`, notice: false };
  const s = st.found;
  if (s === null)
    return { text: `Lattice found no packing without overlaps for ${title}, so your board stays.`, notice: false };
  const packed = `Lattice packed ${title}, with ${side} ${s.toFixed(6)}.`;
  if (before === null) return { text: `${packed} Your board stays.`, notice: false };
  if (s === before) return { text: `${packed} Your board is as small, so it stays.`, notice: false };
  if (s < before)
    return { text: `${packed} That beats your ${before.toFixed(6)}, so it is your board now.`, notice: true };
  return { text: `${packed} Your board's ${before.toFixed(6)} is smaller, so it stays.`, notice: false };
}
