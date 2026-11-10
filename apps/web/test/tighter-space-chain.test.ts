import { afterEach, describe, expect, it } from "vitest";
import { checkSpaceConfig, parseSearchProblem, spaceKernel } from "@polypack/spaces/search";
import { Lane } from "../src/tighter/lanes";
import { createRunHost } from "../src/tighter/run-host";
import type { HostReply, HostRequest } from "../src/tighter/run-host";
import { ChainedSpaceRun } from "../src/tighter/space-chain";
import {
  CHAIN_LINK_GAME_EVALS,
  type ChainEvent,
  chainLinkEvals,
  chainLinkSeed,
  chainMsBetween,
  chainStateAt,
} from "../src/tighter/space-chain-core";
import { spaceStart } from "../src/tighter/space-run";
import type { SpaceRunRequest, SpaceRunState } from "../src/tighter/space-run-types";

const SPHERE = "sphere/0/20";

describe("chainLinkEvals", () => {
  it("is 5,000 game evaluations when the kernel's finishes are short", () => {
    expect(chainLinkEvals({ finishCost: 100 }, 1)).toBe(CHAIN_LINK_GAME_EVALS);
    expect(chainLinkEvals({ finishCost: 100, validateCost: 50 }, 20)).toBe(CHAIN_LINK_GAME_EVALS * 20);
  });

  it("is three offers (finish and validation) when those are longer", () => {
    expect(chainLinkEvals({ finishCost: 10_100 }, 1)).toBe(3 * 2 * 10_100);
    expect(chainLinkEvals({ finishCost: 90_100, validateCost: 1000 }, 2)).toBe(3 * 91_100);
    // a boundary: exactly equal
    expect(chainLinkEvals({ finishCost: 5000 / 6 }, 1)).toBe(5000);
  });

  it("leaves room for an offer in every real kernel it is used with", () => {
    for (const id of [SPHERE, "torus/sq/0/20", "surface/cube/fold/3/20"]) {
      const k = spaceKernel(parseSearchProblem(id)!)!;
      expect(chainLinkEvals(k, 1)).toBeGreaterThanOrEqual(3 * (k.finishCost + (k.validateCost ?? k.finishCost)));
    }
  });

  it("derives a seed per link, the request's for the first", () => {
    expect(chainLinkSeed(7, 0)).toBe(7);
    const seeds = new Set([0, 1, 2, 3, 4, 5].map((i) => chainLinkSeed(7, i)));
    expect(seeds.size).toBe(6);
    expect(chainLinkSeed(7, 3)).toBe(chainLinkSeed(7, 3));
  });
});

const initial: SpaceRunState = {
  kind: "space",
  evaluations: 0,
  best: { tag: "start" } as never,
  score: 10,
  last: 10,
  found: null,
  offers: 0,
  ended: false,
  closed: false,
};
const cfg = (tag: string) => ({ tag }) as never;
const events: ChainEvent[] = [
  { k: "offer", at: 100, last: 9, found: 9 },
  { k: "best", at: 150, config: cfg("a"), score: 9 },
  { k: "progress", at: 180 },
  { k: "offer", at: 300, last: 9.5, found: 9 },
  { k: "link", at: 400, evals: 400, ms: 40 },
  { k: "offer", at: 500, last: 8, found: 8 },
  { k: "best", at: 550, config: cfg("b"), score: 8 },
  { k: "end", at: 600 },
];

