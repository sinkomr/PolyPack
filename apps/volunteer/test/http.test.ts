import { describe, expect, it } from "vitest";
import { RateLimiter, SUBMISSIONS_PER_MINUTE as SERVER_SUBMISSIONS_PER_MINUTE } from "../../server/src/limits";
import {
  Api,
  MAX_SUBMIT_ATTEMPTS,
  Pacer,
  RATE_LIMIT_WAIT_MS,
  SUBMISSIONS_PER_MINUTE,
  SUBMISSION_WINDOW_MS,
  compactList,
} from "../src/http";
import { SOFTWARE_REFUSAL, type SubmitCheck } from "../src/submit";

type Reply = { status: number; body?: unknown; raw?: string } | Error;

/**
 * A fake fetch that answers from a script, and a fake sleep that only advances a fake clock and
 * records how long it was asked to wait.
 */
function harness(replies: Reply[], o: { maxFailures?: number; signal?: AbortSignal; maxAnswerBytes?: number } = {}) {
  const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
  const slept: number[] = [];
  const logs: string[] = [];
  let clock = 1_000_000;
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
      headers: init.headers as Record<string, string>,
    });
    const reply = replies.shift();
    if (!reply) throw new Error("no more scripted replies");
    if (reply instanceof Error) throw reply;
    const text = reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return new Response(text, { status: reply.status });
  }) as unknown as typeof globalThis.fetch;
  const sleep = async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error("aborted");
    slept.push(ms);
    clock += ms;
  };
  const api = new Api("https://example.test", {
    fetch,
    sleep,
    now: () => clock,
    log: (m) => logs.push(m),
    userAgent: "polypack-volunteer/test",
    ...o,
  });
  return { api, calls, slept, logs, clock: () => clock };
}

const networkError = () => new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
const accepted = { status: 200, body: { valid: true, leader: true, id: 9, score: 2 } };

/** A re-read that answers from a script, counting its calls. */
function checks(...answers: (SubmitCheck | null)[]) {
  const calls: number[] = [];
  const check = async () => {
    calls.push(calls.length);
    return answers.shift() ?? null;
  };
  return { check, calls };
}

