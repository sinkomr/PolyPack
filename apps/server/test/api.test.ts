import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AtlasResponse,
  LEADERBOARD_SIZE,
  LiteratureRecord,
  PackingConfig,
  SCORE_TIE,
  SubmitResponse,
  TARGET_WEIGHTS,
  TargetsResponse,
  areaLowerBound,
  closedToSubmissions,
  evaluate,
  improvesOn,
  isProven,
  rankTargets,
} from "@polypack/geometry";
import { registry } from "@polypack/solver";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATLAS_MAX_PIECES,
  ATLAS_MAX_SPAN,
  HOLDERS_REFRESH_MS,
  TARGETS_DEFAULT_LIMIT,
  TARGETS_MAX_LIMIT,
  TARGETS_REFRESH_MS,
  atlasSource,
  createApp,
} from "../src/app";
import { SOLVER_METHODS } from "../src/docs";
import { SqliteStore } from "../src/sqlite-store";
import { GET_MANY_LIMIT, NewSubmission } from "../src/store";
import { withUnits } from "./units";

const SQ = Math.PI / 4;
const row = (n: number, gap = 1): PackingConfig["pieces"] =>
  Array.from({ length: n }, (_, i) => ({ x: i * gap, y: 0, theta: SQ }));

// A made-up published value, far above what three squares need, to trigger the review path.
const fakeRecord: LiteratureRecord = {
  N: 4,
  M: 4,
  P: 3,
  value: 5,
  display: "5.00",
  display_precision: 2,
  status: "best_known",
  source_name: "test",
  source_url: "https://example.invalid",
  accessed: "2026-10-07",
  conversion_note: "none",
};

let app: ReturnType<typeof createApp>;
let logs: string[];
let ip = "1.1.1.1";

beforeEach(() => {
  logs = [];
  ip = "1.1.1.1";
  app = createApp({
    store: new SqliteStore(":memory:"),
    records: [fakeRecord],
    adminToken: "secret",
    clientIp: () => ip,
    log: (m) => logs.push(m),
    limits: { perIp: 8 },
  });
});

async function submit(body: unknown): Promise<{ status: number; body: SubmitResponse }> {
  const r = await app.request("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(withUnits(body)),
  });
  return { status: r.status, body: (await r.json()) as SubmitResponse };
}
const get = async (path: string, headers?: Record<string, string>) => {
  const r = await app.request(path, { headers });
  // responses differ per route; the assertions below check the fields they use
  return { status: r.status, body: (await r.json()) as any };
};
const squares = (P: number, extra: object = {}) => ({
  N: 4,
  M: 4,
  P,
  pieces: row(P),
  container_phi: 0,
  name: "ann",
  ...extra,
});

