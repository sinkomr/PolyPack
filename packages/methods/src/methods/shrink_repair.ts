/**
 * shrink_repair on any kernel: separate feasibility from size. From the current packing at score
 * s, set the size to s (1 - r) (the arrangement scales with it, so overlaps appear) and repair it
 * at that fixed size (shrink-phase.ts: relocation by sampling, relaxation, guided-local-search
 * weights). A repaired state that could beat the best is offered while offers keep within their
 * share of the budget, and accepted by its finished score; otherwise it is carried by its
 * repaired size. When it is smaller, it becomes the current packing and r grows, otherwise r
 * halves. Below the smallest ratio the search explores: it ruins a region of pieces and repairs
 * just below the current size. After repeated failed explorations it restarts from random poses
 * near the best size. The end refines (or at least offers) the smallest packing not yet offered.
 * This is the polygon method (packages/solver/src/methods/shrink_repair.ts) with kernel calls in
 * place of polygon geometry; docs/methods/dimensions/shrink_repair.md says what changed.
 */
import type { ParameterSchema } from "@polypack/solver/schema";
import type { MethodContext, SpaceMethodDefinition } from "../framework";
import type { KernelState } from "../kernel";
import { relax } from "../local";
import { FinalRefinement, offerCost } from "./basin-final";
import { Repair, type RepairSettings, type RuinKind, region, ruin } from "./shrink-phase";

/** Structured starts tried with start "auto" and no supplied start, where the kernel has them. */
const SEEDS = 4;
/** The largest shrink ratio of an exploration (minShrinkRatio may be up to 0.5, and r up to 4 times it). */
const MAX_RATIO = 0.5;

const number = (
  title: string,
  description: string,
  value: number,
  minimum: number,
  maximum: number,
  integer = false,
): ParameterSchema => ({ type: integer ? "integer" : "number", title, description, default: value, minimum, maximum });

const schema: ParameterSchema = {
  type: "object",
  title: "Shrink and repair",
  description:
    "Shrink the size below the current packing, repair the overlaps at that fixed size by relocation, relaxation and guided-local-search weights, and offer each repaired state.",
  additionalProperties: false,
  properties: {
    start: {
      type: "string",
      title: "Start",
      description:
        "auto: a valid supplied start as it is; else the supplied start, the space's structured starts or random poses, each squeezed and offered until one finishes. random: random poses (a valid supplied start is still kept by the framework).",
      enum: ["auto", "random"],
      default: "auto",
    },
    shrinkRatio: number(
      "Shrink ratio",
      "First fractional shrink r of the size; it grows by a quarter after a successful repair and halves after a failed one.",
      0.01,
      1e-6,
      0.5,
    ),
    minShrinkRatio: number(
      "Smallest shrink ratio",
      "Below it, compression has reached the floor of the current packing's basin and the search explores, at 1 to 4 times this ratio below the current size.",
      0.0002,
      1e-9,
      0.5,
    ),
    maxShrinkRatio: number("Largest shrink ratio", "Cap on the growing shrink ratio.", 0.05, 1e-6, 0.5),
    strikes: number(
      "Strike limit",
      "A repair fails after this many strikes; a strike ends after `patience` iterations without less overlap and goes back to the least overlapping state.",
      1,
      1,
      1000,
      true,
    ),
    patience: number(
      "Patience",
      "Repair iterations (relocate every conflicting piece, relax, update the weights) without 0.1% less overlap that end a strike of a compression.",
      2,
      1,
      10000,
      true,
    ),
    explorePatience: number(
      "Exploration patience",
      "Patience of the repairs that explore below the floor of the current basin, and of start and restart repairs.",
      4,
      1,
      10000,
      true,
    ),
    globalSamples: number(
      "Random samples",
      "Uniformly random poses tried for each relocated piece.",
      16,
      0,
      10000,
      true,
    ),
    localSamples: number(
      "Near samples",
      "Poses near the piece's current and best-sampled poses tried for each relocated piece.",
      8,
      0,
      10000,
      true,
    ),
    weightGrowth: number(
      "Weight growth",
      "Guided local search: at a local minimum the weight of the deepest conflicting piece is multiplied by this, shallower ones by less (down to 1 + (growth - 1) / 5).",
      2,
      1,
      100,
    ),
    weightDecay: number(
      "Weight decay",
      "Factor applied to a former conflict's weight at each update; weights never fall below 1 and are reset to 1 at each new size.",
      0.95,
      0,
      1,
    ),
    descentIterations: number(
      "Relaxation iterations",
      "L-BFGS iterations of each relaxation of the weighted energy.",
      40,
      1,
      100000,
      true,
    ),
    maxRuin: number(
      "Largest ruin",
      "Largest fraction of the pieces ruined before an exploring repair; their number is log-uniform between 1 and this fraction of P.",
      0.5,
      0,
      1,
    ),
    restartAfter: number(
      "Restart after",
      "Explorations in a row without a smaller current packing before random poses are repaired near the best size and become the current packing; 0 never restarts.",
      40,
      0,
      100000,
      true,
    ),
    restartSlack: number(
      "Restart slack",
      "A restart repairs random poses at a size this fraction above the best; when that repair fails it squeezes them instead.",
      0.02,
      0,
      1,
    ),
    polish: {
      type: "boolean",
      title: "Polish at the floor",
      description:
        "When compression reaches the floor of a basin, squeeze the current packing once (size and positions together), so the floor is reached rather than only to within the smallest ratio.",
      default: true,
    },
    refinementEvals: number(
      "Final refinement evaluations",
      "The most evaluations the final tight squeeze may take; it runs only when it and one offer fit in a third of the evaluation budget. Zero disables it; time-only runs have none.",
      3000,
      0,
      1000000,
      true,
    ),
    offerShare: number(
      "Offer share",
      "The largest share of the evaluations used so far that offers may take. A repaired state is offered only when it could beat the best and the share allows; otherwise it is carried by its repaired size, and the end offers the last one.",
      0.25,
      0,
      1,
    ),
  },
};

