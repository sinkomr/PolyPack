import { describe, expect, it } from "vitest";
import { ActiveClock } from "../src/clock";

describe("active clock", () => {
  it("counts from zero and leaves paused intervals out", () => {
    let t = 1000;
    const clock = new ActiveClock(() => t);
    expect(clock.now()).toBe(0);
    t += 5;
    expect(clock.now()).toBe(5);
    clock.pause();
    t += 100;
    expect(clock.now()).toBe(5); // frozen while paused
    expect(clock.paused).toBe(true);
    clock.resume();
    t += 2;
    expect(clock.now()).toBe(7);
    clock.pause();
    t += 50;
    clock.resume();
    t += 1;
    expect(clock.now()).toBe(8);
  });

  it("ignores a second pause or resume", () => {
    let t = 0;
    const clock = new ActiveClock(() => t);
    clock.resume();
    t = 3;
    clock.pause();
    t = 10;
    clock.pause(); // must not move the start of the pause
    t = 20;
    clock.resume();
    clock.resume();
    t = 21;
    expect(clock.now()).toBe(4);
  });

  it("never goes backwards on the real clock", () => {
    const clock = new ActiveClock();
    let last = clock.now();
    for (let i = 0; i < 1000; i++) {
      if (i % 100 === 0) clock.pause();
      if (i % 100 === 50) clock.resume();
      const now = clock.now();
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
  });
});
