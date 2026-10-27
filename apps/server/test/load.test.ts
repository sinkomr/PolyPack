import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { PackingConfig, SubmitResponse, boundingRadius, circumradius, evaluate } from "@polypack/geometry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { MAX_REPORTED_OVERLAPS, TimeBudget, addressKey } from "../src/limits";
import { LoadStats, LoopDelay } from "../src/load";
import { SqliteStore } from "../src/sqlite-store";
import { withUnits } from "./units";

/**
 * The server's geometry call before it returned early on invalid boards and scored at the phi sent:
 * the reference for its refusals.
 */
const before = (config: PackingConfig) => evaluate(config, { autoOrient: true, maxOverlaps: MAX_REPORTED_OVERLAPS });

let ip = "1.1.1.1";
let lines: string[] = [];
const make = (extra: Partial<Parameters<typeof createApp>[0]> = {}) =>
  createApp({
    store: new SqliteStore(":memory:"),
    records: [],
    clientIp: () => ip,
    log: () => {},
    limits: { perIp: 1e9, verifyMsPerMinute: 1e9 },
    stats: new LoadStats((line) => lines.push(line)),
    ...extra,
  });
let app = make();

afterEach(() => {
  ip = "1.1.1.1";
  lines = [];
  app = make();
});

async function submit(body: unknown) {
  const r = await app.request("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(withUnits(body)),
  });
  return { status: r.status, headers: r.headers, body: (await r.json()) as SubmitResponse };
}

const refusal = (reasons: string[]): SubmitResponse => ({
  valid: false,
  reasons,
  score: null,
  rank: null,
  leader: false,
  leader_score: null,
  id: null,
  container: null,
  pending_verification: false,
  strict_check: null,
});

function corpus(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? corpus(resolve(dir, e.name)) : e.name.endsWith(".json") ? [resolve(dir, e.name)] : [],
  );
}
const CORPUS = resolve(import.meta.dirname, "../../../data/corpus");

/** 500 100-gons at one point, each turned a little further, so that all 50,000 vertices lie on the hull. */
const stacked = {
  N: 100,
  M: 100,
  P: 500,
  pieces: Array.from({ length: 500 }, (_, i) => ({ x: 0, y: 0, theta: (i * 2 * Math.PI) / 50000 })),
  container_phi: 0,
};

/** A number from `min` to `max` in steps of a millionth of the range, every step equally likely. */
const uniform = (min: number, max: number) =>
  fc.integer({ min: 0, max: 1_000_000 }).map((k) => min + ((max - min) * k) / 1_000_000);

/**
 * Boards of every kind: N and M from circles to 100-gons, up to 30 pieces spread over a square whose
 * side is `spread` times what they would need side by side (so small spreads overlap), sometimes
 * one piece too many or too few, anywhere in the coordinate range. Unbiased: fast-check's bias
 * towards bounds and first choices would stack the pieces and miscount most boards.
 */
const boardArb = fc
  .noBias(
    fc.record({
      N: fc.constantFrom(0, 3, 4, 5, 6, 7, 8, 12, 24, 60, 100),
      M: fc.constantFrom(0, 3, 4, 5, 6, 8, 12, 21),
      spread: fc.oneof(uniform(0.2, 1.5), uniform(10, 30)),
      offset: uniform(-1e5, 1e5),
      extra: fc.constantFrom(0, 0, 0, -1, 1),
      at: fc.array(fc.tuple(uniform(0, 1), uniform(0, 1)), { maxLength: 30 }),
      theta: uniform(0, 7),
    }),
  )
  .map(({ N, M, spread, offset, extra, at, theta }): PackingConfig => {
    const side = spread * 2 * boundingRadius(N) * Math.sqrt(at.length);
    return {
      N,
      M,
      P: Math.max(1, at.length + extra),
      pieces: at.map(([u, v], i) => ({ x: offset + u * side, y: offset + v * side, theta: theta * (i + 1) })),
      container_phi: theta,
    };
  });

