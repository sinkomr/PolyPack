import type { PackingConfig } from "@polypack/geometry";
import type { ProblemState } from "../game";
import { needPolygon } from "../frontier";
import type { EvolveMethod } from "../upgrades";
import { ascGame } from "./asc";
import { basinHoppingGame } from "./basin_hopping";
import { hardenGame } from "./harden";
import { lsGrowthGame } from "./ls_growth";
import { mcCompressGame } from "./mc_compress";
import { morphGame } from "./morph";
import { penaltyGame } from "./penalty";
import { seedGame } from "./seed";
import { shrinkRepairGame } from "./shrink_repair";
import { RUN_BUDGET } from "./types";
import type { MethodGame, RunProblem } from "./types";

export type { MethodGame, RunProblem, RunStage, RunView } from "./types";
export { RUN_BUDGET } from "./types";

/**
 * Every solver method the game runs, by its solver name (the name the server records, which a game
 * definition keeps: packages/geometry/src/provenance.ts). Each entry lives in the method's own file.
 */
export const METHOD_GAMES: Readonly<Record<EvolveMethod, MethodGame>> = {
  mc_compress: mcCompressGame,
  basin_hopping: basinHoppingGame,
  shrink_repair: shrinkRepairGame,
  seed: seedGame,
  penalty: penaltyGame,
  harden: hardenGame,
  asc: ascGame,
  morph: morphGame,
  ls_growth: lsGrowthGame,
};

/** How the game uses a method (its file in this folder); a name the game does not know gets every default. */
export const methodGame = (m: EvolveMethod): MethodGame => METHOD_GAMES[m] ?? {};

/** How player text names a method (its label, else its solver name). */
export const methodLabel = (m: string): string => methodGame(m as EvolveMethod).label ?? m;

/** Whether the player can choose the method: the Method list, Method match and the pipeline editor. */
export const isSelectable = (m: EvolveMethod): boolean => methodGame(m).selectable !== false;

/** The evaluations of a run's warm-up (its method's warmup), a whole number, 0 without one. */
export function warmupOf(m: EvolveMethod, params: Record<string, unknown>, p?: RunProblem): number {
  const w = methodGame(m).warmup?.(params, p) ?? 0;
  return Number.isFinite(w) && w > 0 ? Math.floor(w) : 0;
}

/**
 * The evaluations of a step, from the run's `before` to `after` evaluations, that lie within the
 * run's first `warmup`: max(0, min(after, W) − min(before, W)).
 */
export const warmIn = (warmup: number, before: number, after: number): number =>
  Math.max(0, Math.min(after, warmup) - Math.min(before, warmup));

/** What a new run of a method opens with: its parameters, its budget and its start. */
export interface RunSetup {
  params: Record<string, unknown>;
  budget: number;
  start: PackingConfig;
}

/**
 * A new run of `m` on `p`, from the player's parameters `base` (methodParams): the method's
 * runParams, runBudget and startFrom, or the defaults (`base`, RUN_BUDGET, the problem's board).
 */
export function runSetup(m: EvolveMethod, base: Record<string, unknown>, p: ProblemState): RunSetup {
  const g = methodGame(m);
  const q = needPolygon(p, "run parameters");
  const params = g.runParams ? g.runParams(base, { N: q.N, M: q.M, P: q.P, score: p.best }) : base;
  const budget = g.runBudget ? g.runBudget(params) : RUN_BUDGET;
  const start = g.startFrom ? g.startFrom(p) : p.board!;
  return { params, budget: Math.max(1, Math.floor(budget)), start };
}