describe("chainStateAt", () => {
  it("shows the initial state before any event", () => {
    const s = chainStateAt(initial, events, 50, 10, 600);
    expect(s).toMatchObject({ evaluations: 5, score: 10, last: 10, found: null, offers: 0, ended: false });
    expect(s.best).toEqual({ tag: "start" });
  });

  it("never reveals an event past the allowance", () => {
    for (const allowed of [0, 99, 100, 149, 150, 299, 300, 499, 500, 549, 550, 599, 600, 900]) {
      const s = chainStateAt(initial, events, allowed, 1, 600);
      const upTo = events.filter((e) => e.at <= allowed);
      const bests = upTo.filter((e) => e.k === "best");
      expect(s.offers).toBe(upTo.filter((e) => e.k === "offer").length);
      expect(s.score).toBe(bests.length ? (bests[bests.length - 1] as { score: number }).score : 10);
      expect(s.ended).toBe(allowed >= 600);
      expect(s.evaluations).toBe(Math.min(allowed, 600));
    }
    const s = chainStateAt(initial, events, 499, 1, 600);
    expect(s).toMatchObject({ score: 9, last: 9.5, found: 9, offers: 2 });
    expect(s.best).toEqual({ tag: "a" });
  });

  it("counts game evaluations, rounded down, and no more than the chain computed", () => {
    expect(chainStateAt(initial, events, 399, 20, 400).evaluations).toBe(19);
    expect(chainStateAt(initial, events, 5000, 20, 400).evaluations).toBe(20);
  });

  it("shows an error as soon as it is known, and gives out copies", () => {
    const s = chainStateAt(initial, [{ k: "end", at: 700, error: "boom" }], 10, 1, 700);
    expect(s).toMatchObject({ ended: true, error: "boom" });
    const t = chainStateAt(initial, events, 160, 1, 600);
    (t.best as unknown as { tag: string }).tag = "changed";
    expect(chainStateAt(initial, events, 160, 1, 600).best).toEqual({ tag: "a" });
  });

  it("is the same when the revealed events are folded into the start", () => {
    const folded = chainStateAt(initial, events, 300, 1, 600);
    const rest = events.filter((e) => e.at > 300);
    expect(chainStateAt(folded, rest, 520, 1, 600)).toEqual(chainStateAt(initial, events, 520, 1, 600));
  });
});

describe("chainMsBetween", () => {
  const links = [
    { from: 0, to: 100, ms: 10 },
    { from: 100, to: 300, ms: 100 },
  ];
  it("charges each link's time per evaluation for the part of the range in it", () => {
    expect(chainMsBetween(links, 0, 100)).toBeCloseTo(10);
    expect(chainMsBetween(links, 50, 200)).toBeCloseTo(5 + 50);
    expect(chainMsBetween(links, 0, 300)).toBeCloseTo(110);
    expect(chainMsBetween(links, 300, 400)).toBe(0);
    expect(chainMsBetween(links, 120, 120)).toBe(0);
  });
});

const request = (over: Partial<SpaceRunRequest> = {}): SpaceRunRequest => ({
  family: "sphere",
  id: SPHERE,
  method: "mc_compress",
  params: {},
  budget: { evals: 20_000 },
  unit: 1,
  seed: 5,
  start: null,
  ...over,
});

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Allows a chain `total` game evaluations and waits until it has done the links that needs and idles. */
async function settle(chain: ChainedSpaceRun, log: ChainEvent[], total: number) {
  chain.allow(total);
  let seen = -1;
  while (log.length !== seen) {
    seen = log.length;
    await tick(60);
  }
}