describe("refusals of invalid boards", () => {
  // the exact reasons the server gave for these before it returned early on invalid boards
  const golden: Record<string, string[]> = {
    "invalid/empty.json": ["expected exactly 3 pieces, got 0"],
    "invalid/overlap.json": [
      "1 overlapping pair(s); deepest found is pieces 0 and 1, penetration 5.000e-1 (tolerance 1e-9)",
    ],
    "invalid/wrong-count.json": ["expected exactly 3 pieces, got 2"],
    "generated/circle-tolerance-invalid.json": [
      "1 overlapping pair(s); deepest found is pieces 0 and 1, penetration 1.100e-9 (tolerance 1e-9)",
    ],
    "generated/square-tolerance-invalid.json": [
      "1 overlapping pair(s); deepest found is pieces 0 and 1, penetration 1.100e-9 (tolerance 1e-9)",
    ],
  };

  it("are word for word what they were for every invalid board of the corpus", async () => {
    const invalid = corpus(CORPUS).filter((f) => !JSON.parse(readFileSync(f, "utf8")).expected_valid);
    expect(invalid.map((f) => f.split("data/corpus/")[1]).sort()).toEqual(Object.keys(golden).sort());
    for (const file of invalid) {
      const { config } = JSON.parse(readFileSync(file, "utf8"));
      const r = await submit({ ...config, name: "ann" });
      expect(r.status).toBe(422);
      expect(r.body).toEqual(refusal(golden[file.split("data/corpus/")[1]]));
      expect(r.body.reasons).toEqual(before(config).reasons);
    }
  });

  it("are word for word what they were for a board with every piece at one point, and come at once", async () => {
    const body = JSON.stringify({ ...stacked, name: "ann" });
    await submit(body);
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      const r = await submit(body);
      times.push(performance.now() - t);
      expect(r.status).toBe(422);
      expect(r.body).toEqual(
        refusal([
          "at least 20 overlapping pair(s); deepest found is pieces 0 and 6, penetration 3.182e+1 (tolerance 1e-9)",
        ]),
      );
    }
    // well under 1 ms of geometry; the rest is reading 500 pieces of JSON (the fastest of five,
    // since a busy machine slows single runs)
    expect(Math.min(...times)).toBeLessThan(50);
  });

  it("match the reference on fuzzed boards; valid boards are scored at the phi sent, never better than before", async () => {
    let refused = 0;
    let accepted = 0;
    await fc.assert(
      fc.asyncProperty(boardArb, async (config) => {
        const ref = before(config);
        const r = await submit({ ...config, name: "ann" });
        if (!ref.valid) {
          refused++;
          expect(r.status).toBe(422);
          expect(r.body).toEqual(refusal(ref.reasons));
        } else {
          accepted++;
          const sent = evaluate(config);
          expect(r.status).toBe(200);
          expect(r.body.score).toBe(sent.score);
          // as the client receives it: JSON keeps every double, except the sign of a zero
          expect(JSON.stringify(r.body.container)).toBe(JSON.stringify(sent.container));
          // the server no longer turns the container: a score is at most what the search found
          expect(r.body.score!).toBeGreaterThanOrEqual(ref.score!);
        }
      }),
      { numRuns: 400 },
    );
    expect(refused).toBeGreaterThan(100);
    expect(accepted).toBeGreaterThan(50);
  });
});

describe("valid boards", () => {
  it("are verified quickly even with the largest hull a valid board can have", async () => {
    // 500 100-gons on one ring, neighbours a bounding diameter apart and each turned differently,
    // so that many vertices lie on the hull: 0.2 to 0.4 s while the server searched orientations
    // itself, 7 to 14 ms at the phi sent from the hull of all vertices, 1 to 1.5 ms from the
    // candidate pieces (measured 2026-10-21)
    const R = circumradius(100);
    const rho = (500 * 2 * R) / (2 * Math.PI);
    const ring = {
      N: 100,
      M: 100,
      P: 500,
      container_phi: 0,
      pieces: Array.from({ length: 500 }, (_, i) => ({
        x: rho * Math.cos((2 * Math.PI * i) / 500),
        y: rho * Math.sin((2 * Math.PI * i) / 500),
        theta: (i * 0.6180339887) % (2 * Math.PI),
      })),
    };
    const body = JSON.stringify({ ...ring, name: "ann" });
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      const r = await submit(body);
      times.push(performance.now() - t);
      expect(r.status).toBe(200);
      expect(r.body.score).toBe(evaluate(ring).score);
    }
    // the fastest of five, since a busy machine slows single runs
    expect(Math.min(...times)).toBeLessThan(50);
  });
});

