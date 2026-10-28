import { describe, expect, it } from "vitest";
import type { PackingConfig } from "@polypack/geometry";
import { planarFactors, spacePlan } from "../../server/src/units-migration";
import { GameState, ProblemState, addToQueue, newGame, newProblem } from "../src/tighter/game";
import type { ProblemKey } from "../src/tighter/frontier";
import { SAVE_VERSION, readSave, toJson } from "../src/tighter/save";
import { DROPPED, unitPlan } from "../src/tighter/units";

// The unit change of 2026-10-27: disk and ball pieces have diameter 1 (they had radius 1), and a circle
// or ball container is scored by its diameter (it was by its radius). A save of version 5 is converted
// once as it is read; one of version 6 is not.

const T0 = 1_700_000_000_000;
const RUN = { method: "mc_compress", params: {}, seed: 7, budget: { evals: 100 } };

/** A board of the 2D game: made-up poses (a save does not judge its boards). */
const flat = (N: number, M: number, P: number): PackingConfig => ({
  N,
  M,
  P,
  pieces: Array.from({ length: P }, (_, i) => ({ x: 1.25 * i + 0.1, y: -0.75 * i + 0.3, theta: 0.1 * i })),
  container_phi: 0.2,
});

/** A problem played to a record: every field that holds a length set to a distinct value around `s`. */
function ready(key: ProblemKey, s: number, board: PackingConfig | Record<string, unknown>): ProblemState {
  const p = newProblem(key, "open", T0);
  if (key.family !== "polygon") p.bound = s * 0.75;
  Object.assign(p, {
    phase: "ready",
    board,
    best: s,
    run: RUN,
    floor: s * 1.5,
    published: s * 0.875,
    leader: { score: s * 1.125, name: "Bo", id: 7 },
    verified: s * 1.0625,
    ourId: 3,
    paidTo: s * 1.03125,
    progressBest: s * 1.25,
    refused: { score: s * 0.5, reasons: ["pieces 0 and 1 overlap"] },
    sending: { score: s, name: "Ada", leaderBefore: { score: s * 1.125, name: "Bo", id: 7 }, at: T0, rp: 2.5 },
    trace: [
      [1, s * 1.5],
      [40, s],
    ],
    rpTrace: [[40, 12.5]],
    evaluations: 40,
    lattice: { score: s * 1.375, at: 20 },
    rp: 12.5,
  });
  return p;
}

const poly = (N: number, M: number, P: number) => ({ family: "polygon" as const, N, M, P });
const space = (id: string) => ({
  family: id.split("/")[0] as Exclude<ProblemKey["family"], "polygon">,
  id,
  P: Number(id.split("/").at(-1)),
});

/** The space boards of the test, in each space's format (packages/spaces readSpaceConfig). */
const SPACE_BOARDS: Record<string, Record<string, unknown>> = {
  "sphere/0/12": { rho: 3, pieces: [{ q: [1, 0, 0, 0] }, { q: [0, 1, 0, 0] }] },
  "torus/sq/0/2": {
    lattice: { L: 2.5 },
    poses: [
      [0.25, 0.75, 0.5],
      [1.5, 1.25, 0],
    ],
  },
  "torus/free/0/2": {
    lattice: { b1: [2.5, 0.25], b2: [0.5, 3] },
    poses: [
      [0.25, 0.75, 0.5],
      [1.5, 1.25, 0],
    ],
  },
  "surface/cube/fold/0/20": { s: 6, pieces: [{ x: 0.5, y: 1.5, theta: 0, face: 2 }] },
  "balls/ballinball/13": {
    s: 4,
    pieces: [
      [1, 0.5, -0.25],
      [-1, 0, 0.75],
    ],
  },
  "balls/ballincub/9": { s: 3, pieces: [[1, 0.5, -0.25]] },
  "balls/tetinball/5": { s: 5, pieces: [[0.5, 0.25, 0, 1, 0, 0, 0]] },
  "curved/-1/3/0/7": { size: 4, pieces: [{ x: 0.5, y: -0.25, theta: 1 }] },
  "curved/1/0/3/12": { size: 4, pieces: [{ x: 0.5, y: -0.25, theta: 0 }] },
  "polyhedra/cubintet/12": { s: 5, pieces: [[0, 0, 0, 1, 0, 0, 0]] },
};

/**
 * A game of version 5 as it was saved before the change: an unaffected polygon problem, the three 2D
 * cases, the affected space problems and a curved disk problem at K = -1 (dropped), in the queue, in
 * the past and among the offers.
 */
