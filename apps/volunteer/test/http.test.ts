import { describe, expect, it } from "vitest";
import { Api, Pacer, RATE_LIMIT_WAIT_MS, compactList } from "../src/http";
import { SOFTWARE_REFUSAL } from "../src/submit";

type Reply = { status: number; body?: unknown } | Error;

/**
 * A fake fetch that answers from a script, and a fake sleep that only advances a fake clock and
 * records how long it was asked to wait.
 */
function harness(replies: Reply[], o: { maxFailures?: number; signal?: AbortSignal } = {}) {
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
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), { status: reply.status });
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

const networkError = () => new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });

describe("the HTTP client", () => {
  it("returns an ordinary answer at once, with the user agent", async () => {
    const h = harness([{ status: 200, body: { ok: true } }]);
    expect(await h.api.request("GET", "/api/health")).toEqual({ status: 200, body: { ok: true } });
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
    expect(await h.api.request("GET", "/api/targets")).toEqual({ status: 200, body: { done: true } });
    expect(h.slept).toEqual([RATE_LIMIT_WAIT_MS, RATE_LIMIT_WAIT_MS]);

    const g = harness(Array.from({ length: 5 }, () => ({ status: 429, body: {} })));
    expect(await g.api.request("GET", "/api/targets")).toMatchObject({ status: 429 });
    expect(g.calls).toHaveLength(4); // the first try and three retries
    expect(g.slept).toEqual([65_000, 65_000, 65_000]);
  });

  it("holds every submission back through the pacer after a 429 on a POST", async () => {
    const h = harness([{ status: 429 }, { status: 200, body: { valid: true } }]);
    const start = h.clock();
    expect(await h.api.request("POST", "/api/submit", { a: 1 })).toMatchObject({ status: 200 });
    expect(h.clock() - start).toBeGreaterThanOrEqual(RATE_LIMIT_WAIT_MS);
    expect(h.calls.map((c) => c.method)).toEqual(["POST", "POST"]);
  });

  it("does not retry 400, 404, 409 or 422", async () => {
    for (const status of [400, 404, 409, 422]) {
      const h = harness([{ status, body: { valid: false, reasons: ["no"] } }, { status: 200 }]);
      expect(await h.api.request("POST", "/api/submit", {})).toEqual({
        status,
        body: { valid: false, reasons: ["no"] },
      });
      expect(h.calls).toHaveLength(1);
      expect(h.slept).toEqual([]);
    }
  });

  it("backs off after network errors and 5xx answers, doubling up to 60 s, and keeps going", async () => {
    const h = harness([
      networkError(),
      { status: 502, body: "Bad Gateway" },
      networkError(),
      networkError(),
      networkError(),
      networkError(),
      networkError(),
      { status: 200, body: { targets: [] } },
    ]);
    expect(await h.api.request("GET", "/api/targets")).toEqual({ status: 200, body: { targets: [] } });
    expect(h.slept).toEqual([2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
    expect(h.logs[0]).toMatch(/failed: fetch failed \(ECONNREFUSED\); retrying in 2 s/);
    expect(h.logs[1]).toMatch(/HTTP 502/);
  });

  it("gives up after its attempts, and at once when the client is stopping", async () => {
    const h = harness(Array.from({ length: 5 }, networkError), { maxFailures: 3 });
    expect(await h.api.request("GET", "/api/targets")).toBeNull();
    expect(h.calls).toHaveLength(3);

    const stop = new AbortController();
    stop.abort();
    const s = harness([{ status: 200 }], { signal: stop.signal });
    expect(await s.api.request("GET", "/api/targets")).toBeNull();
    expect(s.calls).toHaveLength(0);
  });

  it("sends a submission again without `software` after exactly that refusal, once", async () => {
    const refusal = { status: 400, body: { valid: false, reasons: [SOFTWARE_REFUSAL] } };
    const h = harness([refusal, { status: 200, body: { valid: true, leader: true } }]);
    const r = await h.api.submit({ N: 4, name: "A", found_with: "optimizer", software: "polypack-volunteer/0.1.0" });
    expect(r).toEqual({ answer: { status: 200, body: { valid: true, leader: true } }, withoutSoftware: true });
    expect(h.calls.map((c) => c.body)).toEqual([
      { N: 4, name: "A", found_with: "optimizer", software: "polypack-volunteer/0.1.0" },
      { N: 4, name: "A", found_with: "optimizer" },
    ]);

    // a second refusal is not retried again
    const twice = harness([refusal, refusal, { status: 200 }]);
    expect((await twice.api.submit({ software: "x" })).answer).toEqual(refusal);
    expect(twice.calls).toHaveLength(2);

    // nor is any other 400
    const other = harness([{ status: 400, body: { valid: false, reasons: ["name is required"] } }, { status: 200 }]);
    expect((await other.api.submit({ software: "x" })).withoutSoftware).toBe(false);
    expect(other.calls).toHaveLength(1);
  });

  it("returns 409 for a closed problem without retrying", async () => {
    const h = harness([{ status: 409, body: { valid: false, reasons: ["this problem is closed"] } }]);
    expect((await h.api.submit({ software: "x" })).answer?.status).toBe(409);
    expect(h.calls).toHaveLength(1);
  });
});

describe("the submission pacer", () => {
  it("lets at most 6 submissions through per sliding minute", async () => {
    let t = 0;
    const waits: number[] = [];
    const pacer = new Pacer(
      6,
      60_000,
      () => t,
      async (ms) => {
        waits.push(ms);
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