describe("a chained run", () => {
  const start = spaceStart({ family: "sphere", id: SPHERE, seed: 3 });
  if (!start.ok) throw new Error(start.message);
  const links = (log: ChainEvent[]) => log.filter((e) => e.k === "link");

  it("runs a link only once the allowance has passed the end of the chain so far", async () => {
    const log: ChainEvent[] = [];
    const chain = new ChainedSpaceRun(request({ start: start.config }), (e) => log.push(e));
    const done = chain.run();
    await tick(100);
    expect(log).toEqual([]);
    chain.allow(1);
    await settle(chain, log, 1);
    const first = links(log)[0] as Extract<ChainEvent, { k: "link" }>;
    expect(links(log)).toHaveLength(1);
    // a link may stop short of its length by the cost of an offer that no longer fits
    expect(first.evals).toBeGreaterThanOrEqual(0.9 * CHAIN_LINK_GAME_EVALS);
    // allowed exactly the end of the first link: not past it, so no second link
    await settle(chain, log, first.at);
    expect(links(log)).toHaveLength(1);
    // one more evaluation: exactly one more link
    await settle(chain, log, first.at + 1);
    expect(links(log)).toHaveLength(2);
    chain.close();
    await done;
  }, 120_000);

  it("starts each link from the best so far, and every best is strict", async () => {
    const log: ChainEvent[] = [];
    const chain = new ChainedSpaceRun(
      request({ start: start.config, budget: { evals: 4 * CHAIN_LINK_GAME_EVALS } }),
      (e) => log.push(e),
    );
    const done = chain.run();
    chain.allow(1e9);
    const final = await done;
    expect(final.ended).toBe(true);
    expect(final.error).toBeUndefined();
    expect(links(log).length).toBeGreaterThanOrEqual(3);
    const bests = log.filter((e): e is Extract<ChainEvent, { k: "best" }> => e.k === "best");
    expect(bests.length).toBeGreaterThan(0);
    let score = start.score;
    for (const b of bests) {
      // every best improves on the one before it, across links
      expect(b.score).toBeLessThan(score);
      score = b.score;
      const c = checkSpaceConfig("sphere", SPHERE, b.config, { noRecord: true });
      expect(c.valid).toBe(true);
      expect(c.score).toBe(b.score);
    }
    expect(final.score).toBe(score);
    expect(final.score!).toBeLessThanOrEqual(start.score);
    // events never go backwards, and no link's events pass its end
    let at = 0;
    for (const e of log) {
      expect(e.at).toBeGreaterThanOrEqual(at);
      at = e.at;
    }
  }, 180_000);

  it("keeps to its budget and ends there", async () => {
    const log: ChainEvent[] = [];
    const req = request({ start: start.config, budget: { evals: 2.5 * CHAIN_LINK_GAME_EVALS } });
    const chain = new ChainedSpaceRun(req, (e) => log.push(e));
    const done = chain.run();
    chain.allow(1e9);
    const final = await done;
    const k = spaceKernel(parseSearchProblem(SPHERE)!)!;
    const total = req.budget.evals * req.unit;
    const end = log[log.length - 1] as Extract<ChainEvent, { k: "end" }>;
    expect(end.k).toBe("end");
    // at most the one charge that crosses the budget
    expect(end.at).toBeLessThanOrEqual(total + k.finishCost + (k.validateCost ?? k.finishCost) + 1);
    expect(final.ended).toBe(true);
    // the last link is the rest of the budget, not a whole link
    const ls = links(log) as Extract<ChainEvent, { k: "link" }>[];
    expect(ls[ls.length - 1]!.evals).toBeLessThan(CHAIN_LINK_GAME_EVALS);
  }, 180_000);

  it("gives the same events for the same seed (progress beats and times aside)", async () => {
    const run = async (seed: number) => {
      const log: ChainEvent[] = [];
      const chain = new ChainedSpaceRun(
        request({ seed, start: start.config, budget: { evals: 2 * CHAIN_LINK_GAME_EVALS } }),
        (e) => log.push(e),
      );
      const done = chain.run();
      chain.allow(1e9);
      await done;
      return log.filter((e) => e.k !== "progress").map((e) => (e.k === "link" ? { ...e, ms: 0 } : e));
    };
    const a = await run(11);
    expect(await run(11)).toEqual(a);
    expect(await run(12)).not.toEqual(a);
  }, 180_000);

  it("starts fresh without a start, and refuses what SpaceRun refuses", async () => {
    const log: ChainEvent[] = [];
    const chain = new ChainedSpaceRun(request({ budget: { evals: CHAIN_LINK_GAME_EVALS } }), (e) => log.push(e));
    expect(chain.state().best).toBeNull();
    const done = chain.run();
    chain.allow(1e9);
    const final = await done;
    expect(final.ended).toBe(true);
    expect(() => new ChainedSpaceRun(request({ method: "nope" }), () => undefined)).toThrow();
    expect(() => new ChainedSpaceRun(request({ id: "sphere/0/x" }), () => undefined)).toThrow();
    expect(() => new ChainedSpaceRun(request({ unit: 0 }), () => undefined)).toThrow();
  }, 120_000);
});

