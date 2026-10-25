/**
 * The pure parts of the board's space mode: the problem picker of each space (pick.ts), a problem
 * as the server sends it (checked, since it is untrusted input), the values shown beside the
 * drawing (facts.ts), the rounds a search runs and what the server's answer to a submission means.
 * No DOM in here.
 *
 * Wording follows the dimensions page (spaces-model.ts): "Certified value", "Status", "Lower bound",
 * "Site best", "Entries", and for 3D on 4D "Without folding" and "Folding gains".
 */
import { SCORE_TIE } from "@polypack/geometry";
import type { CertifiedStatus, SpaceConfig, SpaceName } from "@polypack/spaces";
import {
  BOUNDARY_ROUND_EVALS,
  type SearchProblem,
  type SpaceJob,
  type SpaceRule,
  SPACE_METHOD,
  buildSpaceKnown,
  checkSpaceConfig,
  mixSeed,
  parseSearchProblem,
  readSpaceConfig,
  statedScore,
} from "@polypack/spaces/search";
import { type FoldExtra, readFoldExtra } from "../boundary-model";
import { round6 } from "../spaces-model";

// ---------- the problem picker (pick.ts, shared with the 3D on 4D viewer) ----------

export { DEFAULT_PROBLEM, type PickField, fieldsOfId, pickProblem } from "./pick";

// ---------- a problem from the server ----------

