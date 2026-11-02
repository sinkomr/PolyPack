import { describe, expect, it } from "vitest";
import { GROUPS, INCOME_WINDOW_MS, IncomeLog, groupOf } from "../src/tighter/income";
import { TIERS } from "../src/tighter/points";

const MIN = 60_000;

describe("income view", () => {
  it("sums the last hour by group and source", () => {
    const log = new IncomeLog();
    const t0 = 10 * INCOME_WINDOW_MS;
    log.add(t0, 100, "record", "open");
    log.add(t0 + MIN, 50, "record", "open");
    log.add(t0 + 2 * MIN, 30, "rent", "published");
    log.add(t0 + 3 * MIN, 7, "record", "batch");
    const s = log.sums(t0 + 10 * MIN);
    expect(s.cells["open/record"]).toBe(150);
    expect(s.cells["published/rent"]).toBe(30);
    expect(s.cells["site/record"]).toBe(7);
    expect(s.byGroup.open).toBe(150);
    expect(s.bySource).toEqual({ record: 157, rent: 30 });
    expect(s.total).toBe(187);
  });

  it("drops what is an hour old or older, event by event", () => {
    const log = new IncomeLog();
    const t0 = 5 * INCOME_WINDOW_MS;
    log.add(t0, 10, "record", "open");
    log.add(t0 + 20 * MIN, 20, "record", "open");
    log.add(t0 + 40 * MIN, 40, "rent", "loose");
    expect(log.sums(t0 + 59 * MIN).total).toBe(70);
    expect(log.sums(t0 + 60 * MIN).total).toBe(60);
    expect(log.sums(t0 + 81 * MIN).total).toBe(40);
    expect(log.sums(t0 + 101 * MIN).total).toBe(0);
  });

  it("forgets old events when new ones come, and ignores points that are not above zero", () => {
    const log = new IncomeLog();
    log.add(0, 5, "record", "open");
    log.add(1, 0, "record", "open");
    log.add(2, -3, "rent", "open");
    log.add(3, Number.NaN, "rent", "open");
    expect(log.sums(3).total).toBe(5);
    log.add(2 * INCOME_WINDOW_MS, 9, "record", "open");
    expect(log.sums(2 * INCOME_WINDOW_MS).total).toBe(9);
    log.clear();
    expect(log.sums(2 * INCOME_WINDOW_MS).total).toBe(0);
  });

  it("puts every tier in some group", () => {
    for (const t of TIERS) expect(GROUPS.some((g) => g.id === groupOf(t))).toBe(true);
    expect(groupOf("batch")).toBe("site");
  });
});
