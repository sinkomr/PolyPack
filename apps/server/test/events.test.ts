import { LeaderboardEvent, MAX_EVENT_KEYS, eventKeys } from "@polypack/geometry";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, parseEventKeys } from "../src/app";
import { LoadStats } from "../src/load";
import { SqliteStore } from "../src/sqlite-store";

let lines: string[] = [];
let stats = new LoadStats((line) => lines.push(line));
const make = () =>
  createApp({ store: new SqliteStore(":memory:"), records: [], log: () => {}, limits: { perIp: 1e9 }, stats });
let app = make();
const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
  lines = [];
  stats = new LoadStats((line) => lines.push(line));
  app = make();
});

/** A live-update stream of the current app: its hello, and the leaderboard events received so far. */
async function listen(query = "") {
  const res = await app.request(`/api/events${query}`);
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const s = { hello: null as unknown, events: [] as LeaderboardEvent[] };
  let text = "";
  let ready!: () => void;
  const helloSeen = new Promise<void>((resolve) => (ready = resolve));
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      text += decoder.decode(value);
      let end: number;
      while ((end = text.indexOf("\n\n")) >= 0) {
        const block = text.slice(0, end);
        text = text.slice(end + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null");
        if (event === "hello") {
          s.hello = data;
          ready();
        } else if (event === "leaderboard") s.events.push(data);
      }
    }
  })();
  await helloSeen;
  const close = () => reader.cancel();
  open.push(close);
  return { hello: s.hello, events: s.events, close };
}

/** A new leader for N/M/P: P circles in a row, `gap` apart; each call with a smaller gap leads. */
let gap = 4;
async function lead(N: number, M: number, P: number) {
  gap -= 0.01;
  const pieces = Array.from({ length: P }, (_, i) => ({ x: i * (N === 0 ? gap : gap * 20), y: 0, theta: 0 }));
  const r = await app.request("/api/submit", {
    method: "POST",
    body: JSON.stringify({ N, M, P, pieces, container_phi: 0, name: "ann", units: "diameter" }),
  });
  expect(((await r.json()) as { leader: boolean }).leader).toBe(true);
}

/** Lets the streams write what they were given. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const keysOf = (events: LeaderboardEvent[]) => events.map((e) => `${e.N}/${e.M}/${e.P}`);

describe("the keys a live-update stream follows", () => {
  it("are N/M/P or N/M/*, written back in one form, at most MAX_EVENT_KEYS", () => {
    expect(parseEventKeys("4/4/11,0/0/*,4/4/11,04/4/011")).toEqual(["4/4/11", "0/0/*"]);
    expect(parseEventKeys("")).toEqual([]);
    for (const bad of ["4/4", "4/4/0", "4/4/501", "1/4/2", "4/101/2", "4/4/2,", "*/4/2", "4/4/2;4/4/3", "a/b/c"])
      expect(parseEventKeys(bad)).toMatch(/^keys must be N\/M\/P or N\/M\/\*/);
    const many = Array.from({ length: MAX_EVENT_KEYS + 1 }, (_, i) => `4/4/${i + 1}`);
    expect(parseEventKeys(many.slice(0, -1).join(","))).toHaveLength(MAX_EVENT_KEYS);
    expect(parseEventKeys(many.join(","))).toBe(`at most ${MAX_EVENT_KEYS} keys`);
  });

  it("are refused with 400 when they are not such a list", async () => {
    for (const query of ["?keys=4/4", `?keys=${Array.from({ length: 101 }, (_, i) => `4/4/${i + 1}`).join(",")}`]) {
      const r = await app.request(`/api/events${query}`);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toMatch(/keys/);
    }
  });

  it("are what a client asks for: the most important problems, then pairs followed whole", () => {
    const p = (N: number, M: number, P: number) => ({ N, M, P });
    expect(eventKeys([p(4, 4, 2), p(0, 0, 7), p(4, 4, 2)])).toEqual(["4/4/2", "0/0/7"]);
    // over the limit: the pair with the most problems is followed whole, in the place of its first
    const list = [p(3, 3, 9), p(4, 4, 1), p(4, 4, 2), p(4, 4, 3), p(5, 5, 1), p(5, 5, 2)];
    expect(eventKeys(list, 4)).toEqual(["3/3/9", "4/4/*", "5/5/1", "5/5/2"]);
    expect(eventKeys(list, 3)).toEqual(["3/3/9", "4/4/*", "5/5/*"]);
    // pairs alone still too many: the least important are left out
    expect(eventKeys([p(3, 3, 1), p(4, 4, 1), p(5, 5, 1), p(6, 6, 1)], 2)).toEqual(["3/3/1", "4/4/1"]);
    const every = Array.from({ length: 500 }, (_, i) => p(4, 4, i + 1));
    expect(eventKeys(every)).toEqual(["4/4/*"]);
  });
});

