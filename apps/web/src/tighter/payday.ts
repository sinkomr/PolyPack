import type { LeaderValue, LeadersAnswer } from "../api";
import { archiveOf } from "./archive";
import { RENT_BATCH, heldRecords, settleRent, tidyRent } from "./economy";
import type { GameState, Leader, PastProblem, ProblemState } from "./game";
import type { Owned } from "./upgrades";

type Held = ProblemState | PastProblem;

/** What a payday did, for the notice. */
export interface PaydayResult {
  /** Rent paid, in RP. */
  paid: number;
  /** Records that paid. */
  paying: number;
  /** Records the server said somebody else leads. */
  lost: number;
  /** Of `lost`, the archived records: the caller tells the player of them in one line. */
  archivedLost: number;
  /** Records in requests that failed or were not asked: when not 0, nothing was paid and the payday is tried again soon. */
  unanswered: number;
}

export interface PaydayDeps {
  state: GameState;
  owned: Owned;
  now: () => number;
  /** GET /api/leaders for these keys; null when the request failed. */
  getLeaders: (keys: string[]) => Promise<LeadersAnswer | null>;
  /** Feeds a leader into the game's usual handling (held, lost, Retake, a send whose answer was lost). */
  noteLeader: (p: Held, leader: Leader | null, quiet?: boolean) => void;
  /** The record has a send under way, so its state is not settled: it is not looked up, and counts as held if it still is. */
  busy: (p: Held) => boolean;
  /** This tab still runs the game. */
  active: () => boolean;
  /** After each batch: the caller saves and redraws. */
  batchDone?: () => void;
}

/** Every record held that a payday asks about: the queue's, the past's and the archive's. */
export function paydayDue(s: GameState): Held[] {
  const due: Held[] = heldRecords(s);
  const a = archiveOf(s);
  if (a) for (const r of a.values()) if (r.ourId !== null) due.push(r);
  return due;
}

const asLeader = (v: LeaderValue | null): Leader | null => (v ? { score: v.score, name: v.name, id: v.id } : null);

/**
 * The payday, every day at noon. Every record held is looked up in batches of at most RENT_BATCH
 * keys, one request after another. A record found lost goes the usual way (noteLeader) as its answer
 * comes. The payment is all or nothing: only when every batch has answered, every record still held
 * pays its window (settleRent: since the last payday or since it was won, at most a week) and
 * paidUntil moves to now. A failed request stops the payday with nothing paid, to be tried again
 * soon (the result's `unanswered` is not 0). A record that is busy, or that the server left unknown,
 * was not found lost: it counts as held.
 */
export async function runPayday(d: PaydayDeps): Promise<PaydayResult> {
  const { state: s, owned: o } = d;
  const result: PaydayResult = { paid: 0, paying: 0, lost: 0, archivedLost: 0, unanswered: 0 };
  tidyRent(s, o, d.now());
  const due = paydayDue(s);
  const keys = [...new Set(due.map((p) => p.key))];
  const byKey = new Map<string, Held[]>();
  for (const p of due) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p]);
  for (let i = 0; i < keys.length; i += RENT_BATCH) {
    const batch = keys.slice(i, i + RENT_BATCH);
    const answer = d.active() ? await d.getLeaders(batch) : null;
    if (!answer || !d.active()) {
      for (const k of keys.slice(i)) result.unanswered += byKey.get(k)!.length;
      break;
    }
    const unknown = new Set(answer.unknown);
    for (const k of batch) {
      for (const p of byKey.get(k)!) {
        // a record unanswered or busy since the request left was not found lost: it counts as held
        if (unknown.has(k) || !(k in answer.leaders) || d.busy(p)) continue;
        // an archived record found lost is told in one line for all of them, not one each
        const archived = archiveOf(s)?.get(k) === p;
        d.noteLeader(p, asLeader(answer.leaders[k]), archived);
        if (p.ourId === null) {
          result.lost++;
          if (archived) {
            result.archivedLost++;
            archiveOf(s)!.remove(k);
          }
        }
      }
    }
    d.batchDone?.();
  }
  if (result.unanswered > 0) return result;
  // every batch answered: the records still held are paid for their window, and the next window starts
  const at = d.now();
  for (const p of paydayDue(s)) {
    const rp = settleRent(s, o, p, at);
    if (rp > 0) {
      result.paid += rp;
      result.paying++;
    }
  }
  if (o.has("rent")) s.economy.paidUntil = at;
  d.batchDone?.();
  return result;
}