describe("POST /api/submit", () => {
  it("accepts a valid packing and stores the server-computed score", async () => {
    const r = await submit(squares(2, { score: 0.001, container: { size: 0.001 } }));
    expect(r.status).toBe(200);
    expect(r.body.valid).toBe(true);
    expect(r.body.score).toBeCloseTo(2, 9);
    expect(r.body.rank).toBe(1);
    expect(r.body.leader).toBe(true);
    expect(r.body.leader_score).toBe(r.body.score);
    const lb = await get("/api/leaderboard/4/4/2");
    expect(lb.body.entries[0].score).toBe(r.body.score);
    expect(lb.body.total).toBe(1);
    expect(lb.body.accepts_submissions).toBe(true);
  });

  it("scores the container at the phi sent and does not look for a better one", async () => {
    // two squares side by side fit a square of side 2 at phi = 0; turned by 0.3 it must be larger
    const turned = squares(2, { container_phi: 0.3 });
    const r = await submit(turned);
    expect(r.body.score).toBe(evaluate(turned).score);
    expect(r.body.container).toEqual(evaluate(turned).container);
    expect(r.body.container!.phi).toBe(0.3);
    expect(r.body.score!).toBeGreaterThan(2.1);
    // the better orientation was there to be found, by the client
    const oriented = evaluate(turned, { autoOrient: true });
    expect(oriented.score).toBeCloseTo(2, 9);
    expect((await submit({ ...turned, container_phi: oriented.container!.phi })).body.score).toBe(oriented.score);
    // without container_phi, at 0
    const { container_phi: _phi, ...unturned } = squares(2, { name: "bob" });
    const zero = await submit(unturned);
    expect(zero.body.container!.phi).toBe(0);
    expect(zero.body.score).toBe(evaluate(squares(2)).score);
  });

  it("rejects overlaps, wrong counts and malformed bodies with reasons", async () => {
    const overlap = await submit({ ...squares(2), pieces: row(2, 0.9) });
    expect(overlap.status).toBe(422);
    expect(overlap.body.reasons[0]).toMatch(/overlapping/);
    expect(overlap.body).toMatchObject({ rank: null, leader: false, leader_score: null, id: null });
    const count = await submit({ ...squares(3), pieces: row(2) });
    expect(count.status).toBe(422);
    expect(count.body.reasons[0]).toMatch(/exactly 3 pieces/);
    expect((await submit("{nope")).status).toBe(400);
    expect((await submit({ ...squares(2), N: 2 })).status).toBe(400);
    expect((await submit({ ...squares(2), P: 501 })).status).toBe(400);
    expect((await submit({ ...squares(2), name: "  " })).body.reasons).toEqual(["name is required"]);
    expect(
      (
        await submit({
          ...squares(2),
          pieces: [
            { x: 0, y: 0, theta: 0 },
            { x: "1", y: 0, theta: 0 },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await get("/api/leaderboard/4/4/2")).body.total).toBe(0);
  });

  it("caps the payload size", async () => {
    const r = await submit(squares(2, { agent_note: "x".repeat(300_000) }));
    expect(r.status).toBe(413);
  });

  it("sanitizes names and notes", async () => {
    await submit(
      squares(2, {
        name: "  <b>Bob</b>\u0000\n  the   builder ",
        agent_note: "<script>x</script>",
        found_with: "external",
        software: " <i>my</i>\ttool ",
      }),
    );
    const e = (await get("/api/leaderboard/4/4/2")).body.entries[0];
    expect(e.name).toBe("b Bob /b the builder");
    expect(e.agent_note).not.toMatch(/[<>]/);
    expect((await get(`/api/submissions/${e.id}`)).body.software).toBe("i my /i tool");
  });

  it("rate-limits by address, not by name", async () => {
    for (let i = 0; i < 8; i++) expect((await submit(squares(2))).status).toBe(200);
    expect((await submit(squares(2, { name: "fresh" }))).status).toBe(429);
    ip = "2.2.2.2";
    expect((await submit(squares(2))).status).toBe(200);
  });
});

describe("how a submission was found", () => {
  const run = {
    method: "basin_hopping",
    method_params: { iterations: 200, stepScale: 0.25, operators: ["shift", "swap"] },
    seed: 7,
    budget: { evals: 20000, time_s: 20 },
  };
  const stored = async (id: number | null) => (await get(`/api/submissions/${id}`)).body;
  let sent = 0;
  const reasons = async (extra: object) => {
    // a fresh address each time: the rate limit is not under test here
    ip = `10.0.0.${++sent}`;
    const r = await submit(squares(2, extra));
    expect(r.status).toBe(400);
    expect(r.body.valid).toBe(false);
    return r.body.reasons.join("; ");
  };

  it("stores the method and its settings, and returns them only with the full entry", async () => {
    const r = await submit(squares(2, { found_with: "optimizer", ...run }));
    expect(r.status).toBe(200);
    const s = await stored(r.body.id);
    expect(s).toMatchObject({ found_with: "optimizer", ...run, software: null, agent_note: "" });
    expect(s).not.toHaveProperty("agent");
    // the listings carry found_with only
    const listed = [
      (await get("/api/leaderboard/4/4/2")).body.entries[0],
      (await get("/api/problems/4/4/2")).body.site_best,
      (await get("/api/records?N=4&M=4")).body.site[0],
    ];
    for (const e of listed) {
      expect(e.found_with).toBe("optimizer");
      for (const key of ["agent", "method", "method_params", "seed", "budget", "software"])
        expect(e).not.toHaveProperty(key);
    }
  });

  it("records an edited optimizer result, one's own software and a hand-made entry", async () => {
    const edited = await submit(squares(2, { found_with: "optimizer_edited", method: "asc" }));
    expect(await stored(edited.body.id)).toMatchObject({
      found_with: "optimizer_edited",
      method: "asc",
      method_params: null,
      seed: null,
      budget: null,
      software: null,
    });
    const own = await submit(squares(3, { found_with: "external", software: "my packer 2.1" }));
    expect(await stored(own.body.id)).toMatchObject({
      found_with: "external",
      software: "my packer 2.1",
      method: null,
    });
    // without found_with, an entry counts as found by hand
    const hand = await submit(squares(4));
    expect(await stored(hand.body.id)).toMatchObject({ found_with: "hand", method: null, seed: null });
    expect((await get("/api/leaderboard/4/4/4")).body.entries[0].found_with).toBe("hand");
  });

  it("records the client that ran a PolyPack optimizer", async () => {
    const volunteer = await submit(
      squares(2, { found_with: "optimizer", ...run, software: "polypack-volunteer/0.1.0" }),
    );
    expect(volunteer.status).toBe(200);
    expect(await stored(volunteer.body.id)).toMatchObject({
      found_with: "optimizer",
      ...run,
      software: "polypack-volunteer/0.1.0",
    });
    const game = await submit(
      squares(3, { found_with: "optimizer_edited", method: "shrink_repair", software: " Tighter <1.2> " }),
    );
    expect(await stored(game.body.id)).toMatchObject({
      found_with: "optimizer_edited",
      method: "shrink_repair",
      software: "Tighter 1.2",
    });
    // the listings still carry found_with only
    expect((await get("/api/leaderboard/4/4/2")).body.entries[0]).not.toHaveProperty("software");
  });

  it("accepts the legacy agent field unchanged and ignores it", async () => {
    // the body the batch runner sent before found_with existed
    const legacy = await submit(
      squares(2, { agent: "ai", agent_note: "cloud pilot asc, seed 2, 20000 evaluations / 15 s" }),
    );
    expect(legacy.status).toBe(200);
    expect(legacy.body.valid).toBe(true);
    const s = await stored(legacy.body.id);
    // an AI entry without found_with may or may not come from an optimizer: not recorded
    expect(s).toMatchObject({ found_with: null, agent_note: "cloud pilot asc, seed 2, 20000 evaluations / 15 s" });
    expect(s).not.toHaveProperty("agent");
    expect((await get("/api/leaderboard/4/4/2")).body.entries[0]).not.toHaveProperty("agent");
    // "human" was the old default; any other value is ignored too
    expect((await stored((await submit(squares(3, { agent: "human" }))).body.id)).found_with).toBe("hand");
    ip = "10.0.2.1";
    expect((await submit(squares(4, { agent: "robot" }))).status).toBe(200);
    expect(
      (await stored((await submit(squares(5, { agent: "ai", found_with: "optimizer", method: "asc" }))).body.id))
        .found_with,
    ).toBe("optimizer");
  });

  it("accepts every registered method with its default parameters", async () => {
    let n = 0;
    for (const m of registry.list()) {
      ip = `10.0.3.${++n}`;
      const r = await submit(
        squares(2, {
          found_with: "optimizer",
          method: m.name,
          method_params: m.defaults,
          seed: 0,
          budget: { evals: 1 },
        }),
      );
      expect([m.name, r.status]).toEqual([m.name, 200]);
    }
  });

  it("refuses wrong values with a reason and stores nothing", async () => {
    expect(await reasons({ found_with: "magic" })).toMatch(/found_with must be one of "hand", "optimizer"/);
    expect(await reasons({ found_with: 1 })).toMatch(/found_with must be one of/);
    expect(await reasons({ found_with: "optimizer", method: "simulated_annealing" })).toMatch(
      /method must be the name of a registered search method/,
    );
    expect(await reasons({ found_with: "optimizer", method: 3 })).toMatch(/method must be the name/);
    expect(await reasons({ found_with: "optimizer" })).toMatch(/method is required when found_with is "optimizer"/);
    expect(await reasons({ found_with: "optimizer_edited", seed: 1 })).toMatch(/method is required/);
    expect(await reasons({ found_with: "optimizer", method: "asc", method_params: [1, 2] })).toMatch(
      /method_params must be a JSON object/,
    );
    expect(await reasons({ found_with: "optimizer", method: "asc", method_params: null })).toMatch(
      /method_params must be a JSON object/,
    );
    expect(
      await reasons({ found_with: "optimizer", method: "asc", method_params: { blob: "x".repeat(4100) } }),
    ).toMatch(/method_params must be at most 4096 bytes/);
    for (const seed of [1.5, -1, "1", 2 ** 60])
      expect(await reasons({ found_with: "optimizer", method: "asc", seed })).toMatch(
        /seed must be a non-negative integer/,
      );
    for (const budget of [
      20000,
      {},
      { evals: 0 },
      { evals: 1.5 },
      { time_s: "15" },
      { time_s: -1 },
      { evals: 10, steps: 3 },
      null,
    ])
      expect(await reasons({ found_with: "optimizer", method: "asc", budget })).toMatch(/budget must be/);
    expect(await reasons({ found_with: "external", software: 7 })).toMatch(/software must be a string/);
    expect(await reasons({ found_with: "external", software: "x".repeat(81) })).toMatch(/at most 80 characters/);
    // fields that contradict found_with
    expect(await reasons({ method: "asc" })).toMatch(/need found_with "optimizer" or "optimizer_edited"/);
    expect(await reasons({ found_with: "external", method: "asc", seed: 2 })).toMatch(/method, seed describe/);
    // software names a program, so a packing made by hand, or not said to be made otherwise, has none
    expect(await reasons({ found_with: "hand", software: "x" })).toMatch(
      /software needs found_with "external", "optimizer" or "optimizer_edited"/,
    );
    expect(await reasons({ software: "x" })).toMatch(/software needs found_with "external"/);
    expect(await reasons({ agent: "ai", software: "x" })).toMatch(/software needs found_with "external"/);
    expect(await reasons({ found_with: "optimizer", method: "asc", software: 7 })).toMatch(/software must be a string/);
    // configuration errors and provenance errors are reported together
    ip = "10.0.1.1";
    const both = await submit({ ...squares(2), P: 0, found_with: "nope" });
    expect(both.body.reasons.join("; ")).toMatch(/P must be.*found_with must be/);
    expect((await get("/api/leaderboard/4/4/2")).body.total).toBe(0);
  });
});

describe("GET /api", () => {
  it("serves the documentation page", async () => {
    const r = await app.request("/api");
    expect(r.status).toBe(200);
    const html = await r.text();
    for (const part of [
      "POST /api/submit",
      "GET /api/problems/{N}/{M}/{P}",
      "Example in Python",
      "Example with curl",
      "derived-records",
      "GET /api/leaderboard/{N}/{M}/{P}",
      "GET /api/submissions/{id}",
      "GET /api/records?N=&amp;M=",
      "GET /api/events",
      "GET /api/health",
      "GET /api/admin/pending",
      "POST /api/admin/review",
      "POST /api/admin/remove",
      "Authorization: Bearer",
      "accepts_submissions",
      "leader_score",
      "<td>409</td>",
      `score ≤ min · (1 + ${SCORE_TIE})`,
      'id="automated-search"',
      "examples/solve-and-submit.ts",
      "https://github.com/sinkomr/PolyPack",
      // the scoring rule, plainly, with the default
      "The score is computed at the <code>container_phi</code> you send</strong> (0 when it is missing)",
      "does not search for a better one",
      'href="#orientation">orient your board before submitting',
    ]) {
      expect(html).toContain(part);
    }
    // and in the conventions every problem description carries
    const { conventions } = (await get("/api/problems/4/4/2")).body;
    expect(conventions.scoring).toMatch(
      /^the server scores the container at the container_phi sent \(0 when it is missing\) and does not search for a better orientation/,
    );
    // nothing is left of the three-row leaderboard
    expect(html).not.toMatch(/top[- ]3|top three/i);
  });

  it("lists exactly the registered search methods", async () => {
    expect(SOLVER_METHODS.map(([name]) => name)).toEqual(registry.list().map((m) => m.name));
    const html = await (await app.request("/api")).text();
    for (const m of registry.list()) expect(html).toContain(`<td><code>${m.name}</code></td>`);
  });
});

/** Reads the event stream of the current app; `count` is the number of leaderboard events seen so far. */
async function listen() {
  const res = await app.request("/api/events");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const until = async (needle: string) => {
    while (!seen.includes(needle)) seen += decoder.decode((await reader.read()).value);
  };
  await until("hello");
  return { until, count: () => seen.split("event: leaderboard").length - 1, close: () => reader.cancel() };
}

/** Two disks of diameter 1 with centres `d` apart in a circle: the score (the circle's diameter) is 1 + d. */
const twoCircles = (score: number, name: string) => ({
  N: 0,
  M: 0,
  P: 2,
  pieces: [
    { x: 0, y: 0, theta: 0 },
    { x: score - 1, y: 0, theta: 0 },
  ],
  container_phi: 0,
  name,
});

describe("leaderboard", () => {
  it("keeps and shows only the best entry, and counts every submission", async () => {
    expect(LEADERBOARD_SIZE).toBe(1);
    const gaps = [1.5, 1.2, 1.0, 1.3, 1.1];
    const answers: SubmitResponse[] = [];
    for (const [i, gap] of gaps.entries()) {
      answers.push((await submit({ ...squares(2, { name: `p${i}` }), pieces: row(2, gap) })).body);
    }
    // a rank counts the entries stored when the entry arrived: by then only the leader
    expect(answers.map((a) => a.rank)).toEqual([1, 1, 1, 2, 2]);
    expect(answers.map((a) => a.leader)).toEqual([true, true, true, false, false]);
    // each answer names the score to beat, which is the entry's own when it leads
    const best = answers[2].score;
    expect(answers.map((a) => a.leader_score)).toEqual([answers[0].score, answers[1].score, best, best, best]);
    const lb = (await get("/api/leaderboard/4/4/2")).body;
    expect(lb.total).toBe(5);
    expect(lb.entries.map((e: { name: string }) => e.name)).toEqual(["p2"]);
    const problem = (await get("/api/problems/4/4/2")).body;
    expect(problem.site_best.name).toBe("p2");
    expect(problem.accepts_submissions).toBe(true);
    expect(problem.area_bound).toBeCloseTo(Math.SQRT2, 12);
    const stored = (await get(`/api/submissions/${problem.site_best.id}`)).body;
    expect(stored.pieces).toEqual(row(2, 1.0));
    // the overtaken leaders were deleted, and the entries that never led were not kept
    expect(answers.map((a) => a.id)).toEqual([1, 2, 3, null, null]);
    for (const id of [1, 2, 4, 5]) expect((await get(`/api/submissions/${id}`)).status).toBe(404);
    const records = (await get("/api/records?N=4&M=4")).body;
    expect(records.site.map((s: { P: number }) => s.P)).toEqual([2]);
    expect(records.site[0].name).toBe("p2");
    expect(records.literature).toHaveLength(1);
  });

  it("sends a live event when a problem gets a new leader", async () => {
    const events = await listen();
    await submit(squares(2));
    await events.until("event: leaderboard");
    await events.until('"rank":1');
    await events.close();
  });

  it("keeps the earliest of equally good entries as the leader", async () => {
    expect(improvesOn(1 - 2 * SCORE_TIE, 1)).toBe(true);
    expect(improvesOn(1 - SCORE_TIE / 2, 1)).toBe(false);
    expect(improvesOn(1, 1)).toBe(false);
    expect(improvesOn(1 + 2 * SCORE_TIE, 1)).toBe(false);

    const events = await listen();
    const leaderOf = async () => (await get("/api/leaderboard/0/0/2")).body.entries.map((e: { id: number }) => e.id);
    const first = (await submit(twoCircles(2.5, "first"))).body;
    expect(first).toMatchObject({ valid: true, rank: 1, leader: true, leader_score: first.score });
    expect(first.score).toBeCloseTo(2.5, 12);

    // an identical score
    const equal = (await submit(twoCircles(2.5, "equal"))).body;
    expect(equal.score).toBe(first.score);
    expect(equal).toMatchObject({ valid: true, rank: 2, leader: false, leader_score: first.score });
    expect(await leaderOf()).toEqual([first.id]);

    // a smaller score, but by less than the tolerance: nothing is strictly ahead of it, yet it does not lead
    const hair = (await submit(twoCircles(2.5 * (1 - SCORE_TIE / 2), "hair"))).body;
    expect(hair.score!).toBeLessThan(first.score!);
    expect(improvesOn(hair.score!, first.score!)).toBe(false);
    expect(hair).toMatchObject({ valid: true, rank: 2, leader: false, leader_score: first.score });
    expect(await leaderOf()).toEqual([first.id]);
    expect((await get("/api/problems/0/0/2")).body.site_best.id).toBe(first.id);
    expect((await get("/api/records?N=0&M=0")).body.site).toEqual([expect.objectContaining({ P: 2, id: first.id })]);

    // a worse score; the two before were not kept, so it is second among what is stored
    const worse = (await submit(twoCircles(2.6, "worse"))).body;
    expect(worse).toMatchObject({ valid: true, rank: 2, leader: false, leader_score: first.score, id: null });

    // better by more than the tolerance: the lead changes
    const better = (await submit(twoCircles(2.5 * (1 - 3 * SCORE_TIE), "better"))).body;
    expect(improvesOn(better.score!, first.score!)).toBe(true);
    expect(better).toMatchObject({ valid: true, rank: 1, leader: true, leader_score: better.score });
    expect(await leaderOf()).toEqual([better.id]);

    // and the new leader is as safe from a later tie as the first one was
    const again = (await submit(twoCircles(2.5 * (1 - 3 * SCORE_TIE), "again"))).body;
    expect(again).toMatchObject({ valid: true, rank: 2, leader: false, leader_score: better.score });
    expect(await leaderOf()).toEqual([better.id]);
    expect((await get("/api/leaderboard/0/0/2")).body.total).toBe(6);

    // six submissions, two changes of leader, two events; a third problem's event closes the count
    const other = (await submit(squares(2))).body;
    await events.until(`"id":${other.id},`);
    expect(events.count()).toBe(3);
    await events.until(`"id":${first.id},`);
    await events.until(`"id":${better.id},`);
    await events.close();

    // only the leader was kept, so when it is taken off the site the problem has no entry
    const removed = await app.request("/api/admin/remove", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ id: better.id }),
    });
    expect(removed.status).toBe(200);
    expect(await leaderOf()).toEqual([]);
    expect((await get("/api/leaderboard/0/0/2")).body.total).toBe(6);
  });

  it("measures a new entry against the leader alone, since nothing else is kept", async () => {
    // Three scores, each within the tolerance of the next but the last not of the first. The
    // second does not lead and is not kept, so no chain of near ties forms: the third is better
    // than the leader by more than the tolerance, and takes the lead.
    const events = await listen();
    const a = (await submit(twoCircles(2.5, "a"))).body;
    const b = (await submit(twoCircles(2.5 * (1 - 0.6 * SCORE_TIE), "b"))).body;
    expect(b).toMatchObject({ leader: false, id: null });
    const c = (await submit(twoCircles(2.5 * (1 - 1.2 * SCORE_TIE), "c"))).body;
    expect(improvesOn(c.score!, a.score!)).toBe(true);
    expect(c).toMatchObject({ valid: true, rank: 1, leader: true, leader_score: c.score });
    expect((await get("/api/leaderboard/0/0/2")).body.entries.map((e: { id: number }) => e.id)).toEqual([c.id]);
    await events.until(`"id":${a.id},`);
    await events.until(`"id":${c.id},`);
    expect(events.count()).toBe(2);
    await events.close();
  });
});