function oldGame(): GameState {
  const s = newGame(T0, 1234);
  s.name = "Ada";
  addToQueue(s, ready(poly(24, 30, 40), 7, flat(24, 30, 40)));
  addToQueue(s, ready(poly(0, 24, 3), 3.5, flat(0, 24, 3)));
  addToQueue(s, ready(poly(24, 0, 40), 9, flat(24, 0, 40)));
  addToQueue(s, ready(poly(0, 0, 5), 4.5, flat(0, 0, 5)));
  for (const id of [
    "sphere/0/12",
    "torus/sq/0/2",
    "surface/cube/fold/0/20",
    "balls/ballinball/13",
    "balls/tetinball/5",
    "curved/-1/3/0/7",
    "curved/1/0/3/12",
    "polyhedra/cubintet/12",
  ])
    addToQueue(s, ready(space(id), 5, structuredClone(SPACE_BOARDS[id])));
  const past = (key: ProblemKey, k: string, best: number) => ({
    ...key,
    key: k,
    tier: "open" as const,
    best,
    verified: best,
    ourId: 9,
    rp: 4,
    leftAt: T0,
  });
  s.past.push(
    past(poly(0, 30, 40), "0/30/40", 10),
    past(poly(21, 21, 40), "21/21/40", 5),
    past(space("balls/ballincub/9"), "balls/ballincub/9", 3),
    past(space("curved/-1/0/0/9"), "curved/-1/0/0/9", 3),
  );
  s.picks.offers.push(
    {
      ...poly(0, 24, 80),
      tier: "published",
      weakness: null,
      leader: { score: 12.5, name: "Bo", id: 4 },
      target: 12,
      source: "Packomania",
      retake: false,
      score: 0.5,
      prior: 0.25,
      bucket: "published|c",
      at: T0,
    },
    {
      ...space("torus/free/0/2"),
      tier: "open",
      weakness: null,
      leader: null,
      target: null,
      source: null,
      retake: false,
      bound: 1.5,
      score: 0.5,
      prior: 0.25,
      bucket: "open|c",
      at: T0,
    },
  );
  s.picks.retake.push("curved/-1/0/0/9", "0/30/40");
  s.picks.dealt["curved/1/0/3/12"] = { bucket: "open|c", prior: 0.25 };
  s.picks.dealt["0/24/3"] = { bucket: "open|c", prior: 0.25 };
  s.economy.recorded.push("0/30/40");
  s.log.push({ t: T0, text: "New record 3.500000" });
  return s;
}

/** A save document of `version` holding the game. */
const saved = (s: GameState, version: number) => ({ ...JSON.parse(toJson(s)), version });

/** The problem's fields with every length times f, as the conversion must leave them. */
function scaled(p: ProblemState, f: number, board: unknown): ProblemState {
  const x = (v: number | null) => (v === null ? null : v * f);
  return {
    ...p,
    board: board as ProblemState["board"],
    best: x(p.best),
    bound: x(p.bound),
    floor: x(p.floor),
    published: x(p.published),
    leader: p.leader && { ...p.leader, score: p.leader.score * f },
    verified: x(p.verified),
    paidTo: x(p.paidTo),
    progressBest: x(p.progressBest),
    refused: p.refused && { ...p.refused, score: p.refused.score * f },
    sending: p.sending && {
      ...p.sending,
      score: p.sending.score * f,
      leaderBefore: p.sending.leaderBefore && { ...p.sending.leaderBefore, score: p.sending.leaderBefore.score * f },
    },
    trace: p.trace.map(([e, v]) => [e, v * f]),
    lattice: p.lattice && { ...p.lattice, score: p.lattice.score === null ? null : p.lattice.score * f },
  };
}

const halfXY = (c: PackingConfig): PackingConfig => ({
  ...c,
  pieces: c.pieces.map((q) => ({ x: q.x / 2, y: q.y / 2, theta: q.theta })),
});