describe("Tighter lanes with chained runs", () => {
  /** A worker that runs the host in the same thread, with replies queued by hand. */
  class FakeWorker {
    static all: FakeWorker[] = [];
    onmessage: ((e: { data: HostReply }) => void) | null = null;
    onerror = null;
    onmessageerror = null;
    terminated = false;
    sent: HostRequest[] = [];
    constructor() {
      FakeWorker.all.push(this);
    }
    postMessage(m: HostRequest) {
      this.sent.push(m);
    }
    terminate() {
      this.terminated = true;
    }
    reply(m: HostReply) {
      this.onmessage?.({ data: m });
    }
  }
  const realWorker = (globalThis as { Worker?: unknown }).Worker;
  const realIsolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  afterEach(() => {
    (globalThis as { Worker?: unknown }).Worker = realWorker;
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = realIsolated;
    FakeWorker.all = [];
  });

  const unit = 10;
  const req = request({ unit, budget: { evals: 1000 } });
  const initial: SpaceRunState = {
    kind: "space",
    evaluations: 0,
    best: { tag: "start" } as never,
    score: 10,
    last: 10,
    found: null,
    offers: 0,
    ended: false,
    closed: false,
  };

  async function open() {
    (globalThis as { Worker?: unknown }).Worker = FakeWorker;
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = false;
    const lane = new Lane(0);
    const opened = lane.openSpace(req);
    const w = FakeWorker.all[0]!;
    expect(w.sent[0]).toMatchObject({ type: "open-chain", id: 1 });
    w.reply({ type: "opened", id: 1, params: {}, state: initial });
    expect((await opened).ok).toBe(true);
    return { lane, w };
  }
  const events = (w: FakeWorker, ...e: ChainEvent[]) => w.reply({ type: "chain-events", id: 1, events: e });

  it("uses a chain where there is no shared memory but workers, and says so where there are no workers", async () => {
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = false;
    (globalThis as { Worker?: unknown }).Worker = undefined;
    const lane = new Lane(0);
    expect(await lane.openSpace(req)).toEqual({ ok: false, message: "needs a cross-origin isolated page" });
  });

  it("answers a step at its allowance with the state as of it, and the compute it cost", async () => {
    const { lane, w } = await open();
    let answer: unknown = null;
    const step = lane.step(10).then((a) => (answer = a));
    expect(w.sent.at(-1)).toEqual({ type: "chain-allow", id: 1, total: 10 });
    expect(lane.pending).toBe(1);
    // the link is not over: nothing is answered, whatever the events say
    events(
      w,
      { k: "offer", at: 50, last: 9, found: 9 },
      { k: "best", at: 60, config: { tag: "a" } as never, score: 9 },
    );
    await Promise.resolve();
    expect(answer).toBeNull();
    // the link ends at 500 kernel evaluations in 50 ms; the allowance was 100, so the find at 150 is not shown
    events(
      w,
      { k: "offer", at: 150, last: 8, found: 8 },
      { k: "best", at: 160, config: { tag: "b" } as never, score: 8 },
      { k: "link", at: 500, evals: 500, ms: 50 },
    );
    await step;
    const a = answer as { ok: true; state: SpaceRunState; ms: number };
    expect(a.ok).toBe(true);
    expect(a.state).toMatchObject({ evaluations: 10, score: 9, last: 9, found: 9, offers: 1, ended: false });
    expect(a.state.best).toEqual({ tag: "a" });
    // 100 kernel evaluations of a link that took 0.1 ms each
    expect(a.ms).toBeCloseTo(10);
    // the next step reveals the rest of the link; its time is for its 100 evaluations only
    const next = lane.step(20);
    const b = (await next) as { ok: true; state: SpaceRunState; ms: number };
    expect(b.state).toMatchObject({ evaluations: 30, score: 8, last: 8, offers: 2 });
    expect(b.ms).toBeCloseTo(20);
    expect(lane.pending).toBe(0);
    lane.terminate();
  });

  it("answers a step when the chain ends short of it, with what it did", async () => {
    const { lane, w } = await open();
    const step = lane.step(100);
    events(w, { k: "link", at: 400, evals: 400, ms: 40 }, { k: "end", at: 400 });
    const a = (await step) as { ok: true; state: SpaceRunState };
    expect(a.state).toMatchObject({ evaluations: 40, ended: true });
    expect(lane.open).toBe(false);
    lane.terminate();
  });

  it("reports the revealed state to the progress observer", async () => {
    const { lane, w } = await open();
    const seen: SpaceRunState[] = [];
    lane.onProgress = (s) => seen.push(s as SpaceRunState);
    void lane.step(10);
    events(
      w,
      { k: "best", at: 50, config: { tag: "a" } as never, score: 9 },
      { k: "best", at: 500, config: { tag: "z" } as never, score: 1 },
      { k: "progress", at: 520 },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ evaluations: 10, score: 9 });
    lane.terminate();
  });

  it("terminates a worker that is in the middle of a link when closed, and uses a new one next", async () => {
    const { lane, w } = await open();
    const step = lane.step(10);
    events(w, { k: "best", at: 50, config: { tag: "a" } as never, score: 9 });
    const closed = await lane.close();
    expect(closed).toMatchObject({ ended: true, closed: true, score: 9, evaluations: 5 });
    expect(w.terminated).toBe(true);
    // the step that waited is answered with the same
    expect(await step).toMatchObject({ ok: true, state: { closed: true, score: 9 } });
    expect(lane.pending).toBe(0);
    const next = lane.openSpace(req);
    expect(FakeWorker.all).toHaveLength(2);
    expect(FakeWorker.all[1]!.sent[0]).toMatchObject({ type: "open-chain", id: 2 });
    FakeWorker.all[1]!.reply({ type: "opened", id: 2, params: {}, state: initial });
    expect((await next).ok).toBe(true);
    lane.terminate();
  });

  it("tells an idle worker to close instead, and answers at once", async () => {
    const { lane, w } = await open();
    const step = lane.step(10);
    events(w, { k: "link", at: 100, evals: 100, ms: 10 });
    await step;
    const closed = await lane.close();
    expect(closed).toMatchObject({ closed: true, evaluations: 10 });
    expect(w.terminated).toBe(false);
    expect(w.sent.at(-1)).toEqual({ type: "close", id: 1 });
    lane.terminate();
  });

  it("does nothing on hold, and a start is made by a worker of its own", async () => {
    const { lane, w } = await open();
    lane.hold(true);
    expect(w.sent.map((m) => m.type)).toEqual(["open-chain"]);
    void lane.spaceStart({ family: "sphere", id: SPHERE, seed: 1 });
    expect(FakeWorker.all).toHaveLength(2);
    expect(w.sent.map((m) => m.type)).toEqual(["open-chain"]);
    lane.terminate();
  });

  it("fails its steps when the worker errors", async () => {
    const { lane, w } = await open();
    const step = lane.step(10);
    w.reply({ type: "error", id: 1, message: "boom" });
    expect(await step).toEqual({ ok: false, message: "boom" });
    lane.terminate();
  });
});

describe("the run host with chained runs", () => {
  it("opens a chain, takes allowances and streams events", async () => {
    const replies: HostReply[] = [];
    const host = createRunHost((r) => replies.push(r));
    host.handle({ type: "open-chain", id: 1, request: request({ budget: { evals: CHAIN_LINK_GAME_EVALS } }) });
    expect(replies[0]).toMatchObject({ type: "opened", id: 1 });
    await tick(50);
    expect(replies).toHaveLength(1);
    host.handle({ type: "chain-allow", id: 1, total: 1e9 });
    while (!replies.some((r) => r.type === "chain-events" && r.events.some((e) => e.k === "end"))) await tick(50);
    host.handle({ type: "close", id: 1 });
    expect(replies.at(-1)).toMatchObject({ type: "closed", id: 1 });
    host.handle({ type: "open-chain", id: 2, request: request({ id: "sphere/0/x" }) });
    expect(replies.at(-1)).toMatchObject({ type: "error", id: 2 });
  }, 120_000);
});
