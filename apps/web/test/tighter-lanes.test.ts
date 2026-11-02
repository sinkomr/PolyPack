import { describe, expect, it } from "vitest";
import { newGame } from "../src/tighter/game";
import { fromJson, normalize, toJson } from "../src/tighter/save";
import { AUTO_METER_NOTE, AutoMeter, laneSplit, meterShare } from "../src/tighter/scheduler";

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const near = (a: number[], b: number[]) => {
  expect(a).toHaveLength(b.length);
  a.forEach((x, i) => expect(Math.abs(x - b[i]) / b[i], `${x} vs ${b[i]}`).toBeLessThan(0.03));
};

describe("laneSplit (auto-eval's rate over the lanes with work)", () => {
  // the targets of lane-split/sim2.py floored_time, ms of one evaluation per lane
  it("matches the simulated targets for two lanes of very different size", () => {
    near(laneSplit([0.31, 52.3], 200), [180.88, 19.12]);
    near(laneSplit([0.31, 52.3], 1000), [980.88, 19.12]);
  });

  it("matches the targets for six lanes, and keeps the floor", () => {
    const ms = [0.31, 0.87, 1.77, 7.35, 22.8, 52.3];
    near(laneSplit(ms, 200), [114.27, 40.72, 20.01, 8.33, 8.33, 8.33]);
    const e = laneSplit(ms, 1000);
    near(e, [586.07, 208.83, 102.65, 41.67, 41.67, 19.12]);
    // never under a quarter of an equal share (or its core's limit), never over its core
    e.forEach((x, i) => {
      expect(x).toBeGreaterThanOrEqual(Math.min(1000 / 6 / 4, 1000 / ms[i]) - 1e-6);
      expect(x).toBeLessThanOrEqual(1000 / ms[i] + 1e-6);
    });
    expect(sum(e)).toBeCloseTo(1000, 3);
  });

  it("gives equal solving time when no lane is near a limit, and all of the rate", () => {
    const e = laneSplit([2, 4], 150);
    expect(e[0] * 2).toBeCloseTo(e[1] * 4, 3);
    expect(sum(e)).toBeCloseTo(150, 3);
  });

  it("is the whole rate for one lane, nothing for none, and short only where every core is full", () => {
    expect(laneSplit([5], 30)).toEqual([30]);
    expect(laneSplit([], 30)).toEqual([]);
    expect(laneSplit([5, 5], 0)).toEqual([0, 0]);
    expect(sum(laneSplit([10, 10], 1000))).toBeCloseTo(200, 3);
  });
});

describe("AutoMeter (what auto-eval really ran, over 30 s)", () => {
  it("compares evaluations run with those due, over the window only", () => {
    const m = new AutoMeter();
    for (let t = 0; t < 40; t++) {
      m.addDue(t * 1000, 100, 1);
      m.addRan(t * 1000 + 500, 80);
    }
    const s = m.summary(39_900);
    expect(s.seconds).toBeCloseTo(30, 5);
    expect(s.ran / s.due).toBeCloseTo(0.8, 5);
    expect(meterShare(s)).toBeCloseTo(0.8, 5);
    expect(meterShare(s)!).toBeLessThan(AUTO_METER_NOTE);
  });

  it("says nothing until it has 10 s of work, and nothing for idle time", () => {
    const m = new AutoMeter();
    for (let t = 0; t < 5; t++) m.addDue(t * 1000, 100, 1);
    expect(meterShare(m.summary(5000))).toBeNull();
    // 60 s with no work counted (idle lanes, held, off) leaves nothing to compare
    expect(meterShare(m.summary(65_000))).toBeNull();
    for (let t = 65; t < 80; t++) {
      m.addDue(t * 1000, 100, 1);
      m.addRan(t * 1000, 100);
    }
    expect(meterShare(m.summary(80_000))).toBeCloseTo(1, 5);
  });
});

describe("Lanes in use (a setting)", () => {
  it("defaults to all lanes and survives a save", () => {
    const g = newGame(1000, 1);
    expect(g.settings.lanesInUse).toBeNull();
    g.settings.lanesInUse = 2;
    const back = fromJson(toJson(g), 1000);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.state.settings.lanesInUse).toBe(2);
  });

  it("is all lanes in a save without it, or with a value that is not a whole number from 1", () => {
    for (const v of [undefined, 0, -1, 1.5, "2", null]) {
      const s = normalize({ version: 10, settings: { lanesInUse: v } }, 1000);
      expect(s.settings.lanesInUse, String(v)).toBeNull();
    }
    expect(normalize({ version: 10, settings: { lanesInUse: 3 } }, 1000).settings.lanesInUse).toBe(3);
  });
});