/** A problem of a space as GET /api/spaces/:space/problems/<id> sends it, checked. */
export interface LoadedSpaceProblem {
  space: SpaceName;
  id: string;
  P: number;
  /** The id's fields, for the searches and the drawings. */
  search: SearchProblem;
  certified: { score: number; display: string; status: CertifiedStatus } | null;
  bound: { value: number; label: string } | null;
  site_best: { id: number; score: number; name: string; created_at: string } | null;
  /** The smaller of the certified value and the site best; null when there is neither. */
  best_score: number | null;
  accepts_submissions: boolean;
  status: CertifiedStatus | null;
  closed_reason: string | null;
  /** The better of the research record's and the site leader's configuration (the record on a tie). */
  best: { config: SpaceConfig; score: number; source: "certified" | "site" } | null;
  /** 3D on 4D: the best edge without folding (every piece inside one cell); null for the other kinds. */
  extra: FoldExtra | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const STATUSES: readonly CertifiedStatus[] = ["best_known", "proven", "infeasible"];
const text = (v: unknown, max = 400) => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * The problem in an answer, or a sentence saying why it cannot be used. A malformed configuration
 * only leaves that configuration out; the values the page shows must be well formed.
 */
export function readSpaceProblem(space: SpaceName, id: string, body: unknown): LoadedSpaceProblem | string {
  if (!isObject(body) || body.space !== space || body.id !== id) return "The server's answer is not this problem.";
  const search = parseSearchProblem(id);
  if (!search || search.space !== space) return "This problem cannot be searched on the board.";
  if (typeof body.accepts_submissions !== "boolean") return "The server's answer is malformed.";
  let certified: LoadedSpaceProblem["certified"] = null;
  if (body.certified != null) {
    const c = body.certified;
    if (!isObject(c) || !positive(c.score) || !STATUSES.includes(c.status as CertifiedStatus))
      return "The server's answer has a malformed certified value.";
    certified = {
      score: c.score,
      display: text(c.display, 40) || round6(c.score),
      status: c.status as CertifiedStatus,
    };
  }
  let site: LoadedSpaceProblem["site_best"] = null;
  if (body.site_best != null) {
    const b = body.site_best;
    if (!isObject(b) || !Number.isSafeInteger(b.id) || !positive(b.score))
      return "The server's answer has a malformed site best.";
    site = { id: b.id as number, score: b.score, name: text(b.name, 80), created_at: text(b.created_at, 40) };
  }
  const bound =
    isObject(body.bound) && positive(body.bound.value)
      ? { value: body.bound.value, label: text(body.bound.label) }
      : null;
  const status = STATUSES.includes(body.status as CertifiedStatus) ? (body.status as CertifiedStatus) : null;
  const certifiedConfig = body.certified_config == null ? null : readSpaceConfig(search, body.certified_config);
  const siteConfig = body.site_config == null ? null : readSpaceConfig(search, body.site_config);
  const known = buildSpaceKnown({
    certified,
    certified_config: certifiedConfig,
    site_best: site,
    site_config: siteConfig,
  });
  const values = [certified?.score, site?.score].filter((v): v is number => typeof v === "number");
  return {
    space,
    id,
    P: search.P,
    search,
    certified,
    bound,
    site_best: site,
    best_score: values.length ? Math.min(...values) : null,
    accepts_submissions: body.accepts_submissions,
    status,
    closed_reason:
      typeof body.closed_reason === "string" && body.closed_reason.trim() ? text(body.closed_reason) : null,
    best: known ? { ...known, score: statedScore(search, known.config) } : null,
    extra: space === "boundary" ? readFoldExtra(body.extra) : null,
  };
}

/** The rule a configuration of the problem must pass: the server's, with its bound and certified size. */
export const ruleOf = (p: LoadedSpaceProblem): SpaceRule => ({
  bound: p.bound?.value ?? null,
  certified: p.certified?.score ?? null,
});

/** True when a score beats the problem's best by more than the tie tolerance, as the server requires. */
export function beatsBest(p: LoadedSpaceProblem, score: number): boolean {
  return p.best_score === null || score < p.best_score * (1 - SCORE_TIE);
}

// ---------- what the panel shows ----------

/** The name of a configuration's score in this problem. */
export function scoreLabel(p: SearchProblem): string {
  switch (p.space) {
    case "surface":
      return "Edge s of the solid";
    case "curved":
      return p.M === 0 ? "Container radius r" : "Container side s";
    case "sphere":
      return "Sphere radius ρ";
    case "torus":
      return p.family === "free" ? "Cell √|det(b1, b2)|" : "Torus side L";
    case "boundary":
      return `${p.polytope.charAt(0).toUpperCase()}${p.polytope.slice(1)} edge s`;
  }
}

export { type ProblemFact, problemFacts } from "./facts";

/** What the drawing shows, in a few words. */
export function shownText(source: "certified" | "site" | "result" | "preview", p: LoadedSpaceProblem): string {
  if (source === "certified") return "the research record";
  if (source === "site") return `the site's best entry, by ${p.site_best?.name ?? "unknown"}`;
  if (source === "preview") return "the optimizer's best so far";
  return "the optimizer's result";
}

// ---------- the optimizer's rounds ----------

/** The kinds of search: one per space, and the planar search of nofold surface problems. */
export type SearchKind = SpaceName | "nofold";

export const searchKind = (p: SearchProblem): SearchKind =>
  p.space === "surface" && p.mode === "nofold" ? "nofold" : p.space;

/** The method a submission names. */
export const METHOD_NAME: Record<SearchKind, string> = {
  ...SPACE_METHOD,
  nofold: "surface nofold: basin hopping on one face",
};

/** The method in the panel's words. */
export const METHOD_TEXT: Record<SearchKind, string> = {
  surface:
    "Fold search: penalty compression on the solid, basin hopping and a contact polish, then the space's own validator.",
  nofold:
    "Every piece stays in one face, so the fullest face is a planar problem: basin hopping packs it, and the result is copied onto every face.",
  curved: "Penalty compression at curvature K, an LP polish and basin hopping, in rounds from the best so far.",
  sphere: "Penalty relaxation, the smallest valid radius by bisection with the space's validator, and basin hopping.",
  torus: "Penalty relaxation, the smallest valid lattice by bisection with the space's validator, and basin hopping.",
  boundary:
    "Penalty relaxation of the pieces across the cells, compression of the edge s, a polish, and hops between basins; every result passes the space's validator.",
};

/** What an evaluation counts in each search, for the budget's note. */
export const EVAL_UNIT: Record<SearchKind, string> = {
  surface: "one compression (a start or a hop)",
  nofold: "one evaluation of the polygon solver",
  curved: "one start or one hop",
  sphere: "one objective and gradient evaluation",
  torus: "one objective and gradient evaluation",
  boundary: "one evaluation of the penalty energy (a check of a whole packing counts as 500)",
};

/**
 * 3D on 4D rounds, in energy evaluations of the boundary search (packages/boundary/src/search: a
 * check of a whole packing counts as 500). A round is one complete search call: from a packing it
 * checks it, then compresses, polishes and hops; from nothing it builds its own starts first. Its
 * size is the job runner's (BOUNDARY_ROUND_EVALS, 300,000: about 1.5 to 2.2 s at P = 16, like a
 * sphere or torus round). [CALC] In Node on an Apple Silicon laptop (2026-10-25), 300,000 from
 * nothing took 1.0 to 2.5 s at P = 4 to 16 and found a valid packing each time.
 */
export const BOUNDARY_ROUND = BOUNDARY_ROUND_EVALS;
export const BOUNDARY_FRESH = BOUNDARY_ROUND_EVALS;
/** The panel's starting evaluations for a 3D on 4D problem, with a time limit of 30 s. */
export const BOUNDARY_BUDGET = 3000000;

/**
 * Evaluations per round. A run is a sequence of rounds, each a job of the space's search that
 * starts from the best so far with its own seed; the page sees the best after every round, and
 * pause and stop end the worker at once.
 *
 * A sphere or torus job first relaxes its start and finds its tight size, and only then hops
 * between basins, so a short round does not leave a tight packing. [CALC] From a tight packing
 * (a fresh result of seed 4), ten rounds of 2,000 left sphere/4/30 at 1.819980 and
 * torus/free/4/12 at 3.905795; two rounds of 10,000 reached 1.737518 to 1.774667 and 3.464102 to
 * 3.793237 over seeds 9 to 11. On an Apple Silicon laptop such a round took 2 to 3 s; curved
 * rounds (one start and 8 hops) 1 to 1.7 s; fold rounds of 4 compressions 1 to 8 s at 12 to 14
 * pieces and 141 s at 80, so large solids get 2.
 */
export const ROUND_EVALS: Record<SearchKind, number> = {
  surface: 4,
  nofold: 5000,
  curved: 9,
  sphere: 10000,
  torus: 10000,
  boundary: BOUNDARY_ROUND,
};

/** Pieces from which a fold round has 2 compressions instead of 4. */
export const LARGE_FOLD = 40;

/**
 * Evaluations of a round with no start (a new arrangement), doubled after each such round that
 * found nothing. [CALC] From nothing, sphere and torus searches found a valid packing in 5 of 5
 * seeds at 10,000 evaluations on sphere/0/12, sphere/4/30, torus/sq/5/7 and torus/free/4/12, but
 * mostly none at 2,000 (2 of 12 at 5,000); curved and fold rounds of the usual size found one.
 */
export const FRESH_EVALS: Record<SearchKind, number> = {
  surface: 4,
  nofold: 5000,
  curved: 9,
  sphere: 10000,
  torus: 10000,
  boundary: BOUNDARY_FRESH,
};

/**
 * How many times its usual size a round may grow while the rounds before it get nowhere (each
 * such round doubles the next): a longer job hops further from a basin it cannot leave in a short
 * one. [CALC] From the same tight sphere/4/30 packing one job reached 1.782039 with 10,000
 * evaluations and 1.731272 with 40,000. Fold rounds of many pieces are already slow.
 */
export const GROW_LIMIT: Record<SearchKind, number> = {
  surface: 2,
  nofold: 4,
  curved: 4,
  sphere: 4,
  torus: 4,
  // at most 900,000: a round of a million takes several seconds
  boundary: 3,
};

/** The evaluations of a round of this problem that starts from a packing. */
export function roundSize(p: SearchProblem): number {
  return p.space === "surface" && p.mode === "fold" && p.P >= LARGE_FOLD ? 2 : ROUND_EVALS[searchKind(p)];
}

/**
 * The panel's starting budget for a problem: a time limit first, and evaluations. Fold surfaces
 * get fewer evaluations as they grow (480 / P, from 8 to 40), since a compression of many pieces
 * takes long: [CALC] about 35 s each at 80 pieces.
 */
export function defaultBudget(p: SearchProblem): { time_s: number; evals: number } {
  const kind = searchKind(p);
  if (kind === "surface") return { time_s: 60, evals: Math.max(8, Math.min(40, Math.round(480 / p.P))) };
  return {
    nofold: { time_s: 15, evals: 30000 },
    curved: { time_s: 30, evals: 90 },
    sphere: { time_s: 15, evals: 20000 },
    torus: { time_s: 15, evals: 20000 },
    boundary: { time_s: 30, evals: BOUNDARY_BUDGET },
  }[kind as Exclude<SearchKind, "surface">];
}

/**
 * The most evaluations the panel takes for a run. A 3D on 4D evaluation is cheap (one sweep of the
 * penalty energy, 3 to 8 microseconds at 4 to 16 pieces: [CALC] see BOUNDARY_ROUND), so its
 * limit is higher: 100 million take about 6 to 13 minutes.
 */
export const EVALS_MAX: Record<SearchKind, number> = {
  surface: 1_000_000,
  nofold: 1_000_000,
  curved: 1_000_000,
  sphere: 1_000_000,
  torus: 1_000_000,
  boundary: 100_000_000,
};

/** Active seconds a round may take when the budget has no time limit (it ends on its evaluations). */
export const ROUND_TIME_CAP = 3600;

export interface RunSettings {
  seed: number;
  /** Evaluations in the search's own unit (EVAL_UNIT); time_s ends the run after that many active seconds. */
  budget: { evals: number; time_s?: number };
  /** True to let the first round build its own start instead of starting from the shown packing. */
  fresh: boolean;
}

/**
 * Round k of a run: a job of the space's search with seed mixSeed(seed, k), started from the best
 * so far (or nothing, for a fresh start), with the round's evaluations and at most the time left.
 * A run that ends on its evaluations is therefore reproducible from its start, seed and budget.
 *
 * A round never uses more evaluations than `evals`, and the run's rounds never more than its
 * budget: null means that no round fits in what is left. A fold job's cap counts its hops, and its
 * start (or its two random starts) is compressed first, so the job is asked for that many fewer.
 * `tries` counts the rounds before this one that got nowhere: without a start, rounds that found
 * nothing; from a start, rounds that did not improve on it. Each doubles the next round, up to
 * GROW_LIMIT times its size, since a tight packing needs a longer search to leave its basin.
 */
export function roundJob(
  p: SearchProblem,
  rule: SpaceRule,
  run: RunSettings,
  k: number,
  used: { evals: number; seconds: number },
  start: SpaceConfig | null,
  tries = 0,
): { job: SpaceJob; evals: number } | null {
  const kind = searchKind(p);
  const fold = kind === "surface";
  const least = fold && !start ? 2 : 1;
  const left = run.budget.evals - used.evals;
  if (left < least) return null;
  const size = (start ? roundSize(p) : FRESH_EVALS[kind]) * Math.min(GROW_LIMIT[kind], 2 ** Math.min(tries, 20));
  const evals = Math.max(least, Math.min(size, left));
  const time_s =
    run.budget.time_s === undefined
      ? ROUND_TIME_CAP
      : Math.max(0.05, Math.min(ROUND_TIME_CAP, run.budget.time_s - used.seconds));
  const job: SpaceJob = {
    space: p.space,
    id: p.id,
    method: METHOD_NAME[kind],
    seed: mixSeed(run.seed, k),
    budget: { time_s, evals: fold ? evals - (start ? 1 : 2) : evals },
    rule,
    kind: start ? "iterate" : "fresh",
    ...(start ? { start } : {}),
  };
  return { job, evals };
}

/** The server's check of a configuration for this problem (validateSpaceSubmission with its bound and certified size). */
export const checkFor = (p: LoadedSpaceProblem, config: SpaceConfig) =>
  checkSpaceConfig(p.space, p.id, config, ruleOf(p));

// ---------- the server's answer to a submission ----------

export interface SubmitAnswer {
  /** "kept": stored as the problem's best; "not-kept": valid, not better; "closed", "invalid", "busy", "error". */
  kind: "kept" | "not-kept" | "closed" | "invalid" | "busy" | "error";
  text: string;
}

/** The board's sentence for POST /api/spaces/submit's answer (status null: no answer). */
export function submitAnswer(status: number | null, body: unknown): SubmitAnswer {
  const b = isObject(body) ? body : {};
  const reasons = Array.isArray(b.reasons) ? b.reasons.filter((r) => typeof r === "string").slice(0, 5) : [];
  const why = reasons.length ? reasons.join("; ") : "";
  if (status === null) return { kind: "error", text: "✗ The server could not be reached. Nothing was stored." };
  if (status === 200 && b.valid === true) {
    const score = positive(b.score) ? round6(b.score) : "?";
    if (b.id !== null && b.id !== undefined && b.leader === true)
      return {
        kind: "kept",
        text:
          `✓ Kept. Server score ${score}. This is now the best entry for this problem.` +
          (b.beats_certified === true ? " It beats the research record." : ""),
      };
    const best = positive(b.best_score) ? ` ${round6(b.best_score)}` : "";
    return {
      kind: "not-kept",
      text: `✓ Valid, score ${score}, but not kept: it does not beat the problem's best${best} by more than a relative ${SCORE_TIE}.`,
    };
  }
  if (status === 409) return { kind: "closed", text: `✗ This problem takes no entries${why ? `: ${why}` : ""}.` };
  if (status === 422 || status === 400)
    return { kind: "invalid", text: `✗ Not accepted: ${why || `the server answered ${status}`}.` };
  if (status === 429 || status === 503)
    return {
      kind: "busy",
      text: `✗ ${why ? why.charAt(0).toUpperCase() + why.slice(1) : "The server is busy"}. Nothing was stored; try again later.`,
    };
  return { kind: "error", text: `✗ The server answered ${status}${why ? `: ${why}` : ""}.` };
}
