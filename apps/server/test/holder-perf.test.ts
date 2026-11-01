import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HolderResponse, Holder } from "@polypack/geometry";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { SqliteStore } from "../src/sqlite-store";
import { NewSubmission } from "../src/store";

/**
 * A name that leads 30,000 problems must not hold the server while its page is made: GET /api/holder reads the
 * problems a page at a time with the event loop let in between. The test makes the page of such a name from a
 * database on disk, as the server would, and measures the whole request, and the longest stretch in which the
 * event loop ran nothing else (a setImmediate loop is the probe: it runs once between any two stretches).
 */
describe("GET /api/holder for a name that leads 30,000 problems", () => {
  const PAIRS = 100;
  const PER_PAIR = 300;
  const entry = (N: number, M: number, P: number, score: number, name: string): NewSubmission => ({
    N,
    M,
    P,
    score,
    name,
    agent_note: "",
    found_with: "optimizer",
    method: "asc",
    method_params: null,
    seed: 7,
    budget: null,
    software: null,
    // a packing of tens of poses, as the rows of the live database have
    pieces: Array.from({ length: Math.min(P, 40) }, (_, i) => ({ x: i * 1.0001, y: i / 3, theta: i * 0.1234567 })),
    container_phi: 0,
    created_at: "2026-10-21T00:00:00.000Z",
    verification: "none",
    literature_value: null,
    strict_check: null,
  });

  /** Runs `work` while a loop of setImmediate callbacks measures the longest time between two of them. */
  const probed = async <T>(work: () => Promise<T>): Promise<{ result: T; totalMs: number; longestGapMs: number }> => {
    let running = true;
    let longest = 0;
    let last = performance.now();
    const spin = () => {
      if (!running) return;
      const t = performance.now();
      longest = Math.max(longest, t - last);
      last = t;
      setImmediate(spin);
    };
    setImmediate(spin);
    const began = performance.now();
    last = began;
    const result = await work();
    const totalMs = performance.now() - began;
    // the stretch after the last callback counts too
    longest = Math.max(longest, performance.now() - last);
    running = false;
    return { result, totalMs, longestGapMs: longest };
  };

  it("makes the page in small steps: total time and the longest gap of the event loop", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "polypack-holder-")), "holder.sqlite");
    const store = new SqliteStore(path);
    // "big" leads PAIRS x PER_PAIR problems; "rival" has an entry behind each of the first 10,000 (so that the rows
    // of the name are mixed with others'), and leads 20,000 problems of other pairs
    const seeding = performance.now();
    // one transaction, or each of the 60,000 inserts waits for the disk
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.exec("BEGIN");
    for (let a = 0; a < PAIRS; a++)
      for (let P = 1; P <= PER_PAIR; P++) {
        const N = 3 + (a % 10);
        const M = 3 + Math.floor(a / 10);
        await store.insert(entry(N, M, P, 1, "big"));
        if (a < 34) await store.insert(entry(N, M, P, 2, "rival"));
      }
    for (let a = 0; a < 67; a++)
      for (let P = 1; P <= PER_PAIR; P++)
        await store.insert(entry(20 + (a % 10), 3 + Math.floor(a / 10), P, 1, "rival"));
    db.exec("COMMIT");
    console.log(`seeded in ${(performance.now() - seeding).toFixed(0)} ms`);

    const app = createApp({ store, records: [], adminToken: "secret", log: () => {} });
    // the way a browser asks
    const ask = async (name: string) => {
      const r = await app.request(`/api/holder?name=${encodeURIComponent(name)}`, {
        headers: { "accept-encoding": "gzip" },
      });
      expect(r.status).toBe(200);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
      return { body: JSON.parse(text) as HolderResponse, packed: bytes.length, plain: text.length };
    };

    // the probe sees a blocked loop: a stretch of 25 ms is measured as at least 25
    const control = await probed(async () => {
      const t = performance.now();
      while (performance.now() - t < 25);
    });
    expect(control.longestGapMs).toBeGreaterThanOrEqual(25);

    // the first request of a process pays for everything it runs for the first time (a name that leads nothing
    // takes one stretch of tens of milliseconds), whatever it asks: that is not this page's cost
    expect((await ask("nobody")).body.site_bests).toBe(0);

    const made = await probed(() => ask("big"));
    const { body } = made.result;
    expect(body.name).toBe("big");
    expect(body.site_bests).toBe(PAIRS * PER_PAIR);
    expect(body.records).toBe(PAIRS * PER_PAIR);
    expect(body.pairs).toHaveLength(PAIRS);
    expect(body.pairs.every((p) => p.P.length === PER_PAIR)).toBe(true);

    // the page agrees with the row of /api/holders, which the server counts its own way
    const holders = await (await app.request("/api/holders")).json();
    const row = (holders as { holders: Holder[] }).holders.find((h) => h.name === "big");
    expect(row).toEqual({ name: "big", records: 30_000, beat_published: 0, site_bests: 30_000, pending: 0 });

    const kept = await probed(() => ask("big"));
    expect(kept.result.body).toEqual(body);

    // for contrast: the problems of the name read in one call, as one stretch of the event loop
    const whole = await probed(() => store.problemsNamed("big", null, 100_000));
    expect(whole.result).toHaveLength(30_000);

    console.log(
      `GET /api/holder?name=big, ${body.site_bests} problems in ${body.pairs.length} pairs: ` +
        `made in ${made.totalMs.toFixed(0)} ms in total, longest gap of the event loop ${made.longestGapMs.toFixed(1)} ms; ` +
        `kept: ${kept.totalMs.toFixed(1)} ms in total, longest gap ${kept.longestGapMs.toFixed(1)} ms; ` +
        `answer ${made.result.plain} bytes, ${made.result.packed} gzipped; ` +
        `for contrast, one read of the 30,000 problems alone is a gap of ${whole.longestGapMs.toFixed(1)} ms`,
    );
    // short on a loaded test machine too
    expect(made.longestGapMs).toBeLessThan(50);
    expect(kept.longestGapMs).toBeLessThan(50);
    expect(made.totalMs).toBeLessThan(10_000);
  });
});
