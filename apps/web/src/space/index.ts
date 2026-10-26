/**
 * The spaces as a small interface: open a problem, draw a packing, search from it, check a
 * result and submit it. The board's space mode (mode.ts) is built on it, and another page can use
 * it the same way (docs/spaces/BOARD.md describes how the Tighter game could after a prestige
 * reset). Import it with a dynamic import(): it holds the spaces' geometry and validators.
 *
 *   const p = await openSpaceProblem("sphere/4/12");          // a handle, or why not
 *   if (typeof p === "string") throw new Error(p);
 *   const view = p.render(host);                              // a drawing with its toolbar
 *   view.show(p.problem.best?.config ?? null);
 *   const run = p.search(p.problem.best?.config ?? null, {
 *     seed: 1, budget: { evals: 20000, time_s: 15 }, fresh: false,
 *     method: "auto",                                         // or a name from p.methods()
 *     onProgress: (q) => q.improved && view.show(q.best!.config),
 *   });                                                       // run.pause(), run.resume(), run.stop()
 *   const { best } = await run.done;
 *   if (best && p.validate(best.config).valid && p.improves(best.score))
 *     console.log(await p.submit(best.config, { name: "me", method: p.methodName("auto"), seed: 1 }));
 */
import type { SpaceConfig } from "@polypack/spaces";
import { type SpaceCheck, type SpaceMethodInfo, searchMethodName } from "@polypack/spaces/search";
import { parseSpaceAddress } from "../space-address";
import { type SpaceSubmitFields, listSpaceProblems, loadSpaceProblem, submitSpaceConfig } from "./load";
import {
  type LoadedSpaceProblem,
  METHOD_NAME,
  type SubmitAnswer,
  beatsBest,
  boardMethods,
  checkFor,
  ruleOf,
  searchKind,
} from "./model";
import { type SpaceSearch, type SpaceSearchOptions, startSpaceSearch } from "./search";
import { type SpaceView, mountSpaceView } from "./view";

export interface SpaceProblemHandle {
  /** The problem as the server sent it, checked: its values, rule and best configuration. */
  readonly problem: LoadedSpaceProblem;
  /** The name of the problem's own search (Auto), as a submission names it. */
  readonly method: string;
  /** The methods a run can use: Auto first, then the problem's generic (or, for nofold, polygon) methods. */
  methods(): SpaceMethodInfo[];
  /** The name a submission gives a result of `method` ("sphere basin_hopping"; Auto's is `method` above). */
  methodName(method: string): string;
  /** Draws the problem's packings in `host` (emptied first). */
  render(host: HTMLElement): SpaceView;
  /**
   * Searches from `start` (or a fresh start with options.fresh) in a Web Worker, in rounds with
   * the given seed, budget and method (options.method, default Auto, with options.params). The
   * rule (the problem's bound and certified size) is the problem's.
   */
  search(start: SpaceConfig | null, options: Omit<SpaceSearchOptions, "rule">): SpaceSearch;
  /** The server's check of a configuration of this problem (validateSpaceSubmission). */
  validate(config: SpaceConfig): SpaceCheck;
  /** True when a score beats the problem's best by more than the tie tolerance, as the server requires. */
  improves(score: number): boolean;
  /** POST /api/spaces/submit and what the answer means (kept, not kept, closed, invalid, busy, error). */
  submit(config: SpaceConfig, fields: SpaceSubmitFields): Promise<SubmitAnswer & { status: number | null }>;
}

let nofoldReady: Promise<void> | null = null;

/**
 * Loads the polygon solver's methods that nofold problems offer (a chunk of its own, with the
 * solver). Before it is done, or when it cannot be loaded, a nofold problem offers Auto alone.
 */
export function loadNofoldMethods(): Promise<void> {
  nofoldReady ??= import("@polypack/spaces/search/nofold-methods").then(
    (m) => m.useNofoldMethods(),
    () => {
      // a later problem tries again
      nofoldReady = null;
    },
  );
  return nofoldReady;
}

/**
 * A handle on a loaded problem. For a nofold problem, its methods include the polygon solver's
 * only once loadNofoldMethods() is done (openSpaceProblem waits for it).
 */
export function spaceProblemHandle(problem: LoadedSpaceProblem): SpaceProblemHandle {
  let methods: SpaceMethodInfo[] | null = null;
  return {
    problem,
    method: METHOD_NAME[searchKind(problem.search)],
    // built once: it may build the problem's kernel
    methods: () => (methods ??= boardMethods(problem.search)),
    methodName: (method) => searchMethodName(problem.search, method),
    render: (host) => mountSpaceView(host, problem.search),
    search: (start, options) => startSpaceSearch(problem.search, start, { ...options, rule: ruleOf(problem) }),
    validate: (config) => checkFor(problem, config),
    improves: (score) => beatsBest(problem, score),
    submit: (config, fields) => submitSpaceConfig(problem, config, fields),
  };
}

/** Loads a problem by its id ("sphere/0/12", "curved/-1/3/4/5", ...): a handle, or why it could not be loaded. */
export async function openSpaceProblem(id: string): Promise<SpaceProblemHandle | string> {
  const where = parseSpaceAddress(`#space=${id}`);
  if (!where?.id) return `${id} is not a problem id the board can show.`;
  const p = await loadSpaceProblem(where.space, where.id);
  if (typeof p === "string") return p;
  if (searchKind(p.search) === "nofold") await loadNofoldMethods();
  return spaceProblemHandle(p);
}

export { listSpaceProblems, loadSpaceProblem, submitSpaceConfig };
export type { SpaceSubmitFields, LoadedSpaceProblem, SubmitAnswer, SpaceSearch, SpaceSearchOptions, SpaceView };
export {
  DEFAULT_PROBLEM,
  EVAL_UNIT,
  genericRound,
  boardMethods,
  evalUnit,
  FRESH_EVALS,
  freshSize,
  ROUND_EVALS,
  defaultBudget,
  pickProblem,
  roundSize,
  searchKind,
} from "./model";
export type { SpaceCandidate, SpaceSearchProgress, SpaceSearchResult } from "./search";
