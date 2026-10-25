/**
 * The pure parts of the board's space mode: the problem picker of each space, a problem as the
 * server sends it (checked, since it is untrusted input), the values shown beside the drawing, the
 * rounds a search runs and what the server's answer to a submission means. No DOM in here.
 *
 * Wording follows the spaces page (spaces-model.ts): "Certified value", "Status", "Lower bound",
 * "Site best", "Entries".
 */
import { SCORE_TIE } from "@polypack/geometry";
import type { CertifiedStatus, SpaceConfig, SpaceName } from "@polypack/spaces";
import {
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
import {
  type FieldSpec,
  SPACE_FIELDS,
  day,
  entriesText,
  fieldValues,
  plainBoundLabel,
  problemStatus,
  round6,
  statusLabel,
} from "../spaces-model";

// ---------- the problem picker ----------

/** The problem a space opens with when the address names none (the first listed one when it is missing). */
export const DEFAULT_PROBLEM: Record<SpaceName, string> = {
  surface: "surface/cube/fold/0/10",
  curved: "curved/-1/3/4/5",
  sphere: "sphere/4/12",
  torus: "torus/sq/5/7",
};

/** Labels of the picker's fields, in the board's words ("Piece (N)", "Pieces (P)"). */
const PICK_LABELS: Record<string, string> = {
  solid: "Solid",
  mode: "Folding",
  N: "Piece (N)",
  K: "Curvature (K)",
  M: "Container (M)",
  family: "Torus",
  P: "Pieces (P)",
};

export interface PickField {
  key: string;
  label: string;
  options: { value: string; text: string }[];
  value: string;
}

/** The picker's fields of a space: the id's fields as the spaces page lists them, and P. */
function pickSpecs(space: SpaceName): FieldSpec[] {
  const p: FieldSpec = {
    key: "P",
    at: -1,
    label: "P",
    option: (v) => v,
    cell: (v) => v,
    start: "",
  };
  return [...SPACE_FIELDS[space], p];
}

/** A field of a problem id; P is its last segment. */
function valueOf(id: string, f: FieldSpec): string {
  const parts = id.split("/");
  return f.key === "P" ? parts[parts.length - 1] : (parts[f.at] ?? "");
}

/** The fields of a problem id, keyed as the picker keys them. */
export function fieldsOfId(space: SpaceName, id: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of pickSpecs(space)) out[f.key] = valueOf(id, f);
  return out;
}

/**
 * The picker for a wish: each field offers the values that occur among the problems matching the
 * fields before it, and takes the wished value when it is offered; otherwise the field's starting
 * value, and for P the offered value nearest the wished one. The last field then fixes one
 * problem: its id, or null when the space has no problems.
 */
export function pickProblem(
  space: SpaceName,
  problems: readonly { id: string }[],
  wish: Record<string, string>,
): { fields: PickField[]; id: string | null } {
  const fields: PickField[] = [];
  let left = problems.slice();
  for (const f of pickSpecs(space)) {
    const values =
      f.key === "P"
        ? [...new Set(left.map((p) => valueOf(p.id, f)))].sort((a, b) => Number(a) - Number(b))
        : fieldValues(left, f);
    if (!values.length) return { fields, id: null };
    let value = wish[f.key];
    if (value === undefined || !values.includes(value)) {
      if (f.key === "P" && value !== undefined && Number.isFinite(Number(value))) {
        const want = Number(value);
        value = values.reduce((a, b) => (Math.abs(Number(b) - want) < Math.abs(Number(a) - want) ? b : a));
      } else value = values.includes(f.start) ? f.start : values[0];
    }
    fields.push({
      key: f.key,
      label: PICK_LABELS[f.key] ?? f.label,
      options: values.map((v) => ({ value: v, text: f.key === "P" ? v : f.option(v) })),
      value,
    });
    left = left.filter((p) => valueOf(p.id, f) === value);
  }
  return { fields, id: left[0]?.id ?? null };
}

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
  }
}

/** The rows of the panel's values, in the spaces page's words. `why` is a closed problem's reason. */
export function problemFacts(p: LoadedSpaceProblem): { label: string; value: string; note?: string }[] {
  const entries = entriesText(p);
  return [
    { label: "Certified value", value: p.certified ? p.certified.display : "—" },
    { label: "Status", value: statusLabel(problemStatus({ ...p, status: p.status ?? undefined })) },
    {
      label: "Lower bound",
      value: p.bound ? round6(p.bound.value).replace(/^-/, "−") : "—",
      ...(p.bound?.label ? { note: plainBoundLabel(p.bound.label) } : {}),
    },
    {
      label: "Site best",
      value: p.site_best ? round6(p.site_best.score) : "—",
      ...(p.site_best ? { note: `${p.site_best.name}, ${day(p.site_best.created_at)}` } : {}),
    },
    { label: "Entries", value: entries.text, ...(entries.why ? { note: entries.why } : {}) },
  ];
}

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
};

/** What an evaluation counts in each search, for the budget's note. */
export const EVAL_UNIT: Record<SearchKind, string> = {
  surface: "one compression (a start or a hop)",
  nofold: "one evaluation of the polygon solver",
  curved: "one start or one hop",
  sphere: "one objective and gradient evaluation",
  torus: "one objective and gradient evaluation",
};

/**
 * Evaluations per round. A run is a sequence of rounds, each a job of the space's search that
 * starts from the best so far with its own seed; the page sees the best after every round, and
 * pause and stop end the worker at once. [CALC] On an Apple Silicon laptop a round took 0.1 to 2 s
 * (sphere and torus, 12 to 49 pieces), 1 to 1.7 s (curved, one start and 8 hops) and 1 to 8 s
 * (surface fold, 4 compressions, 12 to 14 pieces; 141 s at 80 pieces, so large solids get 2).
 */
export const ROUND_EVALS: Record<SearchKind, number> = {
  surface: 4,
  nofold: 5000,
  curved: 9,
  sphere: 2000,
  torus: 2000,
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
  }[kind as Exclude<SearchKind, "surface">];
}

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
 * `freshTries` counts the rounds without a start that found nothing: each doubles the next one.
 */
export function roundJob(
  p: SearchProblem,
  rule: SpaceRule,
  run: RunSettings,
  k: number,
  used: { evals: number; seconds: number },
  start: SpaceConfig | null,
  freshTries = 0,
): { job: SpaceJob; evals: number } | null {
  const kind = searchKind(p);
  const fold = kind === "surface";
  const least = fold && !start ? 2 : 1;
  const left = run.budget.evals - used.evals;
  if (left < least) return null;
  const size = start ? roundSize(p) : FRESH_EVALS[kind] * 2 ** Math.min(freshTries, 8);
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
