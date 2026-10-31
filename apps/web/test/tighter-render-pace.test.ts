import { describe, expect, it } from "vitest";
import { RENDER_GAP_MS, renderPace } from "../src/tighter/render-pace";

/** A pace on a fake clock, with timers and frames run by hand. */
function setup() {
  let t = 1000;
  const timers: { at: number; cb: () => void }[] = [];
  const frames: (() => void)[] = [];
  let renders = 0;
  const pace = renderPace({
    now: () => t,
    frame: (cb) => frames.push(cb),
    later: (cb, ms) => timers.push({ at: t + ms, cb }),
    render: () => renders++,
  });
  /** Moves the clock, runs due timers, then the pending frames. */
  const advance = (ms: number) => {
    t += ms;
    const due = timers.filter((x) => x.at <= t);
    for (const x of due) timers.splice(timers.indexOf(x), 1);
    due.forEach((x) => x.cb());
    frames.splice(0).forEach((cb) => cb());
  };
  return { pace, advance, renders: () => renders, pending: () => timers.length + frames.length };
}

describe("Tighter render pace", () => {
  it("renders on the next frame when nothing rendered lately", () => {
    const s = setup();
    s.pace.request();
    expect(s.renders()).toBe(0);
    s.advance(16);
    expect(s.renders()).toBe(1);
  });

  it("renders at most once per gap however often it is asked", () => {
    const s = setup();
    for (let ms = 0; ms < 1000; ms += 16) {
      s.pace.request();
      s.advance(16);
    }
    const total = s.renders();
    expect(total).toBeLessThanOrEqual(Math.ceil(1000 / RENDER_GAP_MS) + 1);
    expect(total).toBeGreaterThanOrEqual(5);
  });

  it("shows a request made just after a render within the gap, not never", () => {
    const s = setup();
    s.pace.request();
    s.advance(16);
    expect(s.renders()).toBe(1);
    s.pace.request();
    s.advance(50);
    expect(s.renders()).toBe(1);
    s.advance(RENDER_GAP_MS);
    expect(s.renders()).toBe(2);
  });

  it("counts a direct render as the last one, so a scheduled one waits", () => {
    const s = setup();
    s.pace.rendered();
    s.pace.request();
    s.advance(16);
    expect(s.renders()).toBe(0);
    s.advance(RENDER_GAP_MS);
    expect(s.renders()).toBe(1);
  });

  it("keeps one request waiting however many come", () => {
    const s = setup();
    s.pace.request();
    s.pace.request();
    s.pace.request();
    s.advance(16);
    expect(s.renders()).toBe(1);
  });

  it("drops a request on cancel", () => {
    const s = setup();
    s.pace.request();
    s.pace.cancel();
    s.advance(16);
    expect(s.renders()).toBe(0);
    s.pace.request();
    s.advance(16);
    expect(s.renders()).toBe(1);
  });
});