describe("Tighter saves across the unit change", () => {
  it("convert an old save once, by the server's factors, and keep everything else", () => {
    const s = oldGame();
    const r = readSave(saved(s, 5), T0 + 5000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(SAVE_VERSION).toBe(7);
    // queue: 11 problems, of which 9 are converted and 1 dropped; past: 2 converted, 1 dropped
    expect(r.units).toEqual({ converted: 11, dropped: 2 });
    const q = (key: string) => s.queue.find((p) => p.key === key)!;
    const expected: GameState = {
      ...s,
      version: 7,
      autoDue: 0,
      autoAt: T0 + 5000,
      queue: [
        q("24/30/40"),
        // disks in a polygon: the side and the centres halve
        scaled(q("0/24/3"), 0.5, halfXY(flat(0, 24, 3))),
        // polygons in a circle: the board stays, the diameter is twice the radius
        scaled(q("24/0/40"), 2, flat(24, 0, 40)),
        // disks in a circle: the old radius is the new diameter, the centres halve
        scaled(q("0/0/5"), 1, halfXY(flat(0, 0, 5))),
        scaled(q("sphere/0/12"), 0.5, { ...SPACE_BOARDS["sphere/0/12"], rho: 1.5 }),
        scaled(q("torus/sq/0/2"), 0.5, {
          lattice: { L: 1.25 },
          poses: [
            [0.125, 0.375, 0.5],
            [0.75, 0.625, 0],
          ],
        }),
        scaled(q("surface/cube/fold/0/20"), 0.5, { s: 3, pieces: [{ x: 0.25, y: 0.75, theta: 0, face: 2 }] }),
        // balls in a ball: the old radius is the new diameter; the centres halve
        scaled(q("balls/ballinball/13"), 1, {
          s: 4,
          pieces: [
            [0.5, 0.25, -0.125],
            [-0.5, 0, 0.375],
          ],
        }),
        // solids in a ball: the poses stay, the diameter is twice the radius
        scaled(q("balls/tetinball/5"), 2, { s: 10, pieces: [[0.5, 0.25, 0, 1, 0, 0, 0]] }),
        scaled(q("curved/-1/3/0/7"), 2, { ...SPACE_BOARDS["curved/-1/3/0/7"], size: 8 }),
        // curved/1/0/3/12 left: disks at K = 1 are another problem now
        q("polyhedra/cubintet/12"),
      ],
      past: [{ ...s.past[0], best: 5, verified: 5 }, s.past[1], { ...s.past[2], best: 1.5, verified: 1.5 }],
      picks: {
        ...s.picks,
        offers: [
          { ...s.picks.offers[0], leader: { score: 6.25, name: "Bo", id: 4 }, target: 6 },
          { ...s.picks.offers[1], bound: 0.75 },
        ],
        retake: ["0/30/40"],
        dealt: { "0/24/3": { bucket: "open|c", prior: 0.25 } },
      },
    };
    expect(r.state).toEqual(expected);
  });

  it("are converted only once: saved again, or already of version 6, nothing changes", () => {
    const s = oldGame();
    const r = readSave(saved(s, 5), T0);
    if (!r.ok) throw new Error(r.error);
    const again = readSave(JSON.parse(toJson(r.state)), T0);
    if (!again.ok) throw new Error(again.error);
    expect(again.units).toBeUndefined();
    expect(again.state).toEqual(r.state);
    // a save written in the new units is read as it is, the curved disk problem included
    const fresh = readSave(saved(s, 6), T0);
    if (!fresh.ok) throw new Error(fresh.error);
    expect(fresh.units).toBeUndefined();
    expect(fresh.state).toEqual({ ...s, version: 7, autoDue: 0, autoAt: T0 });
  });

  it("say nothing to a save with no problem the change reached", () => {
    const s = newGame(T0, 1);
    addToQueue(s, ready(poly(24, 30, 40), 7, flat(24, 30, 40)));
    const r = readSave(saved(s, 5), T0);
    if (!r.ok) throw new Error(r.error);
    expect(r.units).toBeUndefined();
    expect(r.state.queue[0]).toEqual(s.queue[0]);
  });

  it("use the server's factors for every kind of problem Tighter deals", () => {
    const planar: [number, number][] = [
      [0, 0],
      [0, 24],
      [24, 0],
      [24, 30],
    ];
    for (const [N, M] of planar) {
      const u = unitPlan(`${N}/${M}/10`);
      const server = planarFactors(N, M);
      if (!server) {
        expect(u).toBeNull();
        continue;
      }
      if (!u || u === DROPPED) throw new Error(`no plan for ${N}/${M}`);
      expect(u.score).toBe(server.score);
      const b = flat(N, M, 3) as unknown as Record<string, unknown>;
      u.board(b);
      expect(b.pieces).toEqual(flat(N, M, 3).pieces.map((q) => ({ ...q, x: q.x * server.len, y: q.y * server.len })));
    }
    const ids = [
      ...Object.keys(SPACE_BOARDS),
      "sphere/5/12",
      "torus/hex/4/8",
      "surface/cube/fold/4/20",
      "curved/-1/4/5/7",
      "curved/1.225778283313099/0/0/7",
      "balls/cubinpkd/4",
    ];
    for (const id of ids) {
      const u = unitPlan(id);
      const server = spacePlan(id.split("/")[0], id);
      if (server === null) {
        expect(u, id).toBeNull();
        continue;
      }
      if (server === "archive") {
        expect(u, id).toBe(DROPPED);
        continue;
      }
      if (!u || u === DROPPED) throw new Error(`no plan for ${id}`);
      expect(u.score, id).toBe(server.score);
      const ours = structuredClone(SPACE_BOARDS[id] ?? { s: 2, size: 2, rho: 2, pieces: [] });
      const theirs = structuredClone(ours);
      u.board(ours);
      server.apply(theirs);
      expect(ours, id).toEqual(theirs);
    }
  });
});
