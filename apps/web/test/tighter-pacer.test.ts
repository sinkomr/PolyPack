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
import { DEAL_CLICKS, canDeal, dealEvals, evalsToNextDeal, newDealer, refill, takeToken } from "../src/tighter/dealer";

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
  it("deals one problem per slot per 300 clicks' worth of evaluations, at most one per slot waiting", () => {
    expect(DEAL_CLICKS).toBe(300);
    expect(dealEvals(1)).toBe(300);
    // more evaluations a click: still 300 clicks
    expect(dealEvals(4)).toBe(1200);
    expect(dealEvals(0)).toBe(300);
    const d = newDealer(7);
    expect(canDeal(d, 1, 0, 1)).toBe(true);
    takeToken(d);
    expect(evalsToNextDeal(d, 1, 150, 1)).toBe(150);
    expect(canDeal(d, 1, 299, 1)).toBe(false);
    expect(canDeal(d, 1, 300, 1)).toBe(true);
    d.tokens = 0;
    expect(evalsToNextDeal(d, 1, 300, 4)).toBe(1200);
    // a long session fills the bucket to the number of slots, no further
    refill(d, 3, 100_000, 1);
    expect(d.tokens).toBe(3);
    takeToken(d);
    takeToken(d);
    takeToken(d);
    expect(canDeal(d, 3, 100_000, 1)).toBe(false);
    // three slots earn three times as fast
    expect(evalsToNextDeal(d, 3, 100_000, 1)).toBe(100);
    expect(d.dealt).toBe(4);
    // evaluations are counted once: an older count changes nothing
    refill(d, 3, 50_000, 1);
    expect(d.evalsAt).toBe(100_000);
    expect(d.tokens).toBe(0);
  });

  it("deals on credit when the queue is empty, and the next evaluations repay the debt", () => {
    const d = newDealer(7);
    takeToken(d);
    takeToken(d);
    expect(d.tokens).toBe(-1);
    expect(canDeal(d, 1, 300, 1)).toBe(false);
    expect(evalsToNextDeal(d, 1, 300, 1)).toBe(300);
    expect(canDeal(d, 1, 600, 1)).toBe(true);
  });

  it("counts the evaluations left exactly, whatever the rounding in the bucket", () => {
    const d = newDealer(7);
    takeToken(d);
    expect(evalsToNextDeal(d, 1, 100, 1)).toBe(200);
    const e = newDealer(7);
    refill(e, 3, 0, 1);
    takeToken(e);
    expect(evalsToNextDeal(e, 3, 70, 1)).toBe(30);
  });
});
