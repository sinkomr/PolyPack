import { afterEach, describe, expect, it, vi } from "vitest";
import { eventKeys } from "@polypack/geometry";
import { FOLLOW_GAP_MS, LiveFeed } from "../src/api";
import { addToQueue, followed, leave, newGame, newProblem } from "../src/tighter/game";

/** Enough of an EventSource for LiveFeed: its address, its state, its listeners. */
class FakeSource {
  readyState = 0;
  closed = false;
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) {}
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
}

afterEach(() => vi.useRealTimers());

function feed(poll: (() => void) | null = null) {
  vi.useFakeTimers();
  const sources: FakeSource[] = [];
  const events: unknown[] = [];
  const f = new LiveFeed(
    (e) => events.push(e),
    poll,
    (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s as unknown as EventSource;
    },
    () => Date.now(),
  );
  return { f, sources, events };
}

describe("LiveFeed", () => {
  it("opens one stream for the keys it follows, and none again for the same keys", () => {
    const { f, sources } = feed();
    expect(sources).toHaveLength(0);
    f.follow(["4/4/2", "0/0/*"]);
    expect(sources.map((s) => s.url)).toEqual(["/api/events?keys=4/4/2,0/0/*"]);
    f.follow(["4/4/2", "0/0/*"]);
    vi.advanceTimersByTime(10 * FOLLOW_GAP_MS);
    expect(sources).toHaveLength(1);
    expect(f.isLive()).toBe(false);
    sources[0].readyState = 1;
    expect(f.isLive()).toBe(true);
  });

  it("follows new keys with a new stream, at most one every FOLLOW_GAP_MS, the latest wish winning", () => {
    const { f, sources } = feed();
    f.follow(["4/4/2"]);
    vi.advanceTimersByTime(FOLLOW_GAP_MS);
    f.follow(["4/4/3"]);
    // a change right after: it waits for the gap, and only the last of quick changes is opened
    f.follow(["4/4/4"]);
    f.follow(["4/4/5"]);
    expect(sources.map((s) => s.url)).toEqual(["/api/events?keys=4/4/2", "/api/events?keys=4/4/3"]);
    vi.advanceTimersByTime(FOLLOW_GAP_MS - 1);
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sources.map((s) => s.url).at(-1)).toBe("/api/events?keys=4/4/5");
    // each new stream replaces the one before
    expect(sources.map((s) => s.closed)).toEqual([true, true, false]);
    // back to what is open already: nothing to do
    f.follow(["4/4/5"]);
    vi.advanceTimersByTime(10 * FOLLOW_GAP_MS);
    expect(sources).toHaveLength(3);
  });

  it("follows every problem with null, and nothing with no keys", () => {
    const { f, sources } = feed();
    f.follow(null);
    expect(sources[0].url).toBe("/api/events");
    vi.advanceTimersByTime(FOLLOW_GAP_MS);
    f.follow([]);
    expect(sources).toHaveLength(1);
    expect(sources[0].closed).toBe(true);
    expect(f.isLive()).toBe(false);
  });

  it("passes the stream's leader changes on, and ignores a malformed one", () => {
    const { f, sources, events } = feed();
    f.follow(["4/4/2"]);
    sources[0].emit("leaderboard", '{"N":4,"M":4,"P":2,"id":1,"score":2,"rank":1,"name":"a"}');
    sources[0].emit("leaderboard", "{nope");
    expect(events).toEqual([{ N: 4, M: 4, P: 2, id: 1, score: 2, rank: 1, name: "a" }]);
  });

  it("polls every 10 s while no stream is open, and stops for good when closed", () => {
    const poll = vi.fn();
    const { f, sources } = feed(poll);
    f.follow(["4/4/2"]);
    vi.advanceTimersByTime(10_000);
    expect(poll).toHaveBeenCalledTimes(1);
    sources[0].readyState = 1;
    vi.advanceTimersByTime(30_000);
    expect(poll).toHaveBeenCalledTimes(1);
    // the stream drops; an EventSource reconnects to the same address by itself
    sources[0].readyState = 0;
    vi.advanceTimersByTime(10_000);
    expect(poll).toHaveBeenCalledTimes(2);
    f.close();
    expect(sources[0].closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(poll).toHaveBeenCalledTimes(2);
  });
});

describe("Tighter follows", () => {
  it("its queue, the focused problem first, then the records it holds, the latest first", () => {
    const s = newGame(0, 1);
    for (const [N, M, P] of [
      [24, 30, 40],
      [21, 21, 100],
      [33, 36, 300],
    ])
      addToQueue(s, newProblem({ family: "polygon", N, M, P }, "open", 0));
    // the first two leave: one held, one not; then an older held record
    s.queue[0].ourId = 7;
    leave(s, "24/30/40", 10);
    leave(s, "21/21/100", 20);
    s.past.unshift({ ...s.past[0], family: "polygon", N: 4, M: 4, P: 9, key: "4/4/9", ourId: 3, leftAt: 5 });
    addToQueue(s, newProblem({ family: "polygon", N: 60, M: 66, P: 200 }, "open", 30));
    s.focus = "60/66/200";
    expect(eventKeys(followed(s))).toEqual(["60/66/200", "33/36/300", "24/30/40", "4/4/9"]);
  });
});