describe("store: the leader per problem", () => {
  const entry = (P: number, score: number, verification: NewSubmission["verification"] = "none"): NewSubmission => ({
    N: 4,
    M: 4,
    P,
    score,
    name: `P${P}`,
    agent_note: "",
    found_with: "hand",
    method: null,
    method_params: null,
    seed: null,
    budget: null,
    software: null,
    pieces: [],
    container_phi: 0,
    created_at: "2026-10-12T00:00:00.000Z",
    verification,
    literature_value: null,
    strict_check: null,
  });

  it("applies the tie rule to every P, with and without pending entries", async () => {
    const store = new SqliteStore(":memory:");
    const id: Record<string, number> = {};
    const add = async (key: string, s: NewSubmission) => {
      id[key] = await store.insert(s);
    };
    // P = 2: equal scores
    await add("2a", entry(2, 2));
    await add("2b", entry(2, 2));
    // P = 3: the later one is smaller by less than the tolerance
    await add("3a", entry(3, 3));
    await add("3b", entry(3, 3 * (1 - SCORE_TIE / 2)));
    // P = 4: two equal claims awaiting review ahead of an ordinary entry
    await add("4a", entry(4, 4));
    await add("4b", entry(4, 3.9, "pending"));
    await add("4c", entry(4, 3.9, "pending"));
    // P = 5: nothing but a claim
    await add("5a", entry(5, 5, "pending"));
    // P = 6: a rejected entry is never the minimum that the others are measured against
    await add("6a", entry(6, 6));
    await add("6b", entry(6, 5, "rejected"));
    await add("6c", entry(6, 6));
    // P = 7: a real improvement, and a confirmed entry counts as reviewed
    await add("7a", entry(7, 7));
    await add("7b", entry(7, 6.99, "confirmed"));
    await add("7c", entry(7, 6.99));
    // another problem with a smaller score is not mixed in
    await add("x", { ...entry(2, 1.5), M: 5 });

    const leaders = async (verifiedOnly?: boolean) =>
      Object.fromEntries((await store.bestPerP(4, 4, verifiedOnly)).map((e) => [e.P, e.id]));
    expect(await leaders()).toEqual({ 2: id["2a"], 3: id["3a"], 4: id["4b"], 5: id["5a"], 6: id["6a"], 7: id["7b"] });
    expect(await leaders(true)).toEqual({ 2: id["2a"], 3: id["3a"], 4: id["4a"], 6: id["6a"], 7: id["7b"] });
    expect((await store.bestPerP(4, 4)).map((e) => e.P)).toEqual([2, 3, 4, 5, 6, 7]);
    expect((await store.bestPerP(4, 4))[0]).toEqual({
      P: 2,
      id: id["2a"],
      name: "P2",
      found_with: "hand",
      agent_note: "",
      score: 2,
      created_at: "2026-10-12T00:00:00.000Z",
      verification: "none",
    });
    // the single-problem query agrees, and so does the listing of every problem
    for (const e of await store.bestPerP(4, 4)) expect((await store.leader(4, 4, e.P))!.id).toBe(e.id);
    expect(await store.leaders()).toEqual([
      ...(await store.bestPerP(4, 4)).map(({ P, id: leaderId, name, score, verification }) => ({
        N: 4,
        M: 4,
        P,
        id: leaderId,
        name,
        score,
        verification,
      })),
      { N: 4, M: 5, P: 2, id: id["x"], name: "P2", score: 1.5, verification: "none" },
    ]);
    expect((await store.leader(4, 5, 2))!.id).toBe(id["x"]);
    expect(await store.pairs()).toEqual([
      { N: 4, M: 4 },
      { N: 4, M: 5 },
    ]);
    expect(await store.leader(4, 4, 8)).toBeNull();
    expect(await store.bestPerP(3, 3)).toEqual([]);
    // rejecting a leader hands the lead to the earliest of the remaining best
    expect(await store.remove(id["7b"])).toBe(true);
    expect((await store.leader(4, 4, 7))!.id).toBe(id["7c"]);
    expect((await leaders())[7]).toBe(id["7c"]);
    // the count is of submissions received, not of what is still listed
    expect(await store.count(4, 4, 7)).toBe(3);
  });

  it("keeps the leader alone, also when it is not first by score", async () => {
    const store = new SqliteStore(":memory:");
    // the second is within the tolerance of the first, so the first stays leader though it is larger
    const ids: number[] = [];
    for (const score of [3, 3 * (1 - SCORE_TIE / 2), 3.2, 3.1, 3.3]) ids.push(await store.insert(entry(9, score)));
    // the others go in order of score
    expect(await store.prune(4, 4, 9)).toEqual([ids[1], ids[3], ids[2], ids[4]]);
    expect((await store.leader(4, 4, 9))!.id).toBe(ids[0]);
    expect((await store.getMany(ids)).map((s) => s.id)).toEqual([ids[0]]);
    expect(await store.count(4, 4, 9)).toBe(5);
    expect(await store.prune(4, 4, 9)).toEqual([]);
  });

  it("prunes a database written before pruning existed, keeping its counts", () => {
    const path = join(mkdtempSync(join(tmpdir(), "polypack-prune-")), "old.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL, m INTEGER NOT NULL,
      p INTEGER NOT NULL, score REAL NOT NULL, name TEXT NOT NULL, agent TEXT NOT NULL, agent_note TEXT NOT NULL,
      pieces TEXT NOT NULL, container_phi REAL NOT NULL, created_at TEXT NOT NULL,
      verification TEXT NOT NULL DEFAULT 'none', literature_value REAL, strict_check TEXT)`);
    const add = old.prepare(
      `INSERT INTO submissions (n, m, p, score, name, agent, agent_note, pieces, container_phi, created_at, verification)
       VALUES (4, 4, ?, ?, 'x', 'human', '', '[]', 0, '2026-10-12', ?)`,
    );
    for (const score of [5, 4, 6, 3, 7]) add.run(2, score, "none");
    add.run(2, 1, "rejected");
    add.run(3, 9, "none");
    old.close();

    const store = new SqliteStore(path);
    return Promise.all([store.count(4, 4, 2), store.count(4, 4, 3), store.getMany([1, 2, 3, 4, 5, 6, 7])]).then(
      ([two, three, rows]) => {
        expect(two).toBe(5);
        expect(three).toBe(1);
        // the leaders remain (3, and 9 for P = 3); the rest is gone, the rejected row included
        expect(rows.map((r) => r.score).sort()).toEqual([3, 9]);
      },
    );
  });
  it("adds the found-with columns to a database created before them; old rows read back as not recorded", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "polypack-found-")), "old.sqlite");
    // the schema as deployed before found_with existed, tallies included
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL, m INTEGER NOT NULL,
      p INTEGER NOT NULL, score REAL NOT NULL, name TEXT NOT NULL, agent TEXT NOT NULL, agent_note TEXT NOT NULL,
      pieces TEXT NOT NULL, container_phi REAL NOT NULL, created_at TEXT NOT NULL,
      verification TEXT NOT NULL DEFAULT 'none', literature_value REAL, strict_check TEXT);
      CREATE TABLE tallies (n INTEGER NOT NULL, m INTEGER NOT NULL, p INTEGER NOT NULL, accepted INTEGER NOT NULL,
      PRIMARY KEY (n, m, p));
      INSERT INTO tallies VALUES (4, 4, 2, 1);`);
    old
      .prepare(
        `INSERT INTO submissions (n, m, p, score, name, agent, agent_note, pieces, container_phi, created_at)
         VALUES (4, 4, 2, 2, 'old', 'ai', 'annealing', '[]', 0, '2026-10-12')`,
      )
      .run();
    old.close();

    const columns = (db: DatabaseSync) =>
      (db.prepare("PRAGMA table_info(submissions)").all() as { name: string }[]).map((c) => c.name);
    const store = new SqliteStore(path);
    const first = await store.get(1);
    expect(first).toMatchObject({
      name: "old",
      agent_note: "annealing",
      found_with: null,
      method: null,
      method_params: null,
      seed: null,
      budget: null,
      software: null,
    });
    expect(first).not.toHaveProperty("agent");
    expect((await store.leader(4, 4, 2))!.found_with).toBeNull();
    // a new row goes into the old table, whose agent column is NOT NULL without a default
    const id = await store.insert({
      N: 4,
      M: 4,
      P: 3,
      score: 3,
      name: "new",
      agent_note: "",
      found_with: "optimizer",
      method: "asc",
      method_params: { a: 1 },
      seed: 4294967295,
      budget: { evals: 5 },
      software: null,
      pieces: [],
      container_phi: 0,
      created_at: "2026-10-13",
      verification: "none",
      literature_value: null,
      strict_check: null,
    });
    expect(await store.get(id)).toMatchObject({
      found_with: "optimizer",
      method_params: { a: 1 },
      seed: 4294967295,
      budget: { evals: 5 },
    });
    // opening it again changes nothing, and the old count is kept
    const again = new SqliteStore(path);
    expect(await again.count(4, 4, 2)).toBe(1);
    const db = new DatabaseSync(path);
    const names = columns(db);
    expect(names.filter((n) => n === "found_with")).toHaveLength(1);
    expect(names).toEqual(
      expect.arrayContaining(["agent", "found_with", "method", "method_params", "seed", "budget", "software"]),
    );
    expect(db.prepare("SELECT agent FROM submissions WHERE id = ?").get(id)).toEqual({ agent: "" });
    db.close();
  });
});

