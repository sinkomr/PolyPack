import type { LeaderValue, LeadersAnswer } from "../api";
import { RENT_BATCH, RENT_PAYDAY_MS, heldRecords, settleRent, tidyRent } from "./economy";
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
  /** Records the batch could not answer, or that were busy: they stay unsettled for a retry. */
  unanswered: number;
}

export interface PaydayDeps {
  state: GameState;
  owned: Owned;
  now: () => number;
  /** GET /api/leaders for these keys; null when the request failed. */
  getLeaders: (keys: string[]) => Promise<LeadersAnswer | null>;
  /** Feeds a leader into the game's usual handling (held, lost, Retake, a send whose answer was lost). */
  noteLeader: (p: Held, leader: Leader | null) => void;
  /** The record has a send under way, so its state is not settled: it waits for the next payday. */
  busy: (p: Held) => boolean;
  /** This tab still runs the game. */
  active: () => boolean;
  /** After each batch: the caller saves and redraws. */
  batchDone?: () => void;
}

/** Records held whose rent was last settled a day or more ago. */
export function paydayDue(s: GameState, now: number): Held[] {
  return heldRecords(s).filter((p) => {
    const at = s.economy.checks[p.key];
    return at !== undefined && now - at >= RENT_PAYDAY_MS;
  });
}

const asLeader = (v: LeaderValue | null): Leader | null => (v ? { score: v.score, name: v.name, id: v.id } : null);

/**
 * The daily payday: every held record whose rent was last settled a day or more ago is looked up in
 * batches of at most RENT_BATCH keys, one request after another. A record still ours pays its rent
 * (at most a week, settleRent); one found lost pays nothing and goes the usual way (noteLeader). A
 * record the server did not answer stays as it was, to be tried at the next payday. A failed request
 * leaves the rest of the batches unasked.
 */
export async function runPayday(d: PaydayDeps): Promise<PaydayResult> {
  const { state: s, owned: o } = d;
  const result: PaydayResult = { paid: 0, paying: 0, lost: 0, unanswered: 0 };
  tidyRent(s, o, d.now());
  const due = paydayDue(s, d.now());
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
        // a record unanswered or busy since the request left is left as it was
        if (unknown.has(k) || !(k in answer.leaders) || d.busy(p)) {
          result.unanswered++;
          continue;
        }
        d.noteLeader(p, asLeader(answer.leaders[k]));
        if (p.ourId === null) {
          result.lost++;
          continue;
        }
        const rp = settleRent(s, o, p, d.now());
        if (rp > 0) {
          result.paid += rp;
          result.paying++;
        }
      }
    }
    d.batchDone?.();
  }
  return result;
}
