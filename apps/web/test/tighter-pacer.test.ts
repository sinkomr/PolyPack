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
import {
  AUTO_CLICK_EVALS,
  DEAL_CLICKS,
  canDeal,
  clicksToNextDeal,
  creditOf,
  earn,
  newDealer,
  refill,
  takeToken,
} from "../src/tighter/dealer";
import { countEvaluations, newGame } from "../src/tighter/game";

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
  it("deals one problem per slot per 300 clicks, at most one per slot waiting", () => {
    expect(DEAL_CLICKS).toBe(300);
    const d = newDealer(7);
    expect(canDeal(d, 1)).toBe(true);
    takeToken(d);
    earn(d, 150);
    expect(clicksToNextDeal(d, 1)).toBe(150);
    earn(d, 149);
    expect(canDeal(d, 1)).toBe(false);
    earn(d, 1);
    expect(canDeal(d, 1)).toBe(true);
    // a long session fills the bucket to the number of slots, no further
    earn(d, 100_000);
    refill(d, 3);
    expect(d.tokens).toBe(3);
    takeToken(d);
    takeToken(d);
    takeToken(d);
    expect(canDeal(d, 3)).toBe(false);
    // three slots earn three times as fast
    expect(clicksToNextDeal(d, 3)).toBe(100);
    expect(d.dealt).toBe(4);
    // work is counted once: a refill spends the credit
    expect(d.credit).toBe(0);
    refill(d, 3);
    expect(d.tokens).toBe(0);
    // nothing earns but work
    earn(d, -5);
    earn(d, 0);
    expect(d.credit).toBe(0);
  });

  it("counts a click of the player's as one click, whatever its size, and auto-eval's evaluations 10 to the click", () => {
    expect(AUTO_CLICK_EVALS).toBe(10);
    // a click of k evaluations is one click; Compact's 100 at k = 4 are 25
    expect(creditOf(4, 4)).toBe(1);
    expect(creditOf(40, 40)).toBe(1);
    expect(creditOf(100, 4)).toBe(25);
    expect(creditOf(3, 0)).toBe(3);
    // auto-eval's at a fixed size, whatever the player's click size
    expect(creditOf(10, null)).toBe(1);
    expect(creditOf(100, null)).toBe(10);
    // in the game: the player's evaluations at the player's click size, auto-eval's at 10 to the click
    const s = newGame(T0, 7);
    s.owned = ["trace", "click2", "click3", "click4"];
    countEvaluations(s, 4, true);
    countEvaluations(s, 30, false);
    expect(s.stats.evaluations).toBe(34);
    expect(s.dealer.credit).toBeCloseTo(1 + 3, 12);
    // 10 evaluations a click: auto-eval earns deals just as fast as at 4
    s.owned.push("click5", "click6", "click7", "click8", "click9", "click10");
    countEvaluations(s, 10, true);
    countEvaluations(s, 30, false);
    expect(s.dealer.credit).toBeCloseTo(4 + 1 + 3, 12);
    s.dealer.tokens = 0;
    // 300 clicks of one slot's deal less the 8 done: 292 clicks, or 2,920 evaluations of auto-eval
    expect(clicksToNextDeal(s.dealer, 1)).toBe(292);
    countEvaluations(s, 2920, false);
    expect(canDeal(s.dealer, 1)).toBe(true);
  });

  it("deals on credit when the queue is empty, and the next work repays the debt", () => {
    const d = newDealer(7);
    takeToken(d);
    takeToken(d);
    expect(d.tokens).toBe(-1);
    earn(d, 300);
    expect(canDeal(d, 1)).toBe(false);
    expect(clicksToNextDeal(d, 1)).toBe(300);
    earn(d, 300);
    expect(canDeal(d, 1)).toBe(true);
  });

  it("counts the clicks left exactly, whatever the rounding in the bucket", () => {
    const d = newDealer(7);
    takeToken(d);
    earn(d, 100);
    expect(clicksToNextDeal(d, 1)).toBe(200);
    const e = newDealer(7);
    refill(e, 3);
    takeToken(e);
    earn(e, 70);
    expect(clicksToNextDeal(e, 3)).toBe(30);
    // tenths of a click from auto-eval add up without showing a click too many
    const f = newDealer(7);
    takeToken(f);
    for (let i = 0; i < 1000; i++) earn(f, creditOf(1, null));
    expect(clicksToNextDeal(f, 1)).toBe(200);
  });
});
