import type { SpaceConfig, SpaceRunState } from "./space-run-types";

/**
 * The parts of a chained space run that the page also needs, kept apart from space-chain.ts so that
 * the page does not load the search code. A chained run is for a page that cannot share memory with
 * its worker (no cross-origin isolation): instead of one long run that pauses in place, the worker
 * makes a chain of shorter runs ("links"), each from the best board of the chain, and tells the page
 * what happened with events that carry the chain's kernel evaluations at that moment. The page
 * reveals them only up to what the player has paid (chainStateAt).
 */

/** Game evaluations a link has at least; a link must also be long enough for its kernel's finishes (chainLinkEvals). */
export const CHAIN_LINK_GAME_EVALS = 5000;

/** A link must have room for this many offers (a finish and its validation each). */
const OFFERS_PER_LINK = 3;

/**
 * Kernel evaluations in a link: `max(5,000 game evaluations, 3 × (finishCost + validateCost))`. A
 * link shorter than one offer never hands a packing back, because the framework needs the cost of
 * an offer left once it has a best (and a valid start is a best).
 */
export function chainLinkEvals(kernel: { finishCost: number; validateCost?: number }, unit: number): number {
  const offer = kernel.finishCost + (kernel.validateCost ?? kernel.finishCost);
  return Math.ceil(Math.max(CHAIN_LINK_GAME_EVALS * unit, OFFERS_PER_LINK * offer));
}

/** The seed of link `link` of a chain: the run's own for the first link, a distinct one from it for each later link. */
export function chainLinkSeed(seed: number, link: number): number {
  return link === 0 ? seed : (seed + Math.imul(link, 0x9e3779b1)) >>> 0;
}

/**
 * What a chain's worker tells the page. `at` is the chain's kernel evaluations in all at that
 * moment, never behind the true count and never past the end of the link it belongs to.
 */
export type ChainEvent =
  /** A new best, strict by the server's rule. */
  | { k: "best"; at: number; config: SpaceConfig; score: number }
  /** A finished packing was handed back; `last` and `found` are the run's values after it. */
  | { k: "offer"; at: number; last: number; found: number | null }
  /** The worker is alive (at least every 100 ms during a link). */
  | { k: "progress"; at: number }
  /** A link ended: `evals` kernel evaluations in `ms` ms of compute. */
  | { k: "link"; at: number; evals: number; ms: number }
  /** The chain ended (its budget, its method, or an error). */
  | { k: "end"; at: number; error?: string };

/**
 * The state of a chained run as of `allowed` kernel evaluations: only the events at or before it,
 * on top of `initial` (the state before any event). `known` is how far the chain has computed, so
 * that a chain that ended short of the allowance shows the evaluations it did. An error is shown
 * as soon as it is known: it gives no gain to hold back.
 */
export function chainStateAt(
  initial: SpaceRunState,
  events: readonly ChainEvent[],
  allowed: number,
  unit: number,
  known: number,
): SpaceRunState {
  const s: SpaceRunState = { ...initial };
  for (const e of events) {
    if (e.k === "end" && e.error) {
      s.ended = true;
      s.error = e.error;
      continue;
    }
    if (e.at > allowed) continue;
    if (e.k === "best") {
      s.best = e.config;
      s.score = e.score;
    } else if (e.k === "offer") {
      s.offers++;
      s.last = e.last;
      s.found = e.found;
    } else if (e.k === "end") s.ended = true;
  }
  s.evaluations = Math.floor(Math.min(allowed, known) / unit);
  // the caller may keep or change what it is given
  s.best = s.best ? structuredClone(s.best) : null;
  return s;
}

/** A link's range of the chain, in kernel evaluations, and the compute time it took. */
export interface ChainLinkSpan {
  from: number;
  to: number;
  ms: number;
}

/**
 * The compute time of the kernel evaluations `from` to `to` of a chain: each link's measured time
 * per evaluation times the part of the range that lies in it. The wall time a step waited says
 * nothing of this (the work may have been done ahead).
 */
export function chainMsBetween(links: readonly ChainLinkSpan[], from: number, to: number): number {
  let ms = 0;
  for (const l of links) {
    const lo = Math.max(from, l.from);
    const hi = Math.min(to, l.to);
    if (hi > lo && l.to > l.from) ms += ((hi - lo) / (l.to - l.from)) * l.ms;
  }
  return ms;
}
