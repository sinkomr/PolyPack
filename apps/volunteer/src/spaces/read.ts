/**
 * Checks on what the server says about the new spaces (packages/spaces/src/types.ts). As in
 * ../validate.ts, answers are untrusted input: each reader returns a clean copy, or null when the
 * answer cannot be used. A malformed configuration only drops that configuration.
 */
import { type SpaceConfig, type SpaceTarget, isSpaceName } from "@polypack/spaces";
import { cleanText } from "../validate";
import { type SpaceProblem, parseSpaceId, readSpaceConfig } from "./model";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const idOrNull = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : null);

/**
 * One entry of GET /api/spaces/targets, or null (also when its id is not one this client searches). A problem
 * without a research record or a site entry yet comes with best_score null and leader "none".
 */
export function readSpaceTarget(v: unknown): SpaceTarget | null {
  if (!isObject(v) || !isSpaceName(v.space) || typeof v.priority !== "number" || !Number.isFinite(v.priority))
    return null;
  const p = parseSpaceId(v.id);
  const none = v.best_score === null && v.leader === "none";
  if (!p || p.space !== v.space || v.P !== p.P || !(positive(v.best_score) || none)) return null;
  const leaderId = none ? null : idOrNull(v.leader_id);
  return {
    space: p.space,
    id: p.id,
    P: p.P,
    priority: v.priority,
    best_score: none ? null : (v.best_score as number),
    bound: positive(v.bound) ? v.bound : null,
    leader: none ? "none" : leaderId === null ? "certified" : "site",
    leader_id: leaderId,
  };
}

/** What the client uses of GET /api/spaces/:space/problems/<id>. */
export interface SpaceProblemInfo {
  accepts_submissions: boolean;
  /** Why a closed problem takes no submissions, as the server says it (optional in the contract). */
  closed_reason: string | null;
  best_score: number | null;
  bound: number | null;
  certified: { score: number; status: string } | null;
  /** True when the problem has no research record yet (its entries must pass the strict check). */
  no_record: boolean;
  site_best: { id: number; score: number; name: string } | null;
  certified_config: SpaceConfig | null;
  site_config: SpaceConfig | null;
}

/**
 * The problem, cleaned. Null when it is not this problem, or when what the decisions rest on
 * (whether it is open, its best score, the site's leader) is malformed.
 */
export function readSpaceProblem(v: unknown, p: SpaceProblem): SpaceProblemInfo | null {
  if (!isObject(v) || v.space !== p.space || v.id !== p.id || typeof v.accepts_submissions !== "boolean") return null;
  if (v.best_score !== null && !positive(v.best_score)) return null;
  let site: SpaceProblemInfo["site_best"] = null;
  if (v.site_best !== null && v.site_best !== undefined) {
    const b = v.site_best;
    if (!isObject(b) || !Number.isSafeInteger(b.id) || !positive(b.score)) return null;
    // the name is kept as sent, to recognise our own entries; it is cleaned where it is printed
    site = { id: b.id as number, score: b.score, name: typeof b.name === "string" ? b.name : "" };
  }
  let certified: SpaceProblemInfo["certified"] = null;
  if (isObject(v.certified) && positive(v.certified.score))
    certified = { score: v.certified.score, status: cleanText(v.certified.status, 20) };
  const bound = isObject(v.bound) && positive(v.bound.value) ? v.bound.value : null;
  return {
    accepts_submissions: v.accepts_submissions,
    closed_reason:
      typeof v.closed_reason === "string" && v.closed_reason.trim() ? cleanText(v.closed_reason, 160) : null,
    best_score: v.best_score as number | null,
    bound,
    certified,
    no_record: v.status === "no_record",
    site_best: site,
    certified_config: v.certified_config == null ? null : readSpaceConfig(p, v.certified_config),
    site_config: v.site_config == null ? null : readSpaceConfig(p, v.site_config),
  };
}

/** The fields of a POST /api/spaces/submit answer that the client records, or null. */
export function readSpaceSubmitResponse(v: unknown): {
  valid: boolean;
  leader: boolean;
  score: number | null;
  best_score: number | null;
  id: number | null;
  beats_certified: boolean;
  reasons: string[];
} | null {
  if (!isObject(v) || typeof v.valid !== "boolean") return null;
  return {
    valid: v.valid,
    leader: v.leader === true,
    score: positive(v.score) ? v.score : null,
    best_score: positive(v.best_score) ? v.best_score : null,
    id: idOrNull(v.id),
    beats_certified: v.beats_certified === true,
    reasons: Array.isArray(v.reasons) ? v.reasons.slice(0, 5).map((r) => cleanText(r)) : [],
  };
}
