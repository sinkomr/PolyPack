import { describe, expect, it } from "vitest";
import {
  PLAYER_PER_MINUTE,
  PROBLEM_INTERVAL_MS,
  canSend,
  compact,
  newPacer,
  nextAllowedAt,
  pause,
  recordSend,
  sentLastMinute,
} from "../src/tighter/pacer";
import { DEAL_INTERVAL_MS, canDeal, newDealer, nextDealAt, refill, takeToken } from "../src/tighter/dealer";

const T0 = 1_000_000;

describe("Tighter submission pacing", () => {
  it("sends a problem's best at most once a minute", () => {
    let s = recordSend(newPacer(), "24/30/60", T0);
    expect(canSend(s, "24/30/60", T0 + 1)).toBe(false);
    expect(canSend(s, "24/30/60", T0 + PROBLEM_INTERVAL_MS - 1)).toBe(false);
    expect(nextAllowedAt(s, "24/30/60", T0 + 5000)).toBe(T0 + PROBLEM_INTERVAL_MS);
    expect(canSend(s, "24/30/60", T0 + PROBLEM_INTERVAL_MS)).toBe(true);
    // another problem is not held back by this one's minute
    expect(canSend(s, "21/21/40", T0 + 1)).toBe(true);
    s = recordSend(s, "24/30/60", T0 + PROBLEM_INTERVAL_MS);
    expect(canSend(s, "24/30/60", T0 + PROBLEM_INTERVAL_MS + 1)).toBe(false);
  });

  it("lets only a problem never sent go at once: leaving or refused, the minute holds", () => {
    expect(canSend(newPacer(), "24/30/60", T0, { first: true })).toBe(true);
    const s = recordSend(newPacer(), "24/30/60", T0);
    // after any POST (a refused first record included), and when the problem leaves the queue
    expect(canSend(s, "24/30/60", T0 + 1, { first: true })).toBe(false);
    expect(canSend(s, "24/30/60", T0 + 1, { leaving: true })).toBe(false);
    expect(canSend(s, "24/30/60", T0 + PROBLEM_INTERVAL_MS, { leaving: true })).toBe(true);
  });

  it("sends at most 6 a minute per player, whatever the problems", () => {
    let s = newPacer();
    for (let i = 0; i < PLAYER_PER_MINUTE; i++) {
      expect(canSend(s, `21/21/${40 + i}`, T0 + i * 1000)).toBe(true);
      s = recordSend(s, `21/21/${40 + i}`, T0 + i * 1000);
    }
    expect(sentLastMinute(s, T0 + 6000)).toBe(6);
    // the 7th waits for the oldest of the six to be a minute old, first record or not
    expect(canSend(s, "21/21/100", T0 + 6000)).toBe(false);
    expect(canSend(s, "21/21/100", T0 + 6000, { first: true })).toBe(false);
    expect(nextAllowedAt(s, "21/21/100", T0 + 6000)).toBe(T0 + 60_000);
    expect(canSend(s, "21/21/100", T0 + 60_000)).toBe(true);
    s = recordSend(s, "21/21/100", T0 + 60_000);
    expect(canSend(s, "21/21/120", T0 + 60_001)).toBe(false);
    expect(nextAllowedAt(s, "21/21/120", T0 + 60_001)).toBe(T0 + 61_000);
  });

  it("pauses all sending after a 429 or an unreachable server", () => {
    const s = pause(newPacer(), T0, 60_000);
    expect(canSend(s, "24/30/60", T0 + 59_999, { first: true })).toBe(false);
    expect(canSend(s, "24/30/60", T0 + 60_000)).toBe(true);
    // a shorter pause never shortens a longer one
    expect(pause(s, T0, 1000).pausedUntil).toBe(T0 + 60_000);
  });

  it("forgets what no longer matters", () => {
    let s = recordSend(newPacer(), "24/30/60", T0);
    s = recordSend(s, "21/21/40", T0 + 30_000);
    const c = compact(s, T0 + 70_000);
    expect(Object.keys(c.lastByProblem)).toEqual(["21/21/40"]);
    expect(c.sent).toEqual([T0 + 30_000]);
  });
});

describe("Tighter deal rate", () => {
  it("deals one problem per slot every 5 minutes, at most one per slot waiting", () => {
    const d = newDealer(7, T0);
    expect(canDeal(d, 1, T0)).toBe(true);
    takeToken(d);
    expect(nextDealAt(d, 1, T0 + 60_000)).toBeCloseTo(T0 + DEAL_INTERVAL_MS, 6);
    expect(canDeal(d, 1, T0 + DEAL_INTERVAL_MS - 1)).toBe(false);
    expect(canDeal(d, 1, T0 + DEAL_INTERVAL_MS)).toBe(true);
    // a long absence fills the bucket to the number of slots, no further
    refill(d, 3, T0 + 10 * DEAL_INTERVAL_MS);
    expect(d.tokens).toBe(3);
    takeToken(d);
    takeToken(d);
    takeToken(d);
    expect(canDeal(d, 3, T0 + 10 * DEAL_INTERVAL_MS)).toBe(false);
    // three slots refill three times as fast
    expect(nextDealAt(d, 3, T0 + 10 * DEAL_INTERVAL_MS)).toBeCloseTo(
      T0 + 10 * DEAL_INTERVAL_MS + DEAL_INTERVAL_MS / 3,
      6,
    );
    expect(d.dealt).toBe(4);
  });
});