const defaults = {
  start: "auto",
  shrinkRatio: 0.01,
  minShrinkRatio: 0.0002,
  maxShrinkRatio: 0.05,
  strikes: 1,
  patience: 2,
  explorePatience: 4,
  globalSamples: 16,
  localSamples: 8,
  weightGrowth: 2,
  weightDecay: 0.95,
  descentIterations: 40,
  maxRuin: 0.5,
  restartAfter: 40,
  restartSlack: 0.02,
  polish: true,
  refinementEvals: 3000,
  offerShare: 0.25,
};

export interface ShrinkRepairEvent {
  kind: "start" | "compress" | "polish" | "explore" | "restart" | "refine" | "bank";
  /** The size repaired (or squeezed) at. */
  size: number;
  /** True when the repair removed the overlaps (compress, explore, restart). */
  repaired?: boolean;
  /** True when the state was offered. */
  offered: boolean;
  /** The finished score of the offer; null when nothing was offered or it did not finish. */
  score: number | null;
  ruin?: RuinKind;
  ruined?: number;
}

/** The method's loop; `observe`, when given, sees every repair and offer (it draws no random number). */
export function runShrinkRepair(ctx: MethodContext, observe?: (e: ShrinkRepairEvent) => void): void {
  const k = ctx.kernel;
  const p = ctx.params;
  const rng = ctx.rng;
  const settings: RepairSettings = {
    globalSamples: p.globalSamples as number,
    localSamples: p.localSamples as number,
    weightGrowth: p.weightGrowth as number,
    weightDecay: p.weightDecay as number,
    descentIterations: p.descentIterations as number,
    strikes: p.strikes as number,
  };
  const r0 = p.shrinkRatio as number;
  const rMin = Math.min(p.minShrinkRatio as number, r0);
  const rMax = Math.max(p.maxShrinkRatio as number, r0);
  const patience = p.patience as number;
  const explorePatience = p.explorePatience as number;
  const maxRuin = p.maxRuin as number;
  const restartAfter = p.restartAfter as number;
  const restartSlack = p.restartSlack as number;
  const share = p.offerShare as number;
  const repair = new Repair(k, settings, rng);
  // the final refinement (basin-final.ts), which learns its cost from the method's squeezes
  const final = new FinalRefinement(ctx, p.refinementEvals as number);
  const cost = offerCost(k);
  const floor = k.bound ?? 0;

  // The packing compression and exploration work on: the best, or since a restart the
  // descendant of its random poses until that beats the best (the framework keeps the best).
  // It is a finished configuration, or a state that was not offered ("carried"), whose size then
  // stands in for its score.
  let current: KernelState | null = null;
  let currentSize = Infinity;
  // The smallest carried state below the best, not yet banked: kept apart from the current
  // packing, so that a restart does not lose it. `unfinished`: a bank of it did not finish, so it
  // is not offered as it is again (the refinement may still squeeze it to a state that finishes).
  let unbanked: { state: KernelState; size: number; unfinished: boolean } | null = null;
  let offerSpent = 0;
  const bestScore = () => ctx.best()?.score ?? Infinity;

  /** Offers s, counting what the offer cost. */
  const offer = (s: KernelState): number | null => {
    const before = ctx.used();
    const score = ctx.offer(s);
    offerSpent += ctx.used() - before;
    return score;
  };
  /**
   * The offer policy: a state is offered only when it could beat the best, and only while offers
   * have taken at most `offerShare` of the evaluations used. With a cheap finishing every such
   * state is offered; with a dear one most are carried, and banks offer the smallest of them.
   */
  const worthOffering = (size: number) =>
    size < bestScore() &&
    offerSpent + cost <= share * (ctx.used() + cost) &&
    // and never into the final refinement's reserve
    ctx.remaining() - cost >= (final.possible() ? final.reserve() : 0);
  /** Takes an offered state with its finished score; the finished best when it is this one. */
  const adopt = (s: KernelState, score: number) => {
    const best = ctx.best();
    current = best && best.score === score ? best.state : s;
    currentSize = score;
  };
  /** Takes a state that was not offered: its size stands in for its score. */
  const carry = (s: KernelState) => {
    current = s;
    currentSize = s.size;
    if (s.size < bestScore() && !(unbanked && unbanked.size <= s.size))
      unbanked = { state: s, size: s.size, unfinished: false };
  };
  /** The unbanked state, while it is still below the best. */
  const toBank = () => (unbanked && unbanked.size < bestScore() ? unbanked : null);

  // --- The start ---------------------------------------------------------------------------------
  // A valid supplied start, as it is. Otherwise the supplied start or the space's structured starts,
  // relaxed at their own sizes, smallest first, then random poses, relaxed: as the polygon method,
  // which starts from the seeds' layouts and lets compression do the work (squeezed starts sit at
  // the floor of their basin, which on torus/hex/5/8 and boundary/tesseract/ball/13 did worse).
  // Each is offered; one the finishing refuses (curved space's polish gives up on loose layouts)
  // is squeezed and offered again. The first offer that finishes is also the polygon method's
  // insurance: a result as early as possible.
  const given = ctx.best();
  const auto = p.start === "auto";
  if (given && auto) {
    current = given.state;
    currentSize = given.score;
  } else {
    // When fewer than four offers fit the budget, the start's offer may be the only one: it is
    // squeezed first (as basin_hopping's), so that it is as tight as a cheap squeeze makes it.
    const tight = ctx.remaining() < 4 * cost;
    const prepare = (s: KernelState) => (tight ? final.squeeze(s) : relax(k, s));
    const starts = auto && ctx.start ? [k.clone(ctx.start)] : auto && k.seeds ? k.seeds(rng, SEEDS) : [];
    for (const s of starts) prepare(s);
    starts.sort((a, b) => a.size - b.size);
    for (let attempt = 0; !current; attempt++) {
      const s = attempt < starts.length ? starts[attempt] : k.randomStart(rng);
      if (attempt >= starts.length) prepare(s);
      let score = offer(s);
      if (score === null && !tight) {
        final.squeeze(s);
        score = offer(s);
      }
      observe?.({ kind: "start", size: s.size, offered: true, score });
      if (score !== null) adopt(s, score);
    }
  }

  // --- Shrink and repair -------------------------------------------------------------------------
  let ratio = r0;
  let exploring = false;
  let stale = 0;
  let polishNext = false;
  for (;;) {
    ctx.check();
    const before = ctx.used();
    if (final.due()) {
      // the end: a tight squeeze of the unbanked state when there is one, else of the best,
      // offered; the search then goes on with what is left
      const bank = toBank();
      const s = bank ? k.clone(bank.state) : (ctx.best()?.state ?? null);
      if (!s) {
        final.done = true;
        continue;
      }
      const score = final.run(s);
      observe?.({ kind: "refine", size: s.size, offered: true, score });
      // one that does not finish leaves the unbanked state to the last bank
      if (score !== null) {
        if (bank) unbanked = null;
        if (score < currentSize) adopt(s, score);
      }
      continue;
    }
    const bank = toBank();
    if (
      bank &&
      !bank.unfinished &&
      (worthOffering(bank.size) || (!final.possible() && ctx.remaining() <= cost + final.nextStep()))
    ) {
      // bank the unbanked state: as soon as the offer share allows, and at the end, with the last
      // offer the budget allows, when no refinement fits
      const score = offer(bank.state);
      observe?.({ kind: "bank", size: bank.size, offered: true, score });
      if (score === null) bank.unfinished = true;
      else {
        unbanked = null;
        if (score < currentSize) adopt(bank.state, score);
      }
      continue;
    }
    if (polishNext) {
      // the floor of the basin: a squeeze of the current packing (size and poses together), a step
      // of its own so that the refinement is checked before it
      polishNext = false;
      const q = k.clone(current as KernelState);
      final.squeeze(q);
      const offered = worthOffering(q.size);
      const score = offered ? offer(q) : null;
      observe?.({ kind: "polish", size: q.size, offered, score });
      if (offered) {
        if (score !== null && score < currentSize) adopt(q, score);
      } else if (q.size < currentSize * (1 - rMin)) {
        // not offered: carried only when below the current packing by more than the smallest
        // ratio (a squeeze ends a little below the floor, by its own residual overlap)
        carry(q);
      }
      final.step(ctx.used() - before);
      continue;
    }
    if (restartAfter > 0 && stale >= restartAfter) {
      // random poses at a size just above the best, repaired, replace the current packing; when
      // the repair fails (growing the size barely spreads curved space's centres) they are
      // squeezed instead
      stale = 0;
      exploring = false;
      ratio = r0;
      const s = k.randomStart(rng);
      k.setSize(s, Math.max(floor, Math.min(bestScore(), currentSize) * (1 + restartSlack)));
      repair.resetWeights();
      const repaired = repair.run(s, explorePatience);
      if (!repaired) final.squeeze(s);
      const offered = worthOffering(s.size);
      const score = offered ? offer(s) : null;
      observe?.({ kind: "restart", size: s.size, repaired, offered, score });
      // a restart's packing replaces the current one even when it is worse
      if (score !== null) adopt(s, score);
      else carry(s);
      final.step(ctx.used() - before);
      continue;
    }
    const r = exploring ? Math.min(MAX_RATIO, rMin * (1 + 3 * rng())) : ratio;
    const from = currentSize;
    // never below the problem's lower bound (it holds for the true shapes, which these are)
    const target = Math.max(floor, from * (1 - r));
    const s = k.clone(current as KernelState);
    k.setSize(s, target);
    repair.resetWeights();
    let ruined: number[] = [];
    let kind: RuinKind | undefined;
    if (exploring) {
      // a region of a log-uniform number of pieces, between 1 and maxRuin P
      ruined = region(k, s, Math.pow(Math.max(1, maxRuin * k.P), rng()), rng);
      kind = ruin(k, s, ruined, rng);
    }
    const repaired = repair.run(s, exploring ? explorePatience : patience);
    // An offered state is accepted by its finished score; one that is not offered (it cannot beat
    // the best, or offers have had their share) by the model's repaired size.
    const offered = repaired && worthOffering(s.size);
    const score = offered ? offer(s) : null;
    const improved = offered ? score !== null && score < from : repaired && s.size < from;
    if (improved) {
      if (offered) adopt(s, score!);
      else carry(s);
    }
    observe?.({
      kind: exploring ? "explore" : "compress",
      size: s.size,
      repaired,
      offered,
      score,
      ...(kind ? { ruin: kind, ruined: ruined.length } : {}),
    });
    if (improved) {
      ratio = exploring ? Math.max(ratio, Math.min(rMax, 2 * r)) : Math.min(rMax, ratio * 1.25);
      exploring = false;
      stale = 0;
    } else if (!exploring) {
      ratio *= 0.5;
      if (ratio < rMin) {
        ratio = rMin;
        exploring = true;
        polishNext = p.polish as boolean;
      }
    } else stale++;
    final.step(ctx.used() - before);
  }
}

export const shrinkRepair: SpaceMethodDefinition = {
  name: "shrink_repair",
  title: "Shrink and repair",
  summary:
    "Makes the space a little too small so that pieces overlap, then moves them until nothing overlaps; when that stops working, it scrambles a patch of pieces and tries again.",
  doc: "docs/methods/dimensions/shrink_repair.md",
  requires: [],
  schema,
  defaults,
  run: (ctx) => runShrinkRepair(ctx),
};
