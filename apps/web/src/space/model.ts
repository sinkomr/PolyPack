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
import type { CertifiedStatus, SpaceConfig, SpaceName, SpaceProblemStatus } from "@polypack/spaces";
import { SPACE_RECORD_MARGIN, improvesSpaceBest } from "@polypack/spaces";
import { getProblem as getPolyhedraProblem, getSolid as getPolyhedraSolid } from "@polypack/polyhedra";
import { ballsProblemOf } from "@polypack/balls/catalogue";
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

export { DEFAULT_PROBLEM, type PickField, fieldsOfId, pickFromDomain, pickProblem } from "./pick";

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
  /** The problem's status; `no_record` when it has no research record yet (then `certified` is null). */
  status: SpaceProblemStatus | null;
  closed_reason: string | null;
  /** The better of the research record's and the site leader's configuration (the record on a tie). */
  best: { config: SpaceConfig; score: number; source: "certified" | "site" } | null;
  /** 3D on 4D: the best edge without folding (every piece inside one cell); null for the other kinds. */
  extra: FoldExtra | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const STATUSES: readonly CertifiedStatus[] = ["best_known", "proven", "infeasible"];
const PROBLEM_STATUSES: readonly SpaceProblemStatus[] = [...STATUSES, "no_record"];
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
  const status = PROBLEM_STATUSES.includes(body.status as SpaceProblemStatus)
    ? (body.status as SpaceProblemStatus)
    : null;
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

/**
 * The rule a configuration of the problem must pass: the server's, with its bound and certified size, and for a
 * problem without a research record the strict check of every entry.
 */
export const ruleOf = (p: LoadedSpaceProblem): SpaceRule => ({
  bound: p.bound?.value ?? null,
  certified: p.certified?.score ?? null,
  ...(p.status === "no_record" ? { noRecord: true } : {}),
});

/** The board's words for a problem without a research record or a site entry yet. */
export const NO_RECORD_TEXT = "No record yet: run the optimizer or submit one.";

/**
 * True when a score would be kept, as the server decides: it beats the site's best by more than
 * the tie tolerance and the research record by more than the space's record margin (the tie
 * tolerance too, except in the polyhedra space, whose records are kept with a relative margin of
 * 1e-6: SPACE_RECORD_MARGIN).
 */
export function beatsBest(p: LoadedSpaceProblem, score: number): boolean {
  return improvesSpaceBest(p.space, score, p.certified?.score ?? null, p.site_best?.score ?? null);
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
    case "polyhedra":
      return "Container scale s";
    case "balls":
      return ballsProblemOf(p.code)?.container === "cube" ? "Cube edge s" : "Container radius s";
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
  polyhedra:
    "Soft hops of a soft-to-rigid simulator and random jiggles from the best so far, each polished by a separating-plane penalty method, then the space's own validator.",
  balls:
    "Basin hopping from the best so far: move or shake some pieces, then a penalty method with the container's size as a variable (separating planes for solids), scaled apart to an exact clearance, then the space's own validator.",
};

/** What an evaluation counts in each search, for the budget's note. */
export const EVAL_UNIT: Record<SearchKind, string> = {
  surface: "one compression (a start or a hop)",
  nofold: "one evaluation of the polygon solver",
  curved: "one start or one hop",
  sphere: "one objective and gradient evaluation",
  torus: "one objective and gradient evaluation",
  boundary: "one evaluation of the penalty energy (a check of a whole packing counts as 500)",
  polyhedra: "one simulator step or one evaluation of the polish",
  balls: "one evaluation of the penalty and its gradient",
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
  // polyhedra and balls rounds depend on P and the piece (polyhedraRound, ballsRound); these are no sizes of theirs
  polyhedra: 10000,
  balls: 10000,
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
  polyhedra: 10000,
  balls: 10000,
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
  polyhedra: 2,
  balls: 2,
};

