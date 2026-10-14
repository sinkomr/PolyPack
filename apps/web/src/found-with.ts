import { MAX_METHOD_PARAMS_BYTES, utf8Length } from "@polypack/geometry";
import type { FoundWith, RunBudget } from "@polypack/geometry";

/** The short label shown with an entry; empty for entries stored before it was recorded. */
export function foundWithLabel(found: FoundWith | null | undefined): string {
  switch (found) {
    case "hand":
      return "by hand";
    case "optimizer":
      return "PolyPack optimizer";
    case "optimizer_edited":
      return "optimizer, then edited";
    case "external":
      return "own software";
    default:
      return "";
  }
}

/** The optimizer run behind an accepted result: what POST /api/submit records about it. */
export interface RunInfo {
  method: string;
  /** Resolved parameters of the run. */
  params?: Record<string, unknown>;
  seed?: number;
  budget?: RunBudget;
}

/** How the board's current pieces came about. */
export type Attribution = { found_with: "hand" } | { found_with: "optimizer" | "optimizer_edited"; run: RunInfo };

export const HAND: Attribution = { found_with: "hand" };

/**
 * How the board changed: an edit (moving, adding, rotating or removing pieces, changing the
 * problem), a load of a configuration from elsewhere (an entry, a record, an import, a share link),
 * or a step through the undo history (and the restore of the saved board on reload).
 */
export type BoardChange = "edit" | "load" | "history";

/**
 * Attribution of the board after a change, decided from the board itself and its lineage:
 *  - a board that is exactly an accepted optimizer result is that result ("optimizer");
 *  - an empty board, and a board loaded from elsewhere, are the user's ("hand");
 *  - an edit of an optimizer board, or of an edited one, is "optimizer_edited" with the same run;
 *  - a step through the history returns to what that board was when it was made (`recorded`),
 *    or to "hand" when nothing was recorded for it.
 * `previous` is the attribution before the change, `accepted` the run when the new board is
 * exactly an accepted result.
 */
export function attributionAfter(opts: {
  change: BoardChange;
  previous: Attribution;
  accepted?: RunInfo;
  recorded?: Attribution;
  empty: boolean;
}): Attribution {
  if (opts.accepted) return { found_with: "optimizer", run: opts.accepted };
  if (opts.empty || opts.change === "load") return HAND;
  if (opts.change === "history") return opts.recorded ?? HAND;
  return opts.previous.found_with === "hand" ? HAND : { found_with: "optimizer_edited", run: opts.previous.run };
}

/**
 * The fields of POST /api/submit that say how the board was found. Parameters larger than the
 * server accepts (a seed method given a whole record, say) are left out rather than refused.
 */
export function submissionFields(a: Attribution): {
  found_with: Attribution["found_with"];
  method?: string;
  method_params?: Record<string, unknown>;
  seed?: number;
  budget?: RunBudget;
} {
  if (a.found_with === "hand") return { found_with: "hand" };
  const { method, params, seed, budget } = a.run;
  return {
    found_with: a.found_with,
    method,
    ...(params && utf8Length(JSON.stringify(params)) <= MAX_METHOD_PARAMS_BYTES ? { method_params: params } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(budget ? { budget } : {}),
  };
}

/**
 * A run read back from storage, or undefined when it is malformed. Older pages stored a note such
 * as `asc; seed 1; budget {"evals":100}` instead; its method, seed and budget are recovered.
 */
export function readRun(value: unknown): RunInfo | undefined {
  if (typeof value === "string") {
    // the note was cut at 200 characters, so the budget may be missing or incomplete
    const m = /^([a-z_]+); seed (\d+)(?:; budget (.*))?$/.exec(value);
    if (!m) return undefined;
    let budget: unknown;
    try {
      budget = JSON.parse(m[3] ?? "null");
    } catch {
      budget = null;
    }
    return withBudget({ method: m[1], seed: Number(m[2]) }, budget);
  }
  if (!isRecord(value) || typeof value.method !== "string" || !/^[a-z_]+$/.test(value.method)) return undefined;
  const run: RunInfo = { method: value.method };
  if (isRecord(value.params)) run.params = value.params;
  if (Number.isSafeInteger(value.seed) && (value.seed as number) >= 0) run.seed = value.seed as number;
  return withBudget(run, value.budget);
}

/** Adds the budget when it has the shape the server accepts; storage is not trusted. */
function withBudget(run: RunInfo, value: unknown): RunInfo {
  if (!isRecord(value)) return run;
  const budget: RunBudget = {};
  if (Number.isSafeInteger(value.evals) && (value.evals as number) > 0) budget.evals = value.evals as number;
  if (typeof value.time_s === "number" && Number.isFinite(value.time_s) && value.time_s > 0)
    budget.time_s = value.time_s;
  return Object.keys(budget).length ? { ...run, budget } : run;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