describe("problems with a proven optimum", () => {
  const rec = (P: number, status: LiteratureRecord["status"], extra: Partial<LiteratureRecord> = {}) => ({
    ...fakeRecord,
    P,
    value: 2,
    display: "2",
    display_precision: 6,
    status,
    ...extra,
  });
  // squares in a square: 2 proven with coordinates, 4 a tiling without, 5 proven but unrefereed, 3 best known
  const records: LiteratureRecord[] = [
    rec(2, "proven", { pieces: row(2), container_phi: 0 }),
    rec(4, "trivial_tiling"),
    rec(5, "proven_unrefereed", { value: 2.707107, display: "2.707107" }),
    fakeRecord,
  ];
  let store: SqliteStore;
  const withRecords = (list: LiteratureRecord[]) =>
    createApp({
      store,
      records: list,
      adminToken: "secret",
      clientIp: () => ip,
      log: (m) => logs.push(m),
      limits: { perIp: 8 },
    });

  beforeEach(() => {
    store = new SqliteStore(":memory:");
    app = withRecords(records);
  });

  it("closes proven records and tilings, and nothing else", () => {
    expect(closedToSubmissions(rec(2, "proven"))).toBe(true);
    expect(closedToSubmissions(rec(2, "trivial_tiling"))).toBe(true);
    expect(closedToSubmissions(rec(2, "proven_unrefereed"))).toBe(false);
    expect(closedToSubmissions(rec(2, "best_known"))).toBe(false);
    expect(closedToSubmissions(null)).toBe(false);
    expect(closedToSubmissions(undefined)).toBe(false);
    // the display helper keeps counting an unrefereed proof as proven
    expect(isProven("proven_unrefereed")).toBe(true);
  });

  it("refuses submissions with 409 and stores nothing", async () => {
    const events = await listen();
    for (const P of [2, 4]) {
      const r = await submit(squares(P));
      expect(r.status).toBe(409);
      expect(r.body).toEqual({
        valid: false,
        reasons: ["this problem is closed: its optimum 2 is proven (test)"],
        score: null,
        rank: null,
        leader: false,
        leader_score: null,
        id: null,
        container: null,
        pending_verification: false,
        strict_check: null,
      });
      expect((await get(`/api/leaderboard/4/4/${P}`)).body).toMatchObject({
        entries: [],
        total: 0,
        accepts_submissions: false,
      });
      const problem = (await get(`/api/problems/4/4/${P}`)).body;
      expect(problem.accepts_submissions).toBe(false);
      expect(problem.site_best).toBeNull();
      expect(problem.literature.status).toBe(P === 2 ? "proven" : "trivial_tiling");
    }
    expect(await store.count(4, 4, 2)).toBe(0);
    expect(await store.get(1)).toBeNull();
    // the packing is not examined: an overlapping one gets the same answer, not 422
    expect((await submit({ ...squares(2), pieces: row(2, 0.5) })).status).toBe(409);
    // refusals do not use up the allowance of the name (5 a minute here)
    for (let i = 0; i < 3; i++) expect((await submit(squares(2))).status).toBe(409);
    const open = await submit(squares(6));
    expect(open.status).toBe(200);
    // the only event is the one of the open problem
    await events.until(`"id":${open.body.id},`);
    expect(events.count()).toBe(1);
    await events.close();
    // the address limit is checked first and does count them (8 a minute here)
    expect((await submit(squares(2))).status).toBe(409);
    expect((await submit(squares(2))).status).toBe(429);
  });

  it("leaves unrefereed proofs, best-known values and problems without a record open", async () => {
    for (const P of [5, 3, 6]) {
      expect((await get(`/api/problems/4/4/${P}`)).body.accepts_submissions).toBe(true);
      const r = await submit(squares(P));
      expect([P, r.status]).toEqual([P, 200]);
      expect(r.body.leader).toBe(true);
      expect((await get(`/api/leaderboard/4/4/${P}`)).body).toMatchObject({
        entries: [{ id: r.body.id }],
        total: 1,
        accepts_submissions: true,
      });
    }
    expect((await get("/api/records?N=4&M=4")).body.site.map((e: { P: number }) => e.P)).toEqual([3, 5, 6]);
  });

  it("no longer lists entries that were stored before the problem was closed", async () => {
    // the same database, first without the records that close P = 2 and P = 4
    app = withRecords([fakeRecord]);
    const two = await submit(squares(2));
    const four = await submit(squares(4));
    const six = await submit(squares(6));
    // an unreviewed claim against the made-up record for P = 3, and a reviewed entry behind it
    const loose = await submit({ ...squares(3, { name: "lou" }), pieces: row(3, 4) });
    const claim = await submit(squares(3));
    expect([two, four, six, loose, claim].map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(claim.body.pending_verification).toBe(true);
    expect((await get("/api/records?N=4&M=4")).body.site.map((e: { P: number }) => e.P)).toEqual([2, 3, 4, 6]);
    expect((await get("/api/atlas?N=4&M=4")).body.tiles.map((t: { P: number }) => t.P)).toEqual([2, 3, 4, 6]);

    app = withRecords([...records.filter((r) => r.P !== 3), { ...fakeRecord, status: "proven" }]);
    for (const [P, total] of [
      [2, 1],
      [3, 2],
      [4, 1],
    ]) {
      // `total` still counts what is stored; nothing of it is shown
      expect((await get(`/api/leaderboard/4/4/${P}`)).body).toMatchObject({
        entries: [],
        total,
        accepts_submissions: false,
      });
      expect((await get(`/api/problems/4/4/${P}`)).body.site_best).toBeNull();
    }
    const listing = (await get("/api/records?N=4&M=4")).body;
    expect(listing.site.map((e: { P: number }) => e.P)).toEqual([6]);
    expect(listing.site_verified).toEqual([]);
    expect(listing.literature.map((r: { P: number }) => r.P)).toEqual([2, 3, 4, 5]);
    // the atlas draws the published packing where there is one, and no site entry of a closed problem
    const tiles = (await get("/api/atlas?N=4&M=4")).body.tiles;
    expect(tiles).toEqual([
      { P: 2, source: "literature", score: 2, pieces: row(2), container_phi: 0 },
      expect.objectContaining({ P: 6, source: "site", id: six.body.id }),
    ]);
    // the stored packings stay reachable by id, so links to them keep working
    expect((await get(`/api/submissions/${two.body.id}`)).body.pieces).toEqual(row(2));
    expect((await get(`/api/submissions/${four.body.id}`)).status).toBe(200);
  });
});

describe("submissions that beat the literature", () => {
  it("are accepted as pending, logged, strictly re-verified and reviewable", async () => {
    const r = await submit(squares(3));
    expect(r.body.valid).toBe(true);
    expect(r.body.pending_verification).toBe(true);
    expect(r.body.strict_check!.ok).toBe(true);
    expect(r.body.strict_check!.certifiedSize).toBeGreaterThan(r.body.score!);
    expect(logs[0]).toMatch(/\[review\] submission 1 .* below the published 5/);
    expect((await get("/api/leaderboard/4/4/3")).body.entries[0].verification).toBe("pending");

    expect((await get("/api/admin/pending")).status).toBe(401);
    const auth = { authorization: "Bearer secret" };
    expect((await get("/api/admin/pending", auth)).body.pending).toHaveLength(1);
    const review = await app.request("/api/admin/review", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ id: 1, decision: "rejected" }),
    });
    expect(review.status).toBe(200);
    // `total` counts submissions received, so a rejection does not lower it
    expect((await get("/api/leaderboard/4/4/3")).body.entries).toEqual([]);
    expect((await get("/api/leaderboard/4/4/3")).body.total).toBe(1);
    expect((await get("/api/submissions/1")).status).toBe(404);
  });

  it("lets the admin correct an entry's name, note and provenance, never its packing", async () => {
    const auth = { authorization: "Bearer secret", "content-type": "application/json" };
    const edit = (body: unknown, headers: Record<string, string> = auth) =>
      app.request("/api/admin/edit", { method: "POST", headers, body: JSON.stringify(body) });
    const r = await submit(squares(2, { name: "bot batch", agent: "ai", agent_note: "harden, seed 2, 20000 evals" }));
    const id = r.body.id!;
    expect((await edit({ id, name: "x" }, { "content-type": "application/json" })).status).toBe(401);
    expect((await edit({ id, method: "harden" })).status).toBe(400);
    expect((await edit({ id, found_with: "optimizer" })).status).toBe(400);
    expect((await edit({ id, found_with: "optimizer", method: "no-such-method" })).status).toBe(400);
    expect((await edit({ id, name: "   " })).status).toBe(400);
    expect((await edit({ id: id + 99, name: "x" })).status).toBe(404);

    const ok = await edit({
      id,
      name: "Bot 1",
      agent_note: "",
      found_with: "optimizer",
      method: "harden",
      seed: 2,
      budget: { evals: 20000, time_s: 15 },
    });
    expect(ok.status).toBe(200);
    const stored = (await get(`/api/submissions/${id}`)).body;
    expect(stored).toMatchObject({
      name: "Bot 1",
      agent_note: "",
      found_with: "optimizer",
      method: "harden",
      seed: 2,
      budget: { evals: 20000, time_s: 15 },
      method_params: null,
      score: r.body.score,
    });
    expect((await get("/api/leaderboard/4/4/2")).body.entries[0]).toMatchObject({
      id,
      name: "Bot 1",
      found_with: "optimizer",
    });
    // a name alone leaves the provenance as it is
    expect((await edit({ id, name: "Bot 2" })).status).toBe(200);
    expect((await get(`/api/submissions/${id}`)).body).toMatchObject({ name: "Bot 2", method: "harden" });
  });

  it("lets the admin remove an ordinary entry, which no review applies to", async () => {
    const send = (headers: Record<string, string>, body: unknown) =>
      app.request("/api/admin/remove", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const auth = { authorization: "Bearer secret" };
    const r = await submit(squares(2, { name: "test entry" }));
    expect(r.body.pending_verification).toBe(false);
    const id = r.body.id!;
    expect((await get("/api/leaderboard/4/4/2")).body.total).toBe(1);

    expect((await send({}, { id })).status).toBe(401);
    expect((await send(auth, { id: "1" })).status).toBe(400);
    expect((await send(auth, { id: id + 1 })).status).toBe(404);
    expect((await get("/api/leaderboard/4/4/2")).body.total).toBe(1);

    expect((await send(auth, { id })).status).toBe(200);
    expect((await get("/api/leaderboard/4/4/2")).body.entries).toEqual([]);
    expect((await get("/api/leaderboard/4/4/2")).body.total).toBe(1);
    expect((await get(`/api/submissions/${id}`)).status).toBe(404);
    // a removed entry is no longer listed, so there is nothing left to remove
    expect((await send(auth, { id })).status).toBe(404);
  });
});