describe("live updates", () => {
  it("reach only the streams that follow the problem, once each", async () => {
    const one = await listen("?keys=4/4/2");
    const pair = await listen("?keys=4/4/*");
    const other = await listen("?keys=4/5/2");
    const both = await listen("?keys=4/4/2,4/4/*");
    const all = await listen();
    const none = await listen("?keys=");
    expect([one.hello, all.hello, none.hello]).toEqual([{ keys: ["4/4/2"] }, { all: true }, { keys: [] }]);
    await lead(4, 4, 2);
    await lead(4, 4, 3);
    await lead(4, 5, 2);
    await lead(0, 0, 2);
    await settle();
    expect(keysOf(one.events)).toEqual(["4/4/2"]);
    expect(keysOf(pair.events)).toEqual(["4/4/2", "4/4/3"]);
    expect(keysOf(other.events)).toEqual(["4/5/2"]);
    expect(keysOf(both.events)).toEqual(["4/4/2", "4/4/3"]);
    expect(keysOf(all.events)).toEqual(["4/4/2", "4/4/3", "4/5/2", "0/0/2"]);
    expect(none.events).toEqual([]);
    expect(one.events[0]).toMatchObject({ N: 4, M: 4, P: 2, rank: 1, name: "ann" });
  });

  it("follow a client that changes what it follows, and leave nothing behind when it goes", async () => {
    const first = await listen("?keys=4/4/2");
    await lead(4, 4, 2);
    await settle();
    expect(keysOf(first.events)).toEqual(["4/4/2"]);
    // the client follows 4/4/3 instead: a new stream, and the old one closes
    const second = await listen("?keys=4/4/3");
    await first.close();
    await settle();
    await lead(4, 4, 2);
    await lead(4, 4, 3);
    await settle();
    expect(keysOf(first.events)).toEqual(["4/4/2"]);
    expect(keysOf(second.events)).toEqual(["4/4/3"]);
    stats.flush(0);
    expect(lines.at(-1)).toContain("; 1 live stream (0 following every problem, the others 1 keys);");
    await second.close();
    await settle();
    stats.flush(0);
    lines.length = 0;
    // with nothing open and nothing sent, the minute has no line
    stats.flush(0);
    expect(lines).toEqual([]);
  });

  it("resume with the same keys when a stream reconnects", async () => {
    const before = await listen("?keys=4/4/2,0/0/*");
    await before.close();
    await lead(4, 4, 2);
    // an EventSource asks for the same address again
    const after = await listen("?keys=4/4/2,0/0/*");
    expect(after.hello).toEqual(before.hello);
    await lead(4, 4, 2);
    await lead(0, 0, 5);
    await lead(4, 4, 3);
    await settle();
    // what happened while it was away is not sent again: the client reads it after reconnecting
    expect(keysOf(after.events)).toEqual(["4/4/2", "0/0/5"]);
    expect(before.events).toEqual([]);
    stats.flush(0);
    expect(lines.at(-1)).toContain("; 1 live stream (0 following every problem, the others 2 keys);");
  });

  it("send each of many streams exactly the changes of its own problems", async () => {
    const problems = Array.from({ length: 10 }, (_, i) => ({ N: 0, M: 0, P: i + 2 }));
    let seed = 7;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const streams = [];
    for (let k = 0; k < 60; k++) {
      const keys = problems.filter(() => random() < 0.3).map((p) => `${p.N}/${p.M}/${p.P}`);
      if (k % 15 === 0) keys.push("0/0/*");
      streams.push({ keys, s: await listen(`?keys=${keys.join(",")}`) });
    }
    const sent: string[] = [];
    for (let e = 0; e < 40; e++) {
      const p = problems[Math.floor(random() * problems.length)];
      await lead(p.N, p.M, p.P);
      sent.push(`${p.N}/${p.M}/${p.P}`);
    }
    await settle();
    for (const { keys, s } of streams) {
      const wanted = sent.filter((k) => keys.includes(k) || keys.includes("0/0/*"));
      expect(keysOf(s.events)).toEqual(wanted);
    }
  });
});
