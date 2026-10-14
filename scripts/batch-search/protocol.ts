/** Messages between scripts/batch-search.ts and its worker threads (batch-search/worker.ts). */
import type { PackingConfig } from "@polypack/geometry";
import type { Budget, Problem } from "./lib";

export type WorkerRequest =
  { type: "run"; id: number; problem: Problem; method: string; seed: number; budget: Budget } | { type: "abort" };

export interface WorkerResult {
  type: "result";
  id: number;
  score: number | null;
  valid: boolean;
  strict: boolean;
  evaluations: number;
  wallTime: number;
  /** The solver's termination, or "crashed"/"timeout" when the worker thread had to be replaced. */
  termination: string;
  reasons: string[];
  best?: PackingConfig;
  /** The method's resolved parameters, recorded with a submission. */
  params?: Record<string, unknown>;
}
