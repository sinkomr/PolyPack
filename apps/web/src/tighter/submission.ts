import { MAX_METHOD_PARAMS_BYTES, improvesOn, utf8Length } from "@polypack/geometry";
import type { PackingConfig, RunBudget, SubmitResponse } from "@polypack/geometry";
import { OFFLINE_BACKOFF_MS, RATE_LIMITED_BACKOFF_MS } from "./pacer";

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

/**
 * What went wrong with sending, for the notice line under the board. Points waiting for the
 * server's answer are not shown (with one POST per problem a minute, most points wait for one):
 * only trouble is, with what the game does next.
 */
export type Trouble =
  /** No answer at all (the network, or the server down), to the leader's GET or to the POST. */
  | { kind: "unreachable" }
  /** No answer within the game's wait for one. */
  | { kind: "timeout"; waitedMs: number }
  /** The server failed (5xx). */
  | { kind: "error"; status: number }
  /** 429: too many submissions from this address. */
  | { kind: "rate-limited" }
  /** The server refused the board (400, 413, 422); `takenBack` is the points it had paid, as shown. */
  | { kind: "refused"; title: string; reasons: string[]; takenBack: string | null }
  /** A send whose answer never came could not be checked, since the server cannot be reached. */
  | { kind: "lost"; title: string };

/** A wait as the notices say it: "30 seconds", "a minute". */
const span = (ms: number) => (ms === 60_000 ? "a minute" : `${Math.round(ms / 1000)} seconds`);

/** The notice of a trouble: what happened, then what the game does next, in plain sentences. */
export function troubleText(t: Trouble): string {
  const again = (ms: number) => ` Sending will try again in ${span(ms)}.`;
  switch (t.kind) {
    case "unreachable":
      return "The server cannot be reached." + again(OFFLINE_BACKOFF_MS);
    case "timeout":
      return `The server did not answer within ${span(t.waitedMs)}.` + again(OFFLINE_BACKOFF_MS);
    case "error":
      return `The server answered with an error (${t.status}).` + again(OFFLINE_BACKOFF_MS);
    case "rate-limited":
      return "The server says too many submissions came from your address." + again(RATE_LIMITED_BACKOFF_MS);
    case "refused": {
      // the server may list up to 20 overlaps: the first two say enough
      const more = t.reasons.length - 2;
      const why = t.reasons.slice(0, 2).join(", ") + (more > 0 ? ` and ${more} more` : "");
      return (
        `The server refused your board on ${t.title} (${why}).` +
        (t.takenBack ? ` The ${t.takenBack} RP it paid were taken back.` : "") +
        " Your next better board will be sent as usual."
      );
    }
    case "lost":
      return (
        `The server never answered your board on ${t.title}, and it cannot be reached to check whether the board arrived.` +
        ` The game checks again in ${span(OFFLINE_BACKOFF_MS)}.`
      );
  }
}

/**
 * The trouble of a POST's answer, if any: no answer (or none in time), a 5xx, a 429, or a refusal.
 * `takenBack` is the points the refusal took back, as the notice shows them (null: none).
 */
export function answerTrouble(
  outcome: SubmitOutcome,
  status: number | null,
  timedOutAfter: number | null,
  title: string,
  takenBack: string | null,
): Trouble | null {
  switch (outcome.kind) {
    case "offline":
      if (timedOutAfter !== null) return { kind: "timeout", waitedMs: timedOutAfter };
      return status === null ? { kind: "unreachable" } : { kind: "error", status };
    case "rate-limited":
      return { kind: "rate-limited" };
    case "refused":
      return { kind: "refused", title, reasons: outcome.reasons, takenBack };
    default:
      return null;
  }
}