describe("only the leader is kept", () => {
  const admin = (path: string, body: object) =>
    app.request(path, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const status = async (id: number | null) => (await get(`/api/submissions/${id}`)).status;
  const piecesOf = async (id: number | null) => (await get(`/api/submissions/${id}`)).body.pieces;
  const drawn = async (N: number, M: number, P: number) =>
    (await get(`/api/atlas?N=${N}&M=${M}&from=${P}&to=${P}`)).body.tiles.map((t: { id?: number }) => t.id);
  const leaderOf = async (N: number, M: number, P: number) =>
    (await get(`/api/leaderboard/${N}/${M}/${P}`)).body.entries[0]?.id;
  // three squares in a row, far apart: valid, and above the made-up published 5 for P = 3, so not pending
  const loose = (gap: number, name: string) => ({ ...squares(3, { name }), pieces: row(3, gap) });
  // three squares in a corner of a square of side 2: a claim that beats the row of three squares
  const corner = (name: string) => ({
    ...squares(3, { name }),
    pieces: [
      { x: 0, y: 0, theta: SQ },
      { x: 1, y: 0, theta: SQ },
      { x: 0, y: 1, theta: SQ },
    ],
  });

  it("leaves a problem that loses its only entry to its published value, in every listing", async () => {
    const published: LiteratureRecord = {
      ...fakeRecord,
      P: 2,
      value: 2,
      display: "2",
      display_precision: 6,
      status: "proven_unrefereed",
      pieces: row(2),
      container_phi: 0,
    };
    app = createApp({
      store: new SqliteStore(":memory:"),
      records: [fakeRecord, published],
      adminToken: "secret",
      clientIp: () => ip,
      log: (m) => logs.push(m),
    });
    // as good as the published value, so not pending, and drawn instead of it
    const e = (await submit(squares(2, { name: "ann" }))).body;
    expect(e).toMatchObject({ leader: true, pending_verification: false });
    expect(await drawn(4, 4, 2)).toEqual([e.id]);

    expect((await admin("/api/admin/remove", { id: e.id })).status).toBe(200);
    expect((await get("/api/leaderboard/4/4/2")).body).toMatchObject({ entries: [], total: 1 });
    const problem = (await get("/api/problems/4/4/2")).body;
    expect(problem.site_best).toBeNull();
    expect(problem.literature.value).toBe(2);
    const records = (await get("/api/records?N=4&M=4")).body;
    expect(records.site).toEqual([]);
    expect(records.site_verified).toEqual([]);
    expect(records.literature.map((r: { P: number; has_coordinates: boolean }) => [r.P, r.has_coordinates])).toEqual([
      [2, true],
      [3, false],
    ]);
    expect((await get("/api/atlas?N=4&M=4&from=2&to=2")).body.tiles).toEqual([
      { P: 2, source: "literature", score: 2, pieces: row(2), container_phi: 0 },
    ]);
    expect(await status(e.id)).toBe(404);
    // and the next entry is the leader again
    const next = (await submit(squares(2, { name: "bea" }))).body;
    expect(next).toMatchObject({ leader: true, rank: 1 });
    expect(await leaderOf(4, 4, 2)).toBe(next.id);
  });

  it("keeps the best reviewed entry behind a pending leader, which leads again when the claim is rejected", async () => {
    const a = (await submit(loose(4, "a"))).body;
    const b = (await submit(loose(4.5, "b"))).body;
    expect(b).toMatchObject({ leader: false, id: null });
    const x = (await submit(squares(3, { name: "x" }))).body;
    expect(x).toMatchObject({ leader: true, pending_verification: true });
    expect(x.id).not.toBeNull();
    expect(await leaderOf(4, 4, 3)).toBe(x.id);
    expect(await piecesOf(a.id)).toEqual(row(3, 4));
    // the claim is listed with the reviewed record beside it, and the atlas draws the reviewed one
    const records = (await get("/api/records?N=4&M=4")).body;
    expect(records.site).toEqual([expect.objectContaining({ P: 3, id: x.id, verification: "pending" })]);
    expect(records.site_verified).toEqual([expect.objectContaining({ P: 3, id: a.id })]);
    expect(await drawn(4, 4, 3)).toEqual([a.id]);
    // the reviewer sees the claim's arrangement
    const pending = (await get("/api/admin/pending", { authorization: "Bearer secret" })).body.pending;
    expect(pending.map((p: { id: number; pieces: unknown }) => [p.id, p.pieces])).toEqual([[x.id, row(3)]]);

    expect((await admin("/api/admin/review", { id: x.id, decision: "rejected" })).status).toBe(200);
    expect(await status(x.id)).toBe(404);
    expect(await leaderOf(4, 4, 3)).toBe(a.id);
    expect(await drawn(4, 4, 3)).toEqual([a.id]);
    expect((await get("/api/records?N=4&M=4")).body.site).toEqual([expect.objectContaining({ P: 3, id: a.id })]);
    expect((await get("/api/admin/pending", { authorization: "Bearer secret" })).body.pending).toEqual([]);
    // the rejected claim is gone, so it cannot be reviewed again
    expect((await admin("/api/admin/review", { id: x.id, decision: "confirmed" })).status).toBe(404);
    expect((await get("/api/leaderboard/4/4/3")).body.total).toBe(3);
  });

  it("keeps the confirmed claim alone", async () => {
    const a = (await submit(loose(4, "a"))).body;
    const x = (await submit(squares(3, { name: "x" }))).body;
    expect(await status(a.id)).toBe(200);
    expect((await admin("/api/admin/review", { id: x.id, decision: "confirmed" })).status).toBe(200);
    expect(await status(a.id)).toBe(404);
    expect(await leaderOf(4, 4, 3)).toBe(x.id);
    expect(await piecesOf(x.id)).toEqual(row(3));
    expect(await drawn(4, 4, 3)).toEqual([x.id]);
    expect((await get("/api/records?N=4&M=4")).body.site_verified).toEqual([]);
  });

  it("keeps one claim at a time, the leading one, with the reviewed entry behind it", async () => {
    const a = (await submit(loose(4, "a"))).body;
    const x1 = (await submit(squares(3, { name: "x1" }))).body;
    // a second, worse claim does not lead, so it is not kept for review
    const x2 = (await submit({ ...squares(3, { name: "x2" }), pieces: row(3, 1.05) })).body;
    expect(x2).toMatchObject({ pending_verification: true, leader: false, id: null });
    const pending = async () =>
      (await get("/api/admin/pending", { authorization: "Bearer secret" })).body.pending.map(
        (p: { id: number }) => p.id,
      );
    expect(await pending()).toEqual([x1.id]);
    // a better claim takes the lead; the one it overtook goes unreviewed, the reviewed entry stays
    const x3 = (await submit(corner("x3"))).body;
    expect(x3).toMatchObject({ pending_verification: true, leader: true });
    expect(await status(x1.id)).toBe(404);
    expect(await pending()).toEqual([x3.id]);
    expect(await piecesOf(a.id)).toEqual(row(3, 4));
    expect(await drawn(4, 4, 3)).toEqual([a.id]);
    expect((await admin("/api/admin/review", { id: x3.id, decision: "rejected" })).status).toBe(200);
    expect(await leaderOf(4, 4, 3)).toBe(a.id);
    expect(await drawn(4, 4, 3)).toEqual([a.id]);
  });

  it("follows the tie rule in what it keeps", async () => {
    // without a claim: an equal score, and a smaller one within the tolerance, do not lead and are not kept
    const L = (await submit(twoCircles(2.5, "L"))).body;
    const E = (await submit(twoCircles(2.5, "E"))).body;
    const H = (await submit(twoCircles(2.5 * (1 - 0.5 * SCORE_TIE), "H"))).body;
    expect(H.score!).toBeLessThan(L.score!);
    expect([E.id, H.id]).toEqual([null, null]);
    expect(await leaderOf(0, 0, 2)).toBe(L.id);

    // behind a claim: an entry as good as the kept one does not replace it; a better one does
    const a = (await submit(loose(4, "a"))).body;
    const x = (await submit(squares(3, { name: "x" }))).body;
    const same = (await submit(loose(4, "same"))).body;
    expect(same).toMatchObject({ score: a.score, leader: false, id: null });
    const closer = (await submit(loose(3.9, "closer"))).body;
    expect(closer.pending_verification).toBe(false);
    expect(closer.score!).toBeLessThan(a.score! * (1 - SCORE_TIE));
    expect(closer).toMatchObject({ leader: false, rank: 2 });
    expect(closer.id).not.toBeNull();
    expect(await status(a.id)).toBe(404);
    expect(await leaderOf(4, 4, 3)).toBe(x.id);
    expect(await drawn(4, 4, 3)).toEqual([closer.id]);
  });
});

describe("GET /api/atlas", () => {
  const lit = (P: number, value: number, extra: Partial<LiteratureRecord> = {}): LiteratureRecord => ({
    ...fakeRecord,
    P,
    value,
    display: String(value),
    display_precision: 6,
    ...extra,
  });
  // 2 squares with published coordinates, 3 and 5 squares with a value only, and a long run of
  // (made-up) circle records that is larger than one response may carry
  const circles = (P: number) => Array.from({ length: P }, (_, i) => ({ x: 2 * i, y: 0, theta: 0 }));
  const records: LiteratureRecord[] = [
    // an unrefereed proof, so that the problem still takes the entries submitted below
    lit(2, 2, { status: "proven_unrefereed", pieces: row(2), container_phi: 0 }),
    fakeRecord,
    lit(5, 2.707107),
    lit(6, 9, { pieces: row(6), container_phi: 0 }),
    ...Array.from({ length: 16 }, (_, i) => lit(450 + i, 900 + 2 * i, { N: 0, M: 0, pieces: circles(450 + i) })),
  ];
  const atlas = async (query: string) => {
    const r = await get(`/api/atlas?${query}`);
    return { status: r.status, body: r.body as AtlasResponse & { error?: string } };
  };

  beforeEach(() => {
    app = createApp({
      store: new SqliteStore(":memory:"),
      records,
      adminToken: "secret",
      clientIp: () => ip,
      log: (m) => logs.push(m),
    });
  });

  it("prefers a verified site entry only when it is at least as good as the published value", () => {
    const rec = lit(7, 3, { pieces: [] });
    expect(atlasSource(undefined, undefined)).toBeNull();
    expect(atlasSource(undefined, lit(7, 3))).toBeNull();
    expect(atlasSource(undefined, rec)).toBe("literature");
    expect(atlasSource({ score: 9 }, undefined)).toBe("verified");
    expect(atlasSource({ score: 2.9 }, rec)).toBe("verified");
    expect(atlasSource({ score: 3.0000000000000004 }, { ...rec, display_precision: 14 })).toBe("verified");
    expect(atlasSource({ score: 3.0000005 }, rec)).toBe("verified"); // within the 6 printed decimals
    expect(atlasSource({ score: 3.00001 }, rec)).toBe("literature");
    expect(atlasSource({ score: 3.00001 }, lit(7, 3))).toBe("verified"); // nothing else to draw
  });

  it("draws a pending entry only when nothing else can be drawn", () => {
    const pending = { score: 2.5 };
    expect(atlasSource(undefined, lit(7, 3), pending)).toBe("pending");
    expect(atlasSource(undefined, undefined, pending)).toBe("pending");
    // published coordinates and verified entries always come first, however good the claim
    expect(atlasSource(undefined, lit(7, 3, { pieces: [] }), pending)).toBe("literature");
    expect(atlasSource({ score: 3 }, lit(7, 3), pending)).toBe("verified");
    expect(atlasSource({ score: 3.4 }, lit(7, 3), pending)).toBe("verified");
    expect(atlasSource({ score: 3.4 }, lit(7, 3, { pieces: [] }), pending)).toBe("literature");
  });

  it("returns the single best drawable packing per P", async () => {
    // only published coordinates so far
    let a = await atlas("N=4&M=4&from=1&to=10");
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ N: 4, M: 4, from: 1, to: 10, next: null });
    expect(a.body.tiles).toEqual([
      { P: 2, source: "literature", score: 2, pieces: row(2), container_phi: 0 },
      { P: 6, source: "literature", score: 9, pieces: row(6), container_phi: 0 },
    ]);

    // a worse site entry does not replace published coordinates, a matching one does
    await submit({ ...squares(2), pieces: row(2, 1.5) });
    expect((await atlas("N=4&M=4&from=2&to=2")).body.tiles[0].source).toBe("literature");
    const match = await submit(squares(2, { name: "bea" }));
    a = await atlas("N=4&M=4&from=2&to=2");
    expect(a.body.tiles).toEqual([
      {
        P: 2,
        source: "site",
        score: match.body.score,
        pieces: row(2),
        container_phi: match.body.container!.phi,
        id: match.body.id,
        verification: "none",
        found_with: "hand",
      },
    ]);

    // no published value (P = 4), and a published value without coordinates that the entry does not reach (P = 5)
    await submit(squares(4, { name: "cy" }));
    await submit(squares(5, { name: "di" }));
    a = await atlas("N=4&M=4");
    expect(a.body.tiles.map((t) => [t.P, t.source])).toEqual([
      [2, "site"],
      [4, "site"],
      [5, "site"],
      [6, "literature"],
    ]);
    expect(a.body.tiles[2].score).toBeGreaterThan(2.71); // auto-oriented row of five, still above the published value
    expect(a.body.tiles.every((t) => t.pieces.length === t.P)).toBe(true);
    // other shapes are not mixed in
    expect((await atlas("N=4&M=3")).body.tiles).toEqual([]);
  });

  const review = (id: number | null, decision: "confirmed" | "rejected") =>
    app.request("/api/admin/review", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ id, decision }),
    });

  it("marks pending entries and never shows rejected ones", async () => {
    const r = await submit(squares(3));
    expect(r.body.pending_verification).toBe(true);
    let a = await atlas("N=4&M=4&from=3&to=3");
    expect(a.body.tiles[0]).toMatchObject({ P: 3, source: "site", id: r.body.id, verification: "pending" });
    expect((await review(r.body.id, "rejected")).status).toBe(200);
    a = await atlas("N=4&M=4&from=3&to=3");
    expect(a.body.tiles).toEqual([]);
    expect(JSON.stringify((await atlas("N=4&M=4")).body)).not.toContain(`"id":${r.body.id}`);
  });

  it("never lets a pending entry stand in for a verified one", async () => {
    // three squares far apart: a valid entry well above the made-up published value of 5, so not pending
    const loose = await submit({ ...squares(3, { name: "lou" }), pieces: row(3, 4) });
    expect(loose.body.pending_verification).toBe(false);
    expect(loose.body.score).toBeGreaterThan(5);
    const claim = await submit(squares(3, { name: "pat" }));
    expect(claim.body.pending_verification).toBe(true);

    // the listing shows the claim as the site's best entry and the reviewed one beside it
    let records = (await get("/api/records?N=4&M=4")).body;
    expect(records.site.find((e: { P: number }) => e.P === 3)).toMatchObject({
      id: claim.body.id,
      verification: "pending",
    });
    expect(records.site_verified).toEqual([expect.objectContaining({ P: 3, id: loose.body.id, verification: "none" })]);
    // the atlas draws the reviewed entry, although the claim is smaller
    let a = await atlas("N=4&M=4&from=3&to=3");
    expect(a.body.tiles).toEqual([
      expect.objectContaining({ P: 3, source: "site", id: loose.body.id, verification: "none" }),
    ]);

    // a claim against a published value with coordinates is not drawn either (the record for P = 6 is made up)
    const six = await submit(squares(6, { name: "pat" }));
    expect(six.body.pending_verification).toBe(true);
    a = await atlas("N=4&M=4&from=6&to=6");
    expect(a.body.tiles).toEqual([expect.objectContaining({ P: 6, source: "literature", score: 9 })]);
    records = (await get("/api/records?N=4&M=4")).body;
    expect(records.site_verified.map((e: { P: number }) => e.P)).toEqual([3]);

    // once confirmed, the claim is a verified entry like any other
    expect((await review(claim.body.id, "confirmed")).status).toBe(200);
    a = await atlas("N=4&M=4&from=3&to=3");
    expect(a.body.tiles).toEqual([
      expect.objectContaining({ P: 3, source: "site", id: claim.body.id, verification: "confirmed" }),
    ]);
    records = (await get("/api/records?N=4&M=4")).body;
    expect(records.site_verified.map((e: { P: number }) => e.P)).toEqual([]);
    // without anything pending the field is still there, and empty
    expect((await get("/api/records?N=4&M=3")).body.site_verified).toEqual([]);
  });

  it("keeps the records listing current although answers are cached", async () => {
    const admin = (path: string, body: object) =>
      app.request(path, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const listed = async () =>
      (await get("/api/records?N=4&M=4")).body.site.map((e: { P: number; name: string }) => `${e.P}:${e.name}`);
    expect(await listed()).toEqual([]);
    const loose = await submit({ ...squares(2, { name: "ann" }), pieces: row(2, 3) });
    expect(await listed()).toEqual(["2:ann"]);
    // another pair's listing is not touched by an entry of this one, nor the other way round
    expect((await get("/api/records?N=4&M=3")).body.site).toEqual([]);
    const tight = await submit(squares(2, { name: "bob" }));
    expect(await listed()).toEqual(["2:bob"]);
    expect((await admin("/api/admin/edit", { id: tight.body.id, name: "Bob", found_with: "hand" })).status).toBe(200);
    expect(await listed()).toEqual(["2:Bob"]);
    // ann's entry was deleted when bob's overtook it, so after the removal nothing is listed
    expect((await admin("/api/admin/remove", { id: tight.body.id })).status).toBe(200);
    expect(await listed()).toEqual([]);
    expect((await get(`/api/submissions/${loose.body.id}`)).status).toBe(404);
  });

  it("bounds the range and the payload", async () => {
    for (const bad of [
      "M=4",
      "N=4&M=2",
      "N=4&M=4&from=0",
      "N=4&M=4&from=5&to=4",
      "N=4&M=4&from=1.5&to=3",
      "N=4&M=4&from=x",
      "N=4&M=4&to=501",
      `N=4&M=4&from=1&to=${ATLAS_MAX_SPAN + 1}`,
      // empty values are not circles, and only plain decimal integers are numbers here
      "N=&M=",
      "N=4&M=",
      "N=&M=4",
      "N=4&M=4&from=",
      "N=4&M=4&to=",
      "N=4&M=4&from=0x10",
      "N=4&M=4&from=1e2",
      "N=4&M=4&to=1e1",
      "N=4.0&M=4",
      "N=+4&M=4",
      "N=4&M=4&from=-1",
      "N=4&M=4&from=%201",
    ]) {
      const r = await atlas(bad);
      expect([bad, r.status]).toEqual([bad, 400]);
      expect(r.body.error).toBeTruthy();
    }
    expect((await atlas(`N=4&M=4&from=401&to=${400 + ATLAS_MAX_SPAN}`)).status).toBe(200);
    // the default range ends at the largest P
    expect((await atlas("N=0&M=0&from=450")).body.to).toBe(500);

    // sixteen drawings of 450 to 465 circles: more than one answer may carry
    const count = (t: AtlasResponse) => t.tiles.reduce((n, tile) => n + tile.pieces.length, 0);
    const seen: number[] = [];
    let from: number | null = 440;
    let answers = 0;
    while (from !== null) {
      const part: { body: AtlasResponse } = await atlas(`N=0&M=0&from=${from}&to=470`);
      answers++;
      expect(part.body.tiles.length).toBeGreaterThan(0);
      expect(count(part.body)).toBeLessThanOrEqual(ATLAS_MAX_PIECES);
      // an answer is cut only when the next drawing would not fit
      if (part.body.next !== null) {
        expect(part.body.next).toBe(part.body.tiles[part.body.tiles.length - 1].P + 1);
        expect(count(part.body) + part.body.next).toBeGreaterThan(ATLAS_MAX_PIECES);
      }
      seen.push(...part.body.tiles.map((t) => t.P));
      from = part.body.next;
    }
    expect(answers).toBeGreaterThan(1);
    expect(seen).toEqual(Array.from({ length: 16 }, (_, i) => 450 + i));
  });

  it("caps the ids of one store lookup", async () => {
    const store = new SqliteStore(":memory:");
    expect(await store.getMany([])).toEqual([]);
    expect(await store.getMany(Array.from({ length: GET_MANY_LIMIT }, (_, i) => i + 1))).toEqual([]);
    await expect(store.getMany(Array.from({ length: GET_MANY_LIMIT + 1 }, (_, i) => i + 1))).rejects.toThrow(
      RangeError,
    );
  });

  it("compresses the coordinates for clients that accept it", async () => {
    const plain = await app.request("/api/atlas?N=0&M=0&from=450&to=455");
    expect(plain.headers.get("content-encoding")).toBeNull();
    const text = await plain.text();
    const packed = await app.request("/api/atlas?N=0&M=0&from=450&to=455", { headers: { "accept-encoding": "gzip" } });
    expect(packed.headers.get("content-encoding")).toBe("gzip");
    const bytes = new Uint8Array(await packed.arrayBuffer());
    expect(bytes.length).toBeLessThan(text.length / 3);
    const unpacked = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    expect(unpacked).toBe(text);
  });

  it("is documented", async () => {
    const html = await (await app.request("/api")).text();
    expect(html).toContain("GET /api/atlas?N=&amp;M=&amp;from=&amp;to=");
    expect(html).toContain(`at most ${ATLAS_MAX_SPAN} values`);
  });
});