/**
 * The rounds of a polyhedra search (packages/polyhedra search.ts): a polish of its start (only in a
 * run's first round: later rounds start from the best so far, which the search has polished, and
 * take it as it is), then hops from the best so far, soft hops of its simulator (3,800 + 120 P steps
 * and a polish, shortened to 60 % of the evaluations left when fewer are left, and none below a
 * tenth of their length) and jiggles (a polish).
 *
 * Costs [CALC], measured from the records at P = 100 on an idle Apple Silicon laptop (20 problems
 * from tetrahedra to disdyakis triacontahedra): a simulator step took P (3.3 + 0.14 f + 0.0021 v f)
 * microseconds, to within a factor 1.4, for a solid of v vertices and f faces: 0.3 ms for 100
 * tetrahedra, 0.6 ms for 100 cubes, 2.8 ms for 100 truncated icosidodecahedra (v 120, f 62) and
 * 3.6 ms for 100 disdyakis triacontahedra (v 62, f 120); a step of a long soft hop costs up to twice
 * that, and a polish evaluation a sixth to a twelfth. A heavily loaded machine ran 3.4 times slower.
 * The rounds are sized for a machine 3.5 times slower than the fit (stepMs): room for a polish of
 * the start (300 + 15 P evaluations, at most 1,800; the start's own polish took 1,200 to 1,700 at
 * P = 100), then simulator steps for 8 s there, two whole hops at most; a round that could make a
 * soft hop longer than about 18 s there is cut to one that cannot. So a round of 100 of the largest
 * solids has about 2,600 evaluations, too few for a soft hop: it jiggles, a second or two on the
 * laptop. The sizes depend on the problem only, so a run that ends on its evaluations stays
 * reproducible.
 *
 * A round with no start first runs the simulator's soft-to-rigid schedule (search.ts: up to 53,000
 * steps at P = 100), shortened to 40 % of the round: it gets the whole schedule when that fits in
 * about 20 s on the slow machine, and otherwise as much as fits.
 */
export function polyhedraRound(P: number, code: string): { round: number; fresh: number; stepMs: number } {
  const problem = getPolyhedraProblem(code);
  const solid = problem ? getPolyhedraSolid(problem.piece) : null;
  const v = solid?.nv ?? 8;
  const f = solid?.faces.length ?? 6;
  const stepMs = (3.5 * P * (3.3 + 0.14 * f + 0.0021 * v * f)) / 1000;
  const polish = Math.min(1800, 300 + 15 * P);
  const hop = 7000 + 130 * P;
  const k = (n: number) => 100 * Math.floor(n / 100);
  let round = Math.min(2 * hop, polish + 8000 / stepMs);
  // from this many evaluations a round can make a soft hop (search.ts: a tenth of one, on 60 % of what is left)
  const softFrom = (0.1 * (3800 + 120 * P)) / 0.6;
  // one that would take more than 18 s there is cut: to 15 s of steps, or to jiggles alone
  if (round >= softFrom && 1.2 * round * stepMs > 18000)
    round = Math.max(15000 / stepMs, Math.min(round, softFrom - 1));
  round = Math.max(1000, k(round));
  const schedule = Math.min(5000, 600 + 60 * P) + Math.min(45000, 4000 + 600 * P) + Math.min(3000, 500 + 50 * P);
  const fresh = Math.max(round, k(Math.min(schedule / 0.4, 33000 / stepMs)));
  return { round, fresh, stepMs };
}

/**
 * Seconds a polyhedra round of `evals` takes at most on the slow machine of polyhedraRound (3.5 times
 * the measured costs): a soft
 * hop on 60 % of it at twice the step cost, when the round has room for one, and the rest polish at
 * a fifth of a step (a generous bound: a polish evaluation cost a sixth to a twelfth of a step).
 */
export function polyhedraRoundSeconds(P: number, code: string, evals: number): number {
  const { stepMs } = polyhedraRound(P, code);
  // search.ts makes a soft hop only with 60 % of what is left at least a tenth of its length
  const soft = 0.6 * evals >= 0.1 * (3800 + 120 * P) ? 0.6 * evals : 0;
  return (soft * 2 * stepMs + ((evals - soft) * stepMs) / 5) / 1000;
}