describe("GET", () => {
  it("returns an ordinary answer at once, with the user agent", async () => {
    const h = harness([{ status: 200, body: { ok: true } }]);
    expect(await h.api.get("/api/health")).toEqual({ status: 200, body: { ok: true } });
    expect(h.calls[0].url).toBe("https://example.test/api/health");
    expect(h.calls[0].headers["user-agent"]).toBe("polypack-volunteer/test");
    expect(h.slept).toEqual([]);
  });

  it("waits 65 s after a 429 and tries again, at most 3 times", async () => {
    const h = harness([
      { status: 429, body: { reasons: ["slow down"] } },
      { status: 429, body: { reasons: ["slow down"] } },
      { status: 200, body: { done: true } },
    ]);
    expect(await h.api.get("/api/targets")).toEqual({ status: 200, body: { done: true } });
    expect(h.slept).toEqual([RATE_LIMIT_WAIT_MS, RATE_LIMIT_WAIT_MS]);

    const g = harness(Array.from({ length: 5 }, () => ({ status: 429, body: {} })));
    expect(await g.api.get("/api/targets")).toMatchObject({ status: 429 });
    expect(g.calls).toHaveLength(4); // the first try and three retries
    expect(g.slept).toEqual([65_000, 65_000, 65_000]);
  });

  it("does not retry 400, 404 or 409", async () => {
    for (const status of [400, 404, 409]) {
      const h = harness([{ status, body: { error: "no" } }, { status: 200 }]);
      expect(await h.api.get("/api/targets")).toEqual({ status, body: { error: "no" } });
      expect(h.calls).toHaveLength(1);
    }
  });

  it("backs off after network errors and 5xx answers, doubling up to 60 s, and keeps going", async () => {
    const h = harness([
      networkError(),
      { status: 502, raw: "Bad Gateway" },
      networkError(),
      networkError(),
      networkError(),
      networkError(),
      networkError(),
      { status: 200, body: { targets: [] } },
    ]);
    expect(await h.api.get("/api/targets")).toEqual({ status: 200, body: { targets: [] } });
    expect(h.slept).toEqual([2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
    expect(h.logs[0]).toMatch(/failed: fetch failed \(ECONNRESET\); retrying in 2 s/);
    expect(h.logs[1]).toMatch(/HTTP 502/);
  });

  it("gives up after 10 attempts, and at once when the client is stopping", async () => {
    const h = harness(Array.from({ length: 12 }, networkError));
    expect(await h.api.get("/api/targets")).toBeNull();
    expect(h.calls).toHaveLength(10);
    expect(h.logs.at(-1)).toMatch(/giving up after 10 attempts/);

    const stop = new AbortController();
    stop.abort();
    const s = harness([{ status: 200 }], { signal: stop.signal });
    expect(await s.api.get("/api/targets")).toBeNull();
    expect(s.calls).toHaveLength(0);
  });

  it("refuses an answer larger than the cap, as a failure", async () => {
    const h = harness(
      [
        { status: 200, raw: "x".repeat(5000) },
        { status: 200, body: { ok: 1 } },
      ],
      {
        maxAnswerBytes: 1000,
      },
    );
    expect(await h.api.get("/api/targets")).toEqual({ status: 200, body: { ok: 1 } });
    expect(h.logs[0]).toMatch(/larger than/);
  });
});

describe("POST /api/submit", () => {
  it("sends once and returns the answer", async () => {
    const h = harness([accepted]);
    const c = checks();
    const r = await h.api.submit({ N: 4 }, c.check);
    expect(r).toEqual({ answer: accepted, requests: 1, withoutSoftware: false, failure: null, check: null });
    expect(c.calls).toHaveLength(0);
  });

  it("holds every submission back through the pacer after a 429, and tries again at most 3 times", async () => {
    const h = harness([{ status: 429 }, accepted]);
    const start = h.clock();
    const r = await h.api.submit({ a: 1 }, checks().check);
    expect(r.answer?.status).toBe(200);
    expect(r.requests).toBe(2);
    expect(h.clock() - start).toBeGreaterThanOrEqual(RATE_LIMIT_WAIT_MS);

    const g = harness(Array.from({ length: 5 }, () => ({ status: 429 })));
    expect((await g.api.submit({ a: 1 }, checks().check)).answer?.status).toBe(429);
    expect(g.calls).toHaveLength(4);
  });

  it("does not retry 400, 409 or 422", async () => {
    for (const status of [400, 409, 422]) {
      const h = harness([{ status, body: { valid: false, reasons: ["no"] } }, accepted]);
      const c = checks();
      const r = await h.api.submit({}, c.check);
      expect(r.answer).toEqual({ status, body: { valid: false, reasons: ["no"] } });
      expect(h.calls).toHaveLength(1);
      expect(c.calls).toHaveLength(0);
    }
  });

  it("sends again without `software` after exactly that refusal, once", async () => {
    const refusal = { status: 400, body: { valid: false, reasons: [SOFTWARE_REFUSAL] } };
    const h = harness([refusal, accepted]);
    const r = await h.api.submit(
      { N: 4, name: "A", found_with: "optimizer", software: "polypack-volunteer/0.1.0" },
      checks().check,
    );
    expect(r).toMatchObject({ answer: accepted, withoutSoftware: true, requests: 2 });
    expect(h.calls.map((c) => c.body)).toEqual([
      { N: 4, name: "A", found_with: "optimizer", software: "polypack-volunteer/0.1.0" },
      { N: 4, name: "A", found_with: "optimizer" },
    ]);

    // a second refusal is not retried again
    const twice = harness([refusal, refusal, accepted]);
    expect((await twice.api.submit({ software: "x" }, checks().check)).answer).toEqual(refusal);
    expect(twice.calls).toHaveLength(2);

    // nor is any other 400
    const other = harness([{ status: 400, body: { valid: false, reasons: ["name is required"] } }, accepted]);
    expect((await other.api.submit({ software: "x" }, checks().check)).withoutSoftware).toBe(false);
    expect(other.calls).toHaveLength(1);
  });

  // Fix 1: a POST whose answer was lost may have been stored; it is never sent again blindly.
  for (const [what, failure] of [
    ["a network error", networkError()],
    ["a 5xx", { status: 502, raw: "Bad Gateway" }],
    ["a timeout", new DOMException("The operation was aborted due to timeout", "TimeoutError")],
  ] as const) {
    it(`after ${what}, reads the problem and does not send again when the packing is there`, async () => {
      const h = harness([failure, accepted]);
      const c = checks({ state: "ours", id: 41, score: 2 });
      const r = await h.api.submit({ N: 4 }, c.check);
      expect(h.calls).toHaveLength(1); // no second POST
      expect(c.calls).toHaveLength(1);
      expect(r).toMatchObject({ answer: null, requests: 1, check: { state: "ours", id: 41 } });
      expect(r.failure).toBeTruthy();
    });
  }

  it("sends again only when the re-read shows it absent, re-reading before each attempt, at most 3 POSTs", async () => {
    const h = harness([networkError(), networkError(), accepted]);
    const c = checks({ state: "absent" }, { state: "absent" });
    const r = await h.api.submit({ N: 4 }, c.check);
    expect(r).toMatchObject({ answer: accepted, requests: 3 });
    expect(c.calls).toHaveLength(2);
    expect(h.slept).toEqual([2000, 4000]);

    const g = harness(Array.from({ length: 5 }, networkError));
    const d = checks(...Array.from({ length: 5 }, () => ({ state: "absent" }) as const));
    const s = await g.api.submit({ N: 4 }, d.check);
    expect(g.calls).toHaveLength(MAX_SUBMIT_ATTEMPTS);
    expect(d.calls).toHaveLength(MAX_SUBMIT_ATTEMPTS);
    expect(s).toMatchObject({ answer: null, requests: MAX_SUBMIT_ATTEMPTS, check: { state: "absent" } });
  });

  it("does not send again when the re-read fails, the problem closed, or another leader is as good", async () => {
    for (const answer of [null, { state: "closed" } as const, { state: "beaten", leader: 1.9 } as const]) {
      const h = harness([networkError(), accepted]);
      const r = await h.api.submit({ N: 4 }, checks(answer).check);
      expect(h.calls).toHaveLength(1);
      expect(r).toMatchObject({ answer: null, requests: 1, check: answer });
    }
  });

  it("counts no request when the client stopped before sending", async () => {
    const stop = new AbortController();
    stop.abort();
    const h = harness([accepted], { signal: stop.signal });
    const c = checks();
    const r = await h.api.submit({ N: 4 }, c.check);
    expect(r).toMatchObject({ answer: null, requests: 0 });
    expect(h.calls).toHaveLength(0);
    expect(c.calls).toHaveLength(0);
  });

  it("treats an oversized answer to a POST as unknown, and reads the problem", async () => {
    const h = harness([{ status: 200, raw: "x".repeat(5000) }], { maxAnswerBytes: 1000 });
    const c = checks({ state: "ours", id: 3, score: 2 });
    const r = await h.api.submit({ N: 4 }, c.check);
    expect(r).toMatchObject({ answer: null, requests: 1, check: { state: "ours" } });
  });
});

describe("the submission pacer", () => {
  it("keeps a client within the server's limit per address, also when requests arrive up to a second late", async () => {
    expect(SUBMISSIONS_PER_MINUTE).toBe(SERVER_SUBMISSIONS_PER_MINUTE);
    expect(SUBMISSION_WINDOW_MS).toBe(61_000);
    // the client sends 400 submissions as fast as its pacer lets it; each reaches the server 0 to 999 ms later
    let t = 0;
    const pacer = new Pacer(
      SUBMISSIONS_PER_MINUTE,
      SUBMISSION_WINDOW_MS,
      () => t,
      async (ms) => {
        t += ms;
      },
    );
    let seed = 7;
    const jitter = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % 1000;
    };
    const arrivals: number[] = [];
    for (let i = 0; i < 400; i++) {
      await pacer.acquire();
      arrivals.push(t + jitter());
    }
    // the server's limiter, which opens a 60 s window at an address's first hit, refuses none of them
    let now = 0;
    const server = new RateLimiter(SERVER_SUBMISSIONS_PER_MINUTE, 60_000, () => now);
    for (const at of arrivals.sort((x, y) => x - y)) {
      now = at;
      expect(server.allow("one address"), `arrival at ${at} ms`).toBe(true);
    }
    // about 118 a minute: 120 in every 61 s
    expect(t).toBeLessThan(4 * SUBMISSION_WINDOW_MS);
  });

  it("lets at most 6 submissions through per sliding minute", async () => {
    let t = 0;
    const pacer = new Pacer(
      6,
      60_000,
      () => t,
      async (ms) => {
        t += ms;
      },
    );
    const times: number[] = [];
    for (let i = 0; i < 8; i++) {
      await pacer.acquire();
      times.push(t);
      t += 1000;
    }
    expect(times.slice(0, 6)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    expect(times[6]).toBe(60_000);
    expect(times[7]).toBe(61_000);
  });

  it("holds everything back while blocked", async () => {
    let t = 0;
    const pacer = new Pacer(
      6,
      60_000,
      () => t,
      async (ms) => void (t += ms),
    );
    pacer.block(65_000);
    await pacer.acquire();
    expect(t).toBe(65_000);
  });
});

describe("filters in the query", () => {
  it("are written back as compact lists", () => {
    expect(compactList([0, 3, 4, 5, 6, 8, 10, 11])).toBe("0,3-6,8,10-11");
    expect(compactList([4])).toBe("4");
  });
});