describe("GET /api/holders", () => {
  const rec = (
    P: number,
    value: number,
    display_precision: number,
    status: LiteratureRecord["status"] = "best_known",
  ) => ({
    ...fakeRecord,
    P,
    value,
    display: value.toFixed(display_precision),
    display_precision,
    status,
  });
  const entry = (
    M: number,
    P: number,
    score: number,
    name: string,
    verification: NewSubmission["verification"] = "none",
  ): NewSubmission => ({
    N: 4,
    M,
    P,
    score,
    name,
    agent_note: "",
    found_with: "hand",
    method: null,
    method_params: null,
    seed: null,
    budget: null,
    software: null,
    pieces: [],
    container_phi: 0,
    created_at: "2026-10-21T00:00:00.000Z",
    verification,
    literature_value: null,
    strict_check: null,
  });
  const holders = async () => (await get("/api/holders")).body.holders;

  it("counts the leader of every open problem by its exact name", async () => {
    const store = new SqliteStore(":memory:");
    // squares in a square: 2 proven, 3 published as 5.00, 4 as 3.5, 6 as 4, 7 as 5.00
    const records = [rec(2, 2, 6, "proven"), fakeRecord, rec(4, 3.5, 6), rec(6, 4, 6), rec(7, 5, 2)];
    for (const e of [
      // no published value: the lead is the record
      entry(4, 1, 1, "ann"),
      // a closed problem is left out
      entry(4, 2, 2, "ann"),
      // reaches 3.5 to the six printed decimals
      entry(4, 4, 3.5000000001, "ann"),
      // below 5.00 by more than its precision, and confirmed
      entry(4, 3, 4.9, "bob", "confirmed"),
      entry(4, 5, 6, "bob"),
      // worse than the published 4: a site best, not a record
      entry(4, 6, 4.5, "cat"),
      // a claim awaiting review, with the reviewed entry kept behind it, which leads nothing
      entry(4, 7, 5.5, "eve"),
      entry(4, 7, 4, "dan", "pending"),
      // another case is another name
      entry(3, 1, 1, "Ann"),
      // equal scores: the earlier entry leads
      entry(5, 1, 1, "fay"),
      entry(5, 1, 1, "gus"),
    ])
      await store.insert(e);
    app = createApp({ store, records, adminToken: "secret", clientIp: () => ip, log: (m) => logs.push(m) });
    const row = (name: string, records: number, beat_published: number, site_bests: number, pending = 0) => ({
      name,
      records,
      beat_published,
      site_bests,
      pending,
    });
    // most records first, then most site bests, then by name, capitals first
    expect(await holders()).toEqual([
      row("ann", 2, 0, 2),
      row("bob", 2, 1, 2),
      row("Ann", 1, 0, 1),
      row("fay", 1, 0, 1),
      row("cat", 0, 0, 1),
      row("dan", 0, 0, 1, 1),
    ]);
  });

  it("is counted again at most once every 15 minutes while entries keep changing", async () => {
    expect(HOLDERS_REFRESH_MS).toBe(15 * 60_000);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.parse("2026-10-21T12:00:00Z"));
      expect(await holders()).toEqual([]);
      await submit(squares(2, { name: "ann" }));
      vi.setSystemTime(Date.now() + HOLDERS_REFRESH_MS - 1);
      expect(await holders()).toEqual([]);
      vi.setSystemTime(Date.now() + 1);
      expect((await holders()).map((h: { name: string }) => h.name)).toEqual(["ann"]);
      // without a change the answer stands however old it is, and the first change after the
      // interval shows at once
      vi.setSystemTime(Date.now() + 10 * HOLDERS_REFRESH_MS);
      await submit(squares(4, { name: "bob" }));
      expect((await holders()).map((h: { name: string }) => h.name)).toEqual(["ann", "bob"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows every change although answers are kept", async () => {
    // counted again after every change
    app = createApp({
      store: new SqliteStore(":memory:"),
      records: [fakeRecord],
      adminToken: "secret",
      clientIp: () => ip,
      log: (m) => logs.push(m),
      holdersRefreshMs: 0,
    });
    const admin = (path: string, body: object) =>
      app.request(path, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const names = async () =>
      (await holders()).map((h: { name: string; site_bests: number }) => `${h.name}:${h.site_bests}`);
    expect(await holders()).toEqual([]);
    const two = await submit(squares(2, { name: "ann" }));
    await submit(squares(4, { name: "ann" }));
    expect(await names()).toEqual(["ann:2"]);
    // a lead taken in another pair of shapes
    await submit({ ...squares(2, { name: "bob" }), M: 5 });
    expect(await names()).toEqual(["ann:2", "bob:1"]);
    // a pending claim (three squares against the made-up 5.00) is a site best, not yet a record
    const claim = await submit(squares(3, { name: "bob" }));
    expect(claim.body.pending_verification).toBe(true);
    expect((await holders())[1]).toEqual({ name: "bob", records: 1, beat_published: 0, site_bests: 2, pending: 1 });
    expect((await admin("/api/admin/review", { id: claim.body.id, decision: "confirmed" })).status).toBe(200);
    // level with ann now, and after her by name
    expect((await holders())[1]).toEqual({ name: "bob", records: 2, beat_published: 1, site_bests: 2, pending: 0 });
    expect((await admin("/api/admin/edit", { id: two.body.id, name: "Ann" })).status).toBe(200);
    expect(await names()).toEqual(["bob:2", "Ann:1", "ann:1"]);
    expect((await admin("/api/admin/remove", { id: two.body.id })).status).toBe(200);
    expect(await names()).toEqual(["bob:2", "ann:1"]);
  });

  it("is documented", async () => {
    expect(await (await app.request("/api")).text()).toContain("GET /api/holders");
  });
});

describe("the API page", () => {
  it("documents the snapshot and invites volunteers, with a link to their page", async () => {
    const page = await (await createApp({ store: new SqliteStore(":memory:"), records: [] }).request("/api")).text();
    expect(page).toContain('<h3 id="snapshot"><code>GET /api/snapshot</code></h3>');
    expect(page).toContain('<a href="/volunteer.html">volunteer client</a>');
    expect(page).toContain('<a href="/volunteer.html">Volunteer</a>');
  });
});

describe("GET /api/targets", () => {
  // squares in a square: 2 closed, 3 published as 5.00 without coordinates, 5 published as
  // 2.707107 with coordinates (all made up)
  const records: LiteratureRecord[] = [
    { ...fakeRecord, P: 2, value: 2, display: "2", display_precision: 6, status: "proven" },
    fakeRecord,
    { ...fakeRecord, P: 5, value: 2.707107, display: "2.707107", display_precision: 6, pieces: row(5) },
  ];
  let store: SqliteStore;
  const make = (extra: { holdersRefreshMs?: number; targetsRefreshMs?: number } = {}) => {
    store = new SqliteStore(":memory:");
    app = createApp({ store, records, adminToken: "secret", clientIp: () => ip, log: (m) => logs.push(m), ...extra });
  };
  const targets = async (query = "") => {
    const r = await get(`/api/targets${query}`);
    return { status: r.status, body: r.body as TargetsResponse & { error?: string } };
  };
  const squaresOnly = "?N=4&M=4&max_P=6";
  beforeEach(() => make());

  it("ranks the open problems with what is known of each", async () => {
    const four = (await submit(squares(4, { name: "ann" }))).body;
    const five = (await submit(squares(5, { name: "bob" }))).body;
    const { status, body } = await targets(squaresOnly);
    expect(status).toBe(200);
    expect(Date.parse(body.generated_at)).not.toBeNaN();
    // the closed problem is left out; the empty ones come first, then the published value without
    // a leader, then the leader behind a drawn packing, then the tooth at P = 4
    expect(body.targets.map((t) => [t.P, t.reason])).toEqual([
      [1, "unsolved"],
      [6, "unsolved"],
      [3, "behind_published"],
      [5, "behind_published"],
      [4, "tooth"],
    ]);
    const at = (P: number) => body.targets.find((t) => t.P === P)!;
    expect(at(1)).toEqual({
      N: 4,
      M: 4,
      P: 1,
      reason: "unsolved",
      priority: TARGET_WEIGHTS.unsolved,
      leader: null,
      leader_id: null,
      published: null,
      published_coordinates: false,
      area_bound: areaLowerBound(4, 4, 1),
    });
    expect(at(3)).toMatchObject({ leader: null, published: 5, published_coordinates: false });
    expect(at(3).priority).toBe(TARGET_WEIGHTS.missingLeaderGap);
    expect(at(5)).toMatchObject({ leader: five.score, leader_id: five.id, published: 2.707107 });
    expect(at(5).published_coordinates).toBe(true);
    expect(at(5).priority).toBeCloseTo((TARGET_WEIGHTS.drawnPublished * (five.score! - 2.707107)) / five.score!, 15);
    expect(at(4)).toMatchObject({ leader: four.score, leader_id: four.id, published: null });
    expect(at(4).area_bound).toBeCloseTo(2, 12);
    // the answer is the shared ranking itself
    const ranking = rankTargets(
      [four, five].map((s, i) => ({ N: 4, M: 4, P: 4 + i, id: s.id!, score: s.score! })),
      records,
    );
    expect(body.targets).toEqual(ranking.select({ N: [4], M: [4], maxP: 6 }));
  });

  it("filters the ranking and caps the answer", async () => {
    // nothing stored: the core box minus the closed problem, all unsolved, by P, N, M
    let r = await targets();
    expect(r.body.targets).toHaveLength(TARGETS_DEFAULT_LIMIT);
    expect(r.body.targets.slice(0, 3).map((t) => `${t.N}/${t.M}/${t.P}`)).toEqual(["0/0/1", "0/3/1", "0/4/1"]);
    expect((await targets(`?limit=${TARGETS_MAX_LIMIT}`)).body.targets).toHaveLength(TARGETS_MAX_LIMIT);
    r = await targets("?N=0,3-5&M=12&max_P=2&limit=100");
    expect(r.body.targets.map((t) => `${t.N}/${t.M}/${t.P}`)).toEqual([
      "0/12/1",
      "3/12/1",
      "4/12/1",
      "5/12/1",
      "0/12/2",
      "3/12/2",
      "4/12/2",
      "5/12/2",
    ]);
    // a range skips 1 and 2; repeated shapes count once
    expect((await targets("?N=0-3,3&M=0&max_P=1")).body.targets.map((t) => t.N)).toEqual([0, 3]);
    // shapes outside the core box have nothing unsolved
    expect((await targets("?N=13-100")).body.targets).toEqual([]);
    expect((await targets("?N=4&M=4&max_P=2")).body.targets.map((t) => t.P)).toEqual([1]);
  });

  it("parses its query strictly", async () => {
    for (const bad of [
      "limit=0",
      `limit=${TARGETS_MAX_LIMIT + 1}`,
      "limit=",
      "limit=1e2",
      "limit=-1",
      "limit=5.0",
      "limit=0x10",
      "max_P=0",
      "max_P=501",
      "max_P=",
      "max_P=+3",
      "N=",
      "N=2",
      "N=1-4",
      "N=4-101",
      "N=6-3",
      "N=3-",
      "N=3,,4",
      "N=3,",
      "N=%203",
      "N=0x3",
      "N=3.0",
      "M=101",
      "M=a",
      "M=1000",
      // a repeated parameter, even with the same value, and misspelt or unknown ones
      "N=3&N=x",
      "N=3&N=3",
      "limit=5&limit=0",
      "n=3",
      "max_p=1",
      "maxP=1",
      "limit=5&page=2",
    ]) {
      const r = await targets(`?${bad}`);
      expect([bad, r.status]).toEqual([bad, 400]);
      expect(r.body.error).toBeTruthy();
    }
    // several errors are named together
    expect((await targets("?limit=0&M=2")).body.error).toMatch(/limit.*; M must be/);
    for (const good of ["limit=1", "limit=2000", "max_P=1", "max_P=500", "N=0", "N=100", "N=0-100", "M=007"])
      expect([good, (await targets(`?${good}`)).status]).toEqual([good, 200]);
  });

  it("shares one reading of the leaders with /api/holders and ranks again at most every TARGETS_REFRESH_MS", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const reads = vi.spyOn(store, "leaders");
      const start = Date.parse("2026-10-21T12:00:00Z");
      vi.setSystemTime(start);
      const leaderOf = async (P: number) => (await targets(`?N=4&M=4&max_P=6`)).body.targets.find((t) => t.P === P);
      expect((await get("/api/holders")).body.holders).toEqual([]);
      expect(await leaderOf(4)).toMatchObject({ reason: "unsolved", leader: null });
      expect(reads).toHaveBeenCalledTimes(1);
      expect((await targets()).body.generated_at).toBe(new Date(start).toISOString());

      const four = (await submit(squares(4, { name: "ann" }))).body;
      vi.setSystemTime(start + HOLDERS_REFRESH_MS - 1);
      expect((await get("/api/holders")).body.holders).toEqual([]);
      expect((await leaderOf(4))!.leader).toBeNull();
      expect(reads).toHaveBeenCalledTimes(1);
      // HOLDERS_REFRESH_MS on, the holders are counted again, but the ranking is kept for longer
      vi.setSystemTime(start + HOLDERS_REFRESH_MS);
      expect((await get("/api/holders")).body.holders.map((h: { name: string }) => h.name)).toEqual(["ann"]);
      expect(reads).toHaveBeenCalledTimes(2);
      vi.setSystemTime(start + TARGETS_REFRESH_MS - 1);
      expect((await leaderOf(4))!.leader).toBeNull();
      // then it is ranked again from the reading the holders took, which nothing has changed since
      vi.setSystemTime(start + TARGETS_REFRESH_MS);
      expect(await leaderOf(4)).toMatchObject({ leader: four.score, leader_id: four.id });
      expect(reads).toHaveBeenCalledTimes(2);
      expect((await targets()).body.generated_at).toBe(new Date(start + TARGETS_REFRESH_MS).toISOString());
      // without a change the ranking stands however old it is, and the first change after
      // TARGETS_REFRESH_MS shows at once
      vi.setSystemTime(start + 5 * TARGETS_REFRESH_MS);
      expect((await leaderOf(4))!.leader_id).toBe(four.id);
      expect(reads).toHaveBeenCalledTimes(2);
      const six = (await submit(squares(6, { name: "bob" }))).body;
      expect((await leaderOf(6))!.leader_id).toBe(six.id);
      expect(reads).toHaveBeenCalledTimes(3);
      // and the holders use that reading
      expect((await get("/api/holders")).body.holders.map((h: { name: string }) => h.name)).toEqual(["ann", "bob"]);
      expect(reads).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows every change when both waits are zero", async () => {
    make({ holdersRefreshMs: 0, targetsRefreshMs: 0 });
    const admin = (path: string, body: object) =>
      app.request(path, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const reasonOf = async (P: number) =>
      (await targets(squaresOnly)).body.targets.find((t) => t.P === P)?.reason ?? "absent";
    expect(await reasonOf(3)).toBe("behind_published");
    // a claim below the published 5.00 awaits review, and leads meanwhile
    const claim = (await submit(squares(3, { name: "cy" }))).body;
    expect(claim.pending_verification).toBe(true);
    let three = (await targets(squaresOnly)).body.targets.find((t) => t.P === 3)!;
    expect(three).toMatchObject({ reason: "slack", leader: claim.score, leader_id: claim.id });
    expect((await admin("/api/admin/review", { id: claim.id, decision: "rejected" })).status).toBe(200);
    three = (await targets(squaresOnly)).body.targets.find((t) => t.P === 3)!;
    expect(three).toMatchObject({ reason: "behind_published", leader: null });
    const four = (await submit(squares(4, { name: "ann" }))).body;
    expect(await reasonOf(4)).toBe("tooth");
    expect((await admin("/api/admin/remove", { id: four.id })).status).toBe(200);
    expect(await reasonOf(4)).toBe("unsolved");
  });

  it("compresses the answer for clients that accept it", async () => {
    const r = await app.request("/api/targets?limit=2000", { headers: { "accept-encoding": "gzip" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-encoding")).toBe("gzip");
  });

  it("is documented", async () => {
    const html = await (await app.request("/api")).text();
    expect(html).toContain("GET /api/targets");
    for (const weight of Object.values(TARGET_WEIGHTS)) expect(html).toContain(String(weight));
  });
});

// The corpus holds saved configurations with their score at their own container_phi and after an
// orientation search. Client and server share one scoring routine; this guards the shared routine
// against drift and checks that the HTTP path returns exactly what the client computes.
describe("client and server agree on the corpus", () => {
  const dir = resolve(import.meta.dirname, "../../../data/corpus");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    it(file, async () => {
      const saved = JSON.parse(readFileSync(resolve(dir, file), "utf8"));
      ip = file;
      // sent as saved: scored at its own phi
      const asSaved = await submit({ ...saved.config, name: file });
      expect(asSaved.body.score).toBe(evaluate(saved.config).score);
      expect(asSaved.body.score).toBeCloseTo(saved.expected_score, 9);
      // turned first, as every client does: exactly the client's score
      const client = evaluate(saved.config, { autoOrient: true });
      expect(client.valid).toBe(true);
      expect(client.score).toBeCloseTo(saved.oriented_score, 9);
      const turned = await submit({ ...saved.config, container_phi: client.container!.phi, name: file });
      expect(turned.body.score).toBe(client.score);
    });
  }
});