/**
 * The rounds of a balls search (packages/balls search.ts): a polish of its start in a run's first round, then hops
 * from the best so far, each a polish of a few thousand evaluations at most (10 penalty stages of up to 300 + 10 P
 * L-BFGS iterations for balls; 9 of up to 400 for solids, whose stages also list their near pairs).
 *
 * Costs [CALC] (packages/balls/scripts/bench.ts: runs of 30,000 evaluations from a new start, wall time with the
 * work between evaluations, Node 26 on an Apple Silicon laptop beside other jobs, 2026-10-25): an evaluation of P
 * balls took about 0.6 + 0.15 P microseconds (2.2 at 10 balls, 15.4 at 100), one of P solids about k P with
 * k = 1.8 for tetrahedra, 1.3 for cubes, 1.2 for octahedra and dodecahedra and 1.0 for icosahedra (the largest
 * ratio over P = 10, 30, 60, 100; 182 microseconds at 100 tetrahedra, 118 at 100 dodecahedra). A round is sized to
 * about 2 s of that (3 s for solids), at least 20,000 (10,000) and at most 300,000 (200,000) evaluations: so
 * 300,000 at 13 balls (about 0.8 s), 128,000 at 100 balls, 25,000 at 100 dodecahedra and 16,000 at 100 tetrahedra.
 * A round with no start is as long: its new start is one polish. The sizes depend on the problem only, so a run that
 * ends on its evaluations stays reproducible.
 */
const BALLS_SOLID_EVAL_US: Record<string, number> = {
  tetrahedron: 1.8,
  cube: 1.3,
  octahedron: 1.2,
  dodecahedron: 1.2,
  icosahedron: 1.0,
};

export function ballsRound(P: number, code: string): { round: number; fresh: number; evalUs: number } {
  const problem = ballsProblemOf(code);
  const k = (n: number) => 1000 * Math.floor(n / 1000);
  if (!problem || problem.piece === "ball") {
    const evalUs = 0.6 + 0.15 * P;
    const round = k(Math.max(20000, Math.min(300000, 2e6 / evalUs)));
    return { round, fresh: round, evalUs };
  }
  const evalUs = P * BALLS_SOLID_EVAL_US[problem.piece];
  const round = k(Math.max(10000, Math.min(200000, 3e6 / evalUs)));
  return { round, fresh: round, evalUs };
}

/** The evaluations of a round of this problem that starts from a packing. */
export function roundSize(p: SearchProblem): number {
  if (p.space === "polyhedra") return polyhedraRound(p.P, p.code).round;
  if (p.space === "balls") return ballsRound(p.P, p.code).round;
  return p.space === "surface" && p.mode === "fold" && p.P >= LARGE_FOLD ? 2 : ROUND_EVALS[searchKind(p)];
}

/** The evaluations of a round of this problem with no start (a new arrangement). */
export function freshSize(p: SearchProblem): number {
  if (p.space === "balls") return ballsRound(p.P, p.code).fresh;
  return p.space === "polyhedra" ? polyhedraRound(p.P, p.code).fresh : FRESH_EVALS[searchKind(p)];
}

/**
 * The panel's starting budget for a problem: a time limit first, and evaluations. Fold surfaces
 * get fewer evaluations as they grow (480 / P, from 8 to 40), since a compression of many pieces
 * takes long: [CALC] about 35 s each at 80 pieces.
 */