describe("addresses", () => {
  it("count IPv6 addresses by their /64 and IPv4 addresses as they are", () => {
    expect(addressKey("203.0.113.7")).toBe("203.0.113.7");
    expect(addressKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(addressKey("[2001:db8:1:2:3::4]")).toBe("2001:db8:1:2::/64");
    expect(addressKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(addressKey("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
    expect(addressKey("::ffff:198.51.100.2")).toBe("198.51.100.2");
    expect(addressKey("2001:db8:1:3::1")).not.toBe(addressKey("2001:db8:1:2::1"));
    // not an address: kept as it is
    for (const text of ["unknown", "1::2::3", "2001:db8:1:2:3:4:5:6:7", "2001:db8:zz::1"])
      expect(addressKey(text)).toBe(text);
  });

  it("are rate limited by their /64", async () => {
    app = make({ limits: { perIp: 2, verifyMsPerMinute: 1e9 } });
    const board = (P: number) => ({ N: 0, M: 0, P, pieces: [{ x: 0, y: 0, theta: 0 }], container_phi: 0, name: "a" });
    ip = "2001:db8:1:2::1";
    expect((await submit(board(1))).status).toBe(200);
    ip = "2001:db8:1:2:ffff::9";
    expect((await submit(board(1))).status).toBe(200);
    expect((await submit(board(1))).status).toBe(429);
    ip = "2001:db8:1:3::1";
    expect((await submit(board(1))).status).toBe(200);
  });
});

describe("the verification budget", () => {
  it("refills continuously and lets a key wait for its balance", () => {
    let t = 0;
    const budget = new TimeBudget(2000, () => t);
    expect(budget.wait("a")).toBe(0);
    budget.charge("a", 1500);
    expect(budget.wait("a")).toBe(0);
    budget.charge("a", 1500);
    // 1000 ms below zero at 2000 ms a minute: 30 s
    expect(budget.wait("a")).toBe(30);
    expect(budget.wait("b")).toBe(0);
    t += 15_000;
    expect(budget.wait("a")).toBe(15);
    t += 15_100;
    expect(budget.wait("a")).toBe(0);
    // never more than a minute's worth saved up
    t += 3_600_000;
    budget.charge("a", 2001);
    expect(budget.wait("a")).toBe(1);
  });

  it("refuses an address that used it up, with Retry-After, and no other address", async () => {
    // a budget so small that one check of any board uses it up
    app = make({ limits: { perIp: 1e9, verifyMsPerMinute: 1e-6 } });
    const board = { N: 4, M: 4, P: 2, pieces: [0, 1].map((x) => ({ x, y: 0, theta: Math.PI / 4 })), container_phi: 0 };
    expect((await submit({ ...board, name: "a" })).status).toBe(200);
    const r = await submit({ ...board, name: "a" });
    expect(r.status).toBe(429);
    expect(r.body).toEqual(
      refusal([expect.stringMatching(/^too much verification work from this address; wait \d+ s$/)]),
    );
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    ip = "2.2.2.2";
    expect((await submit({ ...board, name: "a" })).status).toBe(200);
    // invalid boards are charged too
    ip = "3.3.3.3";
    expect((await submit({ ...board, pieces: [board.pieces[0], board.pieces[0]], name: "a" })).status).toBe(422);
    expect((await submit({ ...board, name: "a" })).status).toBe(429);
  });
});

describe("overload", () => {
  const board = { N: 0, M: 0, P: 1, pieces: [{ x: 0, y: 0, theta: 0 }], container_phi: 0, name: "a" };

  it("refuses submissions with 503 and Retry-After while the event loop lags", async () => {
    let lag = 300;
    app = make({ loopDelay: () => lag });
    const r = await submit(board);
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("5");
    expect(r.body).toEqual(refusal(["the server is busy; try again in a few seconds"]));
    expect(((await (await app.request("/api/leaderboard/0/0/1")).json()) as { total: number }).total).toBe(0);
    // other requests are answered as usual
    expect((await app.request("/api/health")).status).toBe(200);
    lag = 20;
    expect((await submit(board)).status).toBe(200);
  });

  it("never refuses with the limit at 0", async () => {
    app = make({ loopDelay: () => 1e9, limits: { perIp: 1e9, overloadDelayMs: 0 } });
    expect((await submit(board)).status).toBe(200);
  });

  it("is seen by the loop delay monitor, also before its delayed tick has run", () => {
    // the monitor's ticks run on fake timers, and it reads a clock moved by hand: while the loop is
    // held, the clock moves and no timer runs
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let clock = 0;
    const delay = new LoopDelay(10, 200, () => clock);
    const run = (ms: number) => {
      for (let t = 0; t < ms; t += 10) {
        clock += 10;
        vi.advanceTimersByTime(10);
      }
    };
    try {
      run(100);
      expect(delay.ms()).toBe(0);
      // held for 300 ms just after a tick: the next tick is 290 ms overdue, and runs 300 ms late
      clock += 300;
      expect(delay.ms()).toBe(290);
      run(10);
      expect(delay.ms()).toBe(300);
      expect(delay.takePeak()).toBe(300);
      expect(delay.takePeak()).toBe(0);
      // still remembered in the next window, forgotten in the one after
      run(200);
      expect(delay.ms()).toBe(300);
      run(200);
      expect(delay.ms()).toBe(0);
    } finally {
      delay.stop();
      vi.useRealTimers();
    }
  });
});

describe("the log", () => {
  it("has a line per submission with its status, time and problem, never a name or an address", async () => {
    ip = "198.51.100.23";
    const board = { N: 4, M: 4, P: 2, pieces: [0, 1].map((x) => ({ x, y: 0, theta: Math.PI / 4 })), container_phi: 0 };
    await submit({ ...board, name: "Zed Quill" });
    await submit({ ...board, pieces: [board.pieces[0], board.pieces[0]], name: "Zed Quill" });
    await submit("{nope");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[submit\] 200 4\/4\/2 \d+\.\d+ ms, verification \d+\.\d+ ms$/);
    expect(lines[1]).toMatch(/^\[submit\] 422 4\/4\/2 \d+\.\d+ ms, verification \d+\.\d+ ms$/);
    expect(lines[2]).toMatch(/^\[submit\] 400 - \d+\.\d+ ms$/);
    for (const line of lines) expect(line).not.toMatch(/Zed|198\.51/);
  });

  it("has a line a minute with the counts and verification times, and none for an idle minute", () => {
    const out: string[] = [];
    const stats = new LoadStats((line) => out.push(line));
    stats.flush(3);
    expect(out).toEqual([]);
    for (let i = 1; i <= 100; i++) stats.submission({ status: 200, ms: i + 1, verifyMs: i, problem: "4/4/2" });
    stats.submission({ status: 429, ms: 0.1, verifyMs: null, problem: null });
    stats.leaderChanged();
    stats.stream(1);
    out.length = 0;
    stats.flush(12.345);
    expect(out).toEqual([
      "[load] last minute: 101 submissions (200: 100, 429: 1); verification p50 50.0 ms, p90 90.0 ms, p99 99.0 ms, " +
        "max 100.0 ms, 5050.0 ms in all over 100 boards; 1 leader change; " +
        "1 live stream (1 following every problem, the others 0 keys); event loop delay up to 12.3 ms",
    ]);
    // an open stream keeps the line coming, with the counts started again
    stats.flush(1);
    expect(out[1]).toBe(
      "[load] last minute: 0 submissions; no verification; 0 leader changes; " +
        "1 live stream (1 following every problem, the others 0 keys); event loop delay up to 1.00 ms",
    );
    stats.stream(-1);
    stats.flush(1);
    expect(out).toHaveLength(2);
  });
});
