import { MAX_METHOD_PARAMS_BYTES, improvesOn, utf8Length } from "@polypack/geometry";
import type { PackingConfig, RunBudget, SubmitResponse } from "@polypack/geometry";

/**
 * What Tighter sends and how it reads the answers. The server's exact check of each new record is
 * the only judge: a board is sent only when it beats the leader fetched just before by more than
 * the tie tolerance (`improvesOn`, the server's own rule), and points are paid only for an answer
 * that makes it the leader.
 */

/** Names this client in every entry. */
export const CLIENT_TAG = "tighter/0.1";

/** The optimizer run that produced a board, recorded with the entry. */
export interface RunRecord {
  method: string;
  /** The method's resolved parameters. */
  params: Record<string, unknown>;
  seed: number;
  budget: RunBudget;
}

/**
 * Should the board of score `best` be sent, given the leader fetched just before (null: no leader)?
 * Only strict improvements by the server's rule.
 */
export function shouldSubmit(best: number, leaderScore: number | null): boolean {
  if (!(best > 0) || !Number.isFinite(best)) return false;
  return leaderScore === null || improvesOn(best, leaderScore);
}

/**
 * The POST /api/submit body. Provenance: found_with "optimizer" with the run's method, resolved
 * parameters, seed and evaluations-only budget.
 *
 * The client is named in `agent_note`, not in `software`: the server accepts `software` only with
 * found_with "external" (packages/geometry/src/provenance.ts) and refuses it beside an optimizer
 * run, and this task makes no server changes. See the report's list of wanted server changes.
 */
export function submissionBody(board: PackingConfig, name: string, run: RunRecord): Record<string, unknown> {
  const params = utf8Length(JSON.stringify(run.params)) <= MAX_METHOD_PARAMS_BYTES ? run.params : undefined;
  return {
    N: board.N,
    M: board.M,
    P: board.P,
    pieces: board.pieces.map((p) => ({ x: p.x, y: p.y, theta: p.theta })),
    container_phi: board.container_phi,
    name,
    agent_note: CLIENT_TAG,
    found_with: "optimizer",
    method: run.method,
    ...(params ? { method_params: params } : {}),
    seed: run.seed,
    budget: { ...run.budget },
  };
}

/** One answer of POST /api/submit, read by its status. */
export type SubmitOutcome =
  /** Valid, and the entry now leads the problem. `id` is null when the server did not keep it. */
  | { kind: "leader"; score: number; id: number | null; pending: boolean }
  /** Valid but not the leader (another entry got there first): no points, and nothing was kept. */
  | { kind: "behind"; score: number; leaderScore: number | null }
  /** 409: the problem is closed (its optimum is proven). */
  | { kind: "closed"; reasons: string[] }
  /** 429: too many submissions from this address. */
  | { kind: "rate-limited"; reasons: string[] }
  /** 400, 413, 422 and anything else: the server refused this body; sending it again will not help. */
  | { kind: "refused"; status: number; reasons: string[] }
  /** No answer at all. */
  | { kind: "offline" };

export function classifyAnswer(status: number | null, body: unknown): SubmitOutcome {
  if (status === null) return { kind: "offline" };
  const b = (typeof body === "object" && body !== null ? body : {}) as Partial<SubmitResponse> & { error?: string };
  const reasons = Array.isArray(b.reasons) ? b.reasons.map(String) : b.error ? [String(b.error)] : [];
  if (status === 409) return { kind: "closed", reasons };
  if (status === 429) return { kind: "rate-limited", reasons };
  if (status === 200 && b.valid === true && typeof b.score === "number") {
    if (b.leader === true)
      return {
        kind: "leader",
        score: b.score,
        id: typeof b.id === "number" ? b.id : null,
        pending: !!b.pending_verification,
      };
    return { kind: "behind", score: b.score, leaderScore: typeof b.leader_score === "number" ? b.leader_score : null };
  }
  if (status >= 500) return { kind: "offline" };
  return { kind: "refused", status, reasons: reasons.length ? reasons : [`the server answered ${status}`] };
}
