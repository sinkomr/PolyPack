/**
 * What to start from, whether to submit, and what to send. Pure functions of what the server said
 * and what the search found.
 */
import {
  MAX_METHOD_PARAMS_BYTES,
  type PackingConfig,
  type Pose,
  type ProblemInfo,
  improvesOn,
  utf8Length,
} from "@polypack/geometry";
import type { Candidate, SearchInput } from "./types";

/** The leader's stored packing, from GET /api/submissions/{id}. */
export interface StoredEntry {
  score: number;
  pieces: Pose[];
  container_phi: number | null;
}

const poses = (pieces: readonly Pose[]): Pose[] => pieces.map(({ x, y, theta }) => ({ x, y, theta }));

/**
 * The packing the engine starts from: the leader's, or the published one when it is better or
 * when the leader's coordinates are not at hand (no leader, or its entry could not be read).
 * Undefined when neither has coordinates.
 */
export function buildKnown(info: ProblemInfo, leader: StoredEntry | null): SearchInput["known"] {
  const shape = { N: info.N, M: info.M, P: info.P };
  const lit = info.literature;
  const published = lit?.pieces && lit.pieces.length === info.P ? lit : null;
  const site = leader && leader.pieces.length === info.P ? leader : null;
  if (site && (!published || site.score <= published.value)) {
    const config: PackingConfig = { ...shape, pieces: poses(site.pieces), container_phi: site.container_phi ?? 0 };
    return { config, score: site.score, source: "site" };
  }
  if (published) {
    const config: PackingConfig = {
      ...shape,
      pieces: poses(published.pieces!),
      container_phi: published.container_phi ?? 0,
    };
    return { config, score: published.value, source: "literature" };
  }
  return undefined;
}

/** The better of two strict candidates (the first on a tie). */
export function better(a: Candidate | null, b: Candidate | null): Candidate | null {
  if (!a || !a.strict) return b && b.strict ? b : null;
  if (!b || !b.strict) return a;
  return b.score < a.score ? b : a;
}

export interface Decision {
  submit: boolean;
  reason: string;
}

/**
 * Submit only a strict packing, to an open problem, that improves on the leader by more than the
 * server's tie tolerance (an equal entry never replaces an earlier one). `leader` must be read
 * just before. In a dry run the same rule says what would have been sent.
 */
export function decideSubmission(a: {
  best: Candidate | null;
  open: boolean;
  leader: number | null;
  dryRun: boolean;
}): Decision {
  if (!a.best) return { submit: false, reason: "no strict packing" };
  if (!a.best.strict) return { submit: false, reason: "the best packing is not strict" };
  if (!a.open) return { submit: false, reason: "the problem is closed" };
  if (a.leader !== null && !improvesOn(a.best.score, a.leader))
    return { submit: false, reason: "not better than the leader" };
  if (a.dryRun) return { submit: false, reason: "dry run: would submit" };
  return { submit: true, reason: a.leader === null ? "the problem has no leader" : "better than the leader" };
}

/**
 * The body of POST /api/submit: the packing, the name, how it was found (found_with "optimizer",
 * the method, its resolved parameters when they fit the server's limit, the seed and the budget of
 * the job that produced it), the note when there is one, and `software` unless it is null.
 */
export function submissionBody(
  c: Candidate,
  o: { name: string; note: string; software: string | null },
): Record<string, unknown> {
  const { N, M, P, pieces, container_phi } = c.config;
  const params =
    c.params && typeof c.params === "object" && !Array.isArray(c.params) && fitsParams(c.params) ? c.params : undefined;
  const { time_s, evals } = c.job.budget;
  return {
    N,
    M,
    P,
    pieces: poses(pieces),
    container_phi,
    name: o.name,
    ...(o.note ? { agent_note: o.note } : {}),
    found_with: "optimizer",
    method: c.job.method,
    ...(params ? { method_params: params } : {}),
    ...(Number.isSafeInteger(c.job.seed) && c.job.seed >= 0 ? { seed: c.job.seed } : {}),
    budget: { time_s, ...(evals !== undefined ? { evals } : {}) },
    ...(o.software !== null ? { software: o.software } : {}),
  };
}

function fitsParams(params: Record<string, unknown>): boolean {
  try {
    return utf8Length(JSON.stringify(params)) <= MAX_METHOD_PARAMS_BYTES;
  } catch {
    return false; // not serialisable (a cycle, a BigInt)
  }
}

/** The refusal of servers that accept `software` only with found_with "external". */
export const SOFTWARE_REFUSAL = 'software needs found_with "external"';

export function isSoftwareRefusal(status: number, body: unknown): boolean {
  const reasons = (body as { reasons?: unknown } | null)?.reasons;
  return status === 400 && Array.isArray(reasons) && reasons.includes(SOFTWARE_REFUSAL);
}
