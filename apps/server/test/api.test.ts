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
  closedToSubmissions,
  evaluate,
  improvesOn,
  isProven,
} from "@polypack/geometry";
import { registry } from "@polypack/solver";
import { beforeEach, describe, expect, it } from "vitest";
import { ATLAS_MAX_PIECES, ATLAS_MAX_SPAN, atlasSource, createApp } from "../src/app";
import { SOLVER_METHODS } from "../src/docs";
import { SqliteStore } from "../src/sqlite-store";
import { GET_MANY_LIMIT, NewSubmission } from "../src/store";

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
    body: typeof body === "string" ? body : JSON.stringify(body),
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

  it("scores at the better of the submitted phi and the auto-oriented phi", async () => {
    const r = await submit(squares(2, { container_phi: 0.3 }));
    expect(r.body.score).toBeCloseTo(2, 9);
    expect(evaluate(squares(2, { container_phi: 0.3 })).score!).toBeGreaterThan(2.1);
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
      squares(2, { name: "  <b>Bob</b>\u0000\n  the   builder ", agent: "ai", agent_note: "<script>x</script>" }),
    );
    const e = (await get("/api/leaderboard/4/4/2")).body.entries[0];
    expect(e.name).toBe("b Bob /b the builder");
    expect(e.agent).toBe("ai");
    expect(e.agent_note).not.toMatch(/[<>]/);
  });

  it("rate-limits by address, not by name", async () => {
    for (let i = 0; i < 8; i++) expect((await submit(squares(2))).status).toBe(200);
    expect((await submit(squares(2, { name: "fresh" }))).status).toBe(429);
    ip = "2.2.2.2";
    expect((await submit(squares(2))).status).toBe(200);
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
    ]) {
      expect(html).toContain(part);
    }
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

/** Two unit circles with centres `d` apart in a circle: the score is 1 + d / 2. */
const twoCircles = (score: number, name: string) => ({
  N: 0,
  M: 0,
  P: 2,
  pieces: [
    { x: 0, y: 0, theta: 0 },
    { x: 2 * (score - 1), y: 0, theta: 0 },
  ],
  container_phi: 0,
  name,
});

describe("leaderboard", () => {
  it("keeps the best three entries, shows only the best one and counts every submission", async () => {
    expect(LEADERBOARD_SIZE).toBe(1);
    const gaps = [1.5, 1.2, 1.0, 1.3, 1.1];
    const answers: SubmitResponse[] = [];
    for (const [i, gap] of gaps.entries()) {
      answers.push((await submit({ ...squares(2, { name: `p${i}` }), pieces: row(2, gap) })).body);
    }
    expect(answers.map((a) => a.rank)).toEqual([1, 1, 1, 3, 2]);
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
    // the runners-up stay loadable by id; the gaps 1.5 and then 1.3 were deleted when overtaken
    expect(answers.map((a) => a.id)).toEqual([1, 2, 3, 4, 5]);
    for (const [i, gap] of [
      [1, 1.2],
      [4, 1.1],
    ] as const)
      expect((await get(`/api/submissions/${answers[i].id}`)).body.pieces).toEqual(row(2, gap));
    for (const i of [0, 3]) expect((await get(`/api/submissions/${answers[i].id}`)).status).toBe(404);
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

    // a worse score
    const worse = (await submit(twoCircles(2.6, "worse"))).body;
    expect(worse).toMatchObject({ valid: true, rank: 4, leader: false, leader_score: first.score });

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

    // when the leader is taken off the site, the earliest of the remaining best entries leads
    const removed = await app.request("/api/admin/remove", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ id: better.id }),
    });
    expect(removed.status).toBe(200);
    expect(await leaderOf()).toEqual([again.id]);
  });

  it("announces the entry that leads, also when a later submission made it the leader", async () => {
    // Three scores, each within the tolerance of the next but the last not of the first: the
    // third does not lead (the second is as good and earlier), yet it ends the first one's lead.
    const events = await listen();
    const a = (await submit(twoCircles(2.5, "a"))).body;
    const b = (await submit(twoCircles(2.5 * (1 - 0.6 * SCORE_TIE), "b"))).body;
    expect(b.leader).toBe(false);
    const c = (await submit(twoCircles(2.5 * (1 - 1.2 * SCORE_TIE), "c"))).body;
    expect(c).toMatchObject({ valid: true, rank: 2, leader: false, leader_score: b.score });
    expect((await get("/api/leaderboard/0/0/2")).body.entries[0].id).toBe(b.id);
    await events.until(`"id":${a.id},`);
    await events.until(`"id":${b.id},`);
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
    agent: "human",
    agent_note: "",
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
      agent: "human",
      agent_note: "",
      score: 2,
      created_at: "2026-10-12T00:00:00.000Z",
      verification: "none",
    });
    // the single-problem query agrees
    for (const e of await store.bestPerP(4, 4)) expect((await store.leader(4, 4, e.P))!.id).toBe(e.id);
    expect((await store.leader(4, 5, 2))!.id).toBe(id["x"]);
    expect(await store.leader(4, 4, 8)).toBeNull();
    expect(await store.bestPerP(3, 3)).toEqual([]);
    // rejecting a leader hands the lead to the earliest of the remaining best
    expect(await store.remove(id["7b"])).toBe(true);
    expect((await store.leader(4, 4, 7))!.id).toBe(id["7c"]);
    expect((await leaders())[7]).toBe(id["7c"]);
    // the count is of submissions received, not of what is still listed
    expect(await store.count(4, 4, 7)).toBe(3);
  });

  it("keeps the leader and the next two, also when the leader is not first by score", async () => {
    const store = new SqliteStore(":memory:");
    // the second is within the tolerance of the first, so the first stays leader though it is larger
    const ids: number[] = [];
    for (const score of [3, 3 * (1 - SCORE_TIE / 2), 3.2, 3.1, 3.3]) ids.push(await store.insert(entry(9, score)));
    expect(await store.prune(4, 4, 9)).toEqual([ids[2], ids[4]]);
    expect((await store.leader(4, 4, 9))!.id).toBe(ids[0]);
    expect((await store.getMany(ids)).map((s) => s.id).sort()).toEqual([ids[0], ids[1], ids[3]].sort());
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
        // scores 3, 4 and 5 remain; 6 and 7 are gone; the rejected row is not listed either way
        expect(rows.map((r) => r.score).sort()).toEqual([3, 4, 5, 9]);
      },
    );
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

// The corpus holds saved configurations with the score recorded when they were saved.
// Client and server share one scoring routine; this guards the shared routine against drift
// and checks that the HTTP path returns exactly what the client computes.
describe("client and server agree on the corpus", () => {
  const dir = resolve(import.meta.dirname, "../../../data/corpus");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    it(file, async () => {
      const saved = JSON.parse(readFileSync(resolve(dir, file), "utf8"));
      const client = evaluate(saved.config, { autoOrient: true });
      expect(client.valid).toBe(true);
      expect(client.score).toBeCloseTo(saved.expected_score, 9);
      ip = file;
      const server = await submit({ ...saved.config, name: file });
      expect(server.body.score).toBe(client.score);
    });
  }
});
