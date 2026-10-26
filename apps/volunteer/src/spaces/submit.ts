/**
 * What to start from, whether to submit and what to send, for a problem of the new spaces. Pure
 * functions of what the server said and what the search found, like ../submit.ts.
 */
import { SCORE_TIE, improvesOn } from "@polypack/geometry";
import { type SpaceName, type SpaceSubmission, improvesSpaceBest } from "@polypack/spaces";
import type { Decision, SubmitCheck } from "../submit";
import { storedName } from "../submit";
import type { SpaceLeaderRef } from "../state";
import type { SpaceCandidate } from "./engine";
import { type SpaceCheck, type SpaceProblem, spaceMethodNote } from "./model";
import type { SpaceProblemInfo } from "./read";

/** The problem's best as the history records it: the site's leader when it leads, else the research record. */
export function bestRef(info: SpaceProblemInfo): SpaceLeaderRef | null {
  const site = info.site_best;
  const cert = info.certified;
  if (site && (!cert || site.score <= cert.score))
    return { id: site.id, score: site.score, source: "site", name: site.name };
  return cert ? { id: null, score: cert.score, source: "certified" } : null;
}

/**
 * The configuration to start from: the better of the research record's and the site leader's
 * (the record on a tie), when there is one. Shared with the board (packages/spaces/src/search/model.ts).
 */
export { buildSpaceKnown } from "@polypack/spaces/search";

/** The better of two candidates (the first on a tie). */
export function betterSpace(a: SpaceCandidate | null, b: SpaceCandidate | null): SpaceCandidate | null {
  if (!a) return b;
  if (!b) return a;
  return b.score < a.score ? b : a;
}

/**
 * Submit only a configuration that the space's own validator accepts at its stated size, to an
 * open problem, at or above the problem's lower bound, that improves on the problem's best (the
 * research record or the site's leader, whichever is smaller) by more than the tie tolerance.
 * Given `record` (the space, the research record's certified size and the site leader's score),
 * the rule is the server's keep rule instead: the leader by the tie tolerance and the research
 * record by the space's record margin (1e-6 relative for polyhedra; SPACE_RECORD_MARGIN).
 * `bestScore` must be read just before. In a dry run the same rule says what would have been sent.
 */
export function decideSpaceSubmission(a: {
  best: SpaceCandidate | null;
  check: SpaceCheck | null;
  open: boolean;
  bestScore: number | null;
  bound: number | null;
  dryRun: boolean;
  record?: { space: SpaceName; certified: number | null; leader: number | null };
}): Decision {
  if (!a.best) return { submit: false, reason: "no valid configuration" };
  if (!a.check?.valid || a.check.score === null)
    return { submit: false, reason: `not valid by the space's validator (${a.check?.reasons[0] ?? "unchecked"})` };
  if (!a.open) return { submit: false, reason: "the problem is closed" };
  // the score the check computed from the configuration, not the one a saved file states
  const score = a.check.score;
  if (a.bound !== null && score < a.bound) return { submit: false, reason: "below the problem's lower bound" };
  if (a.bestScore !== null && !improvesOn(score, a.bestScore))
    return { submit: false, reason: "not better than the problem's best" };
  if (a.record && !improvesSpaceBest(a.record.space, score, a.record.certified, a.record.leader))
    return { submit: false, reason: "not below the research record by the space's margin" };
  if (a.dryRun) return { submit: false, reason: "dry run: would submit" };
  return { submit: true, reason: "better than the problem's best" };
}

/** The longest `method` text of a space submission (apps/server SPACE_METHOD_LENGTH). */
export const SPACE_METHOD_LENGTH = 80;

/** The body of POST /api/spaces/submit. */
export function spaceSubmissionBody(
  p: SpaceProblem,
  c: SpaceCandidate,
  o: { name: string; note: string; software: string },
): SpaceSubmission {
  return {
    space: p.space,
    id: p.id,
    config: c.config,
    name: o.name,
    ...(o.note ? { agent_note: o.note } : {}),
    software: o.software,
    // "sphere basin hopping" for each kind's own search, "sphere basin_hopping" for a generic method,
    // with its --space-params when they fit (the server takes 80 characters)
    method: spaceMethodNote(p.space, c.job.method, c.job.params, SPACE_METHOD_LENGTH),
    ...(Number.isSafeInteger(c.job.seed) && c.job.seed >= 0 ? { seed: c.job.seed } : {}),
  };
}

/** What a re-read says after a POST without a clear answer (see ../submit.ts, checkStored). */
export function checkSpaceStored(info: SpaceProblemInfo, name: string, score: number): SubmitCheck {
  if (!info.accepts_submissions) return { state: "closed" };
  const b = info.site_best;
  if (b && Math.abs(b.score - score) <= SCORE_TIE * Math.max(b.score, score) && storedName(b.name) === storedName(name))
    return { state: "ours", id: b.id, score: b.score };
  if (info.best_score !== null && !improvesOn(score, info.best_score))
    return { state: "beaten", leader: info.best_score };
  return { state: "absent" };
}
