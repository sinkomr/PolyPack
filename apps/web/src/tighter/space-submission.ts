import type { SpaceConfig } from "@polypack/spaces";
import { configUrl } from "../spaces-model";
import type { SpaceFamily } from "./frontier";
import type { Leader } from "./game";
import { CLIENT_TAG, RunRecord, SubmitOutcome } from "./submission";

/**
 * What Tighter reads of a space problem and sends for it (POST /api/spaces/submit), and how it
 * reads the answers. As for polygons, the server's check is the only judge: a board is sent only
 * when it beats the leader read just before, and points are paid only for an answer that makes it
 * the leader.
 */

/** The largest configuration kept or sent, in characters of JSON: far above a 100-piece packing. */
export const MAX_CONFIG_CHARS = 400_000;

/** A configuration from the server or a save, or null when it is not a plain object of bounded size. */
export function plainConfig(v: unknown): SpaceConfig | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  try {
    const text = JSON.stringify(v);
    if (text.length > MAX_CONFIG_CHARS) return null;
    return JSON.parse(text) as SpaceConfig;
  } catch {
    return null;
  }
}

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number, fallback: string) =>
  typeof v === "string" && v.trim() ? v.slice(0, max) : fallback;

/** The name a research record goes by as a leader. */
export const RESEARCH_RECORD = "the research record";

/** A space problem as the game needs it, from GET /api/spaces/<space>/problems/<id>. */
export interface SpaceRead {
  id: string;
  /** The problem takes entries (not proven, closed or infeasible). */
  accepts: boolean;
  /** The server's lower bound, null when it has none. */
  bound: number | null;
  /** The best value: the research record or the leading site entry, whichever is smaller; null when there is neither. */
  leader: Leader | null;
  /** The leader's configuration (null when the server sent none). */
  config: SpaceConfig | null;
}

/**
 * The problem's answer read defensively. The leader is the smaller of the research record and
 * the site's best entry, since an entry must beat both to be kept; a research record has no entry
 * id. Null for an answer that is not this problem's.
 */
export function readSpaceBody(id: string, body: unknown): SpaceRead | null {
  if (!isObj(body) || body.id !== id || typeof body.accepts_submissions !== "boolean") return null;
  const status = body.status;
  const certified = isObj(body.certified) && pos(body.certified.score) ? body.certified.score : null;
  const site = isObj(body.site_best) && pos(body.site_best.score) ? body.site_best : null;
  const siteScore = site ? (site.score as number) : null;
  const research = certified !== null && (siteScore === null || certified <= siteScore);
  let leader: Leader | null = null;
  if (research) leader = { score: certified, name: RESEARCH_RECORD, id: null };
  else if (site)
    leader = {
      score: siteScore!,
      name: str(site.name, 40, "another name"),
      id: Number.isSafeInteger(site.id) && (site.id as number) >= 1 ? (site.id as number) : null,
    };
  return {
    id,
    accepts: body.accepts_submissions && status !== "proven" && status !== "infeasible",
    bound: isObj(body.bound) && pos(body.bound.value) ? body.bound.value : null,
    leader,
    config: leader ? plainConfig(research ? body.certified_config : body.site_config) : null,
  };
}

/** GET /api/spaces/<space>/problems/<id>: the answer's status (null: not reached) and the problem when it could be read. */
export async function fetchSpaceProblem(
  family: SpaceFamily,
  id: string,
): Promise<{ status: number | null; read: SpaceRead | null }> {
  let r: Response;
  try {
    r = await fetch(configUrl(family, id));
  } catch {
    return { status: null, read: null };
  }
  if (!r.ok) return { status: r.status, read: null };
  try {
    return { status: r.status, read: readSpaceBody(id, await r.json()) };
  } catch {
    return { status: r.status, read: null };
  }
}

/** Whether a read problem can be dealt: it takes entries and has the bound the points need. */
export const spaceDealable = (r: SpaceRead | null): r is SpaceRead => !!r && r.accepts && r.bound !== null;

/** The tier a read problem is dealt as: open without a leader, else a site record (batch). */
export const spaceTier = (r: SpaceRead): "open" | "batch" => (r.leader ? "batch" : "open");

/**
 * Whether a candidate is still as it was found: dealable, and with the same leader (none, for an open
 * one; a leader is the same while its score is).
 */
export function spaceStands(r: SpaceRead | null, c: { tier: string; leader: { score: number } | null }): boolean {
  if (!spaceDealable(r)) return false;
  if (!c.leader) return r.leader === null;
  return r.leader !== null && r.leader.score === c.leader.score;
}

// ---------- sending ----------

/** The POST /api/spaces/submit body: the board, the name, and how it was found. */
export function spaceSubmissionBody(
  p: { family: SpaceFamily; id: string },
  config: SpaceConfig,
  name: string,
  run: RunRecord,
): Record<string, unknown> {
  return {
    space: p.family,
    id: p.id,
    config,
    name,
    software: CLIENT_TAG,
    method: `${p.family} ${run.method}`,
    seed: run.seed,
  };
}

/** POST /api/spaces/submit, answered with its HTTP status (null: the server could not be reached) and JSON body (null: none). */
export async function postSpaceSubmission(
  body: Record<string, unknown>,
): Promise<{ status: number | null; body: unknown }> {
  let r: Response;
  try {
    r = await fetch("/api/spaces/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { status: null, body: null };
  }
  try {
    return { status: r.status, body: await r.json() };
  } catch {
    return { status: r.status, body: null };
  }
}

/**
 * One answer of POST /api/spaces/submit, read by its status. An entry the server kept and made leader
 * is the leader; one that is valid but not kept, or that the server did not check because it could
 * not be kept (polyhedra and torus: `checked: false`), is behind; 409 is closed; 400 and 422 refused; 429 and
 * 503 rate-limited; no answer or another failure is offline.
 */
export function classifySpaceAnswer(status: number | null, body: unknown): SubmitOutcome {
  if (status === null) return { kind: "offline" };
  const b = isObj(body) ? body : {};
  const reasons = Array.isArray(b.reasons) ? b.reasons.map(String) : typeof b.error === "string" ? [b.error] : [];
  if (status === 409) return { kind: "closed", reasons };
  if (status === 429 || status === 503) return { kind: "rate-limited", reasons };
  if (status === 200) {
    const score = pos(b.score) ? b.score : null;
    if (b.valid === true && score !== null && b.leader === true && Number.isSafeInteger(b.id))
      return { kind: "leader", score, id: b.id as number, pending: false };
    // valid but not kept, or not checked since it could not be kept
    if ((b.valid === true || b.checked === false) && score !== null)
      return { kind: "behind", score, leaderScore: pos(b.best_score) ? b.best_score : null };
    return { kind: "refused", status, reasons: reasons.length ? reasons : ["the server did not accept the board"] };
  }
  if (status === 400 || status === 422)
    return { kind: "refused", status, reasons: reasons.length ? reasons : [`the server answered ${status}`] };
  if (status >= 500) return { kind: "offline" };
  return { kind: "refused", status, reasons: reasons.length ? reasons : [`the server answered ${status}`] };
}