export function defaultBudget(p: SearchProblem): { time_s: number; evals: number } {
  const kind = searchKind(p);
  if (kind === "surface") return { time_s: 60, evals: Math.max(8, Math.min(40, Math.round(480 / p.P))) };
  if (p.space === "polyhedra") {
    // ten rounds, and time for five on the slow machine of polyhedraRound (at least a minute, at
    // most the panel's 300 s): on a usual machine the ten end first
    const { round } = polyhedraRound(p.P, p.code);
    const time_s = Math.max(60, Math.min(300, 30 * Math.ceil((5 * polyhedraRoundSeconds(p.P, p.code, round)) / 30)));
    return { time_s, evals: 10 * round };
  }
  // ten rounds of about 2 to 3 s here, with room for a machine several times slower
  if (p.space === "balls") return { time_s: 60, evals: 10 * ballsRound(p.P, p.code).round };
  return {
    nofold: { time_s: 15, evals: 30000 },
    curved: { time_s: 30, evals: 90 },
    sphere: { time_s: 15, evals: 20000 },
    torus: { time_s: 15, evals: 20000 },
    boundary: { time_s: 30, evals: BOUNDARY_BUDGET },
  }[kind as Exclude<SearchKind, "surface" | "polyhedra" | "balls">];
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
  // [CALC] at 0.03 to 3 ms an evaluation (polyhedraRound), 10 million take 5 minutes at 11 cubes and
  // hours at 100 of the largest solids, where the time limit ends the run first
  polyhedra: 10_000_000,
  // [CALC] at 1 to 110 microseconds an evaluation (ballsRound), 10 million take 10 s to 20 minutes
  balls: 10_000_000,
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
 * `startPolished` says that the start is the best of an earlier round (job.polished).
 */
export function roundJob(
  p: SearchProblem,
  rule: SpaceRule,
  run: RunSettings,
  k: number,
  used: { evals: number; seconds: number },
  start: SpaceConfig | null,
  tries = 0,
  startPolished = false,
): { job: SpaceJob; evals: number } | null {
  const kind = searchKind(p);
  const fold = kind === "surface";
  const least = fold && !start ? 2 : 1;
  const left = run.budget.evals - used.evals;
  if (left < least) return null;
  const size = (start ? roundSize(p) : freshSize(p)) * Math.min(GROW_LIMIT[kind], 2 ** Math.min(tries, 20));
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
    // the best of an earlier round is this search's own result: it is not polished again
    ...(start && startPolished ? { polished: true } : {}),
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

/**
 * The board's sentence for POST /api/spaces/submit's answer (status null: no answer). `space`
 * names the margin a research record is beaten by (SPACE_RECORD_MARGIN).
 */
export function submitAnswer(status: number | null, body: unknown, space?: SpaceName): SubmitAnswer {
  const b = isObject(body) ? body : {};
  const reasons = Array.isArray(b.reasons) ? b.reasons.filter((r) => typeof r === "string").slice(0, 5) : [];
  const why = reasons.length ? reasons.join("; ") : "";
  if (status === null) return { kind: "error", text: "✗ The server could not be reached. Nothing was stored." };
  // a score that could not be kept is answered without a check (polyhedra; see the API page)
  if (status === 200 && b.checked === false) {
    const score = positive(b.score) ? round6(b.score) : "?";
    const best = positive(b.best_score) ? ` ${round6(b.best_score)}` : "";
    const margin = space ? SPACE_RECORD_MARGIN[space] : SCORE_TIE;
    return {
      kind: "not-kept",
      text: `✗ Not kept, and not checked: the score ${score} does not beat the problem's best${best} (the site's best by more than a relative ${SCORE_TIE}, the research record by more than a relative ${margin.toExponential()}).`,
    };
  }
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
    const margin = space ? SPACE_RECORD_MARGIN[space] : SCORE_TIE;
    return {
      kind: "not-kept",
      text:
        margin === SCORE_TIE
          ? `✓ Valid, score ${score}, but not kept: it does not beat the problem's best${best} by more than a relative ${SCORE_TIE}.`
          : `✓ Valid, score ${score}, but not kept: it does not beat the problem's best${best} (the site's best by more than a relative ${SCORE_TIE}, the research record by more than a relative ${margin.toExponential()}).`,
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
