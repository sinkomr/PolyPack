import type { SpaceConfig } from "@polypack/spaces";
import type { SpaceFamily } from "./frontier";
import type { RunStage } from "./methods/types";

export type { SpaceConfig };

/**
 * A run of one of the generic methods (packages/methods) on a space problem, kept open in a lane
 * between clicks like a polygon run (open-run.ts). The page allows it game evaluations; each is
 * `unit` of the kernel's charged evaluations, so that a click does about as much work as a click on
 * the 2D board (FamilyRules.unitsPerEvaluation). The worker pauses the run between steps through
 * the method framework's stop poll, which needs the page to be cross-origin isolated.
 */
export interface SpaceRunRequest {
  family: SpaceFamily;
  /** The problem's catalogue id ("sphere/0/12"). */
  id: string;
  /** The generic method's name as packages/methods registers it ("mc_compress", "basin_hopping", ...). */
  method: string;
  params: Record<string, unknown>;
  /** Game evaluations the run may do in all. */
  budget: { evals: number };
  /** Kernel evaluations per game evaluation, a positive whole number. */
  unit: number;
  seed: number;
  /** The board it starts from (the problem's best), or null for a fresh arrangement made by the method. */
  start: SpaceConfig | null;
}

/** An open space run as the page sees it: the same fields as a polygon run's RunState, in game evaluations. */
export interface SpaceRunState {
  /** Game evaluations done so far (kernel evaluations / unit, rounded down). */
  evaluations: number;
  /** The best configuration the run kept (strict, by the server's rule) and its score. */
  best: SpaceConfig | null;
  score: number | null;
  /** The score of the latest configuration the method offered, null before any. */
  last: number | null;
  /** The best score the method found itself, its start excluded. */
  found: number | null;
  stage?: RunStage;
  ended: boolean;
  closed: boolean;
  error?: string;
}

/** Load all for a space problem: a finished seed layout, else a finished random start, made in the worker. */
export interface SpaceStartRequest {
  family: SpaceFamily;
  id: string;
  seed: number;
}
export type SpaceStartAnswer = { ok: true; config: SpaceConfig; score: number } | { ok: false; message: string };
