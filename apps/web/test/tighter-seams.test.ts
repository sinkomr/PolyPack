import { describe, expect, it } from "vitest";
import { findFreeSpot } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import {
  GameState,
  addToQueue,
  applyAnswer,
  applyLoadAll,
  applyStep,
  hasUnsent,
  newGame,
  newProblem,
  ownedSet,
  pay,
  submitTarget,
} from "../src/tighter/game";
import { settleRent } from "../src/tighter/economy";
import { Offer, offerFits } from "../src/tighter/picks";
import { readSave, toJson } from "../src/tighter/save";
import { resetCycle, resetPreview } from "../src/tighter/standing";
import { UpgradeId, upgrade } from "../src/tighter/upgrades";

// Seams between the shop, the dealer, the runs and the economy: what one piece's change does to another's.

const T0 = 1_000_000;
const HOUR = 3_600_000;

function loadAll(N: number, M: number, P: number): PackingConfig {
  const pieces: Pose[] = [];
  for (let k = 0; k < P; k++) pieces.push(findFreeSpot(N, pieces, 0, 0));
  return { N, M, P, pieces, container_phi: 0 };
}

const run = (evals: number) => ({ method: "mc_compress", params: {}, seed: 1, budget: { evals } });

function owning(s: GameState, ids: UpgradeId[]): void {
  const add = (id: UpgradeId) => {
    if (s.owned.includes(id)) return;
    for (const r of upgrade(id).requires) add(r);
    s.owned.push(id);
  };
  for (const id of ids) add(id);
}

/** A game with consent and one open problem whose first record has been paid (not yet confirmed). */
function withRecord(): { s: GameState; p: ReturnType<typeof newProblem> } {
  const s = newGame(T0, 1);
  s.name = "Ada";
  s.consent = true;
  const p = newProblem({ family: "polygon", N: 24, M: 30, P: 40 }, "open", T0);
  addToQueue(s, p);
  const b = loadAll(24, 30, 40);
  applyLoadAll(p, b, 7, null);
  const best = { ...b, pieces: b.pieces.map((q) => ({ ...q, x: q.x + 0.1 })) };
  applyStep(s, p, { evaluations: 100, best, score: 6.5, run: run(101), ms: 1, ended: false, click: true }, T0);
  return { s, p };
}

describe("Tighter seams", () => {
  it("give standing only for points the server has confirmed", () => {
    const { s, p } = withRecord();
    owning(s, ["standing"]);
    // a cycle of 8 M RP, 7.2 M of them paid per click and still waiting for the server's answer
    s.standing.cycleEarned = 8_000_000;
    p.unconfirmed = 7_200_000;
    expect(resetPreview(s).gain).toBe(0);
    expect(resetCycle(s, T0)).toBe(0);
    // once confirmed, they count
    p.unconfirmed = 0;
    expect(resetPreview(s).gain).toBe(2);
    // a send on its way carries its points: not confirmed yet either
    p.sending = { score: 6.5, name: "Ada", leaderBefore: null, at: T0, rp: 7_200_000 };
    expect(resetPreview(s).gain).toBe(0);
    // a reset trades only the confirmed points; those still waiting carry into the next cycle
    s.standing.cycleEarned = 16_000_000;
    s.rp = 8_000_000;
    expect(resetCycle(s, T0)).toBe(2);
    expect(s.rp).toBe(7_200_000);
    expect(s.standing.cycleEarned).toBe(7_200_000);
    // and if the server does not confirm them, they are taken from there, once
    applyAnswer(s, p, null, 6.5, { kind: "refused", status: 422, reasons: ["no"] }, T0 + 1);
    expect(s.rp).toBe(0);
    expect(s.standing.cycleEarned).toBe(0);
  });

  it("pay no rent for the time a record was lost to a faster entry, even when it is won back", () => {
    const { s, p } = withRecord();
    owning(s, ["rent"]);
    applyAnswer(s, p, null, 6.5, { kind: "leader", score: 6.5, id: 3, pending: false }, T0);
    expect(s.economy.checks[p.key]).toBe(T0);
    // another entry got there first: the record is lost at once
    applyAnswer(s, p, p.leader, 6.4, { kind: "behind", leaderScore: 6.45 }, T0 + HOUR);
    expect(s.economy.checks[p.key]).toBeUndefined();
    // won back two days later: its rent runs from then, not from before it was lost
    p.best = 6.4;
    applyAnswer(s, p, p.leader, 6.4, { kind: "leader", score: 6.4, id: 9, pending: false }, T0 + 49 * HOUR);
    expect(s.economy.checks[p.key]).toBe(T0 + 49 * HOUR);
    const paid = settleRent(s, ownedSet(s), p, T0 + 50 * HOUR);
    const perHour = 0.01 * s.economy.base[p.key];
    expect(paid).toBeCloseTo(perHour, 9);
  });

  it("drop offers drawn for the old tree at a reset, and keep lost records offered for a retake", () => {
    const s = newGame(T0, 1);
    owning(s, ["standing", "pick3"]);
    s.standing.cycleEarned = 8_000_000;
    const offer = (P: number, retake: boolean): Offer => ({
      family: "polygon",
      N: 7,
      M: 7,
      P,
      tier: "loose",
      weakness: 0.01,
      leader: { score: 9, name: "Bo", id: 4 },
      target: null,
      source: null,
      retake,
      score: 1,
      prior: 1,
      bucket: "loose|t300|f",
      at: T0,
    });
    s.picks.offers = [offer(300, false), offer(301, true)];
    s.picks.retake = ["8/8/8"];
    expect(resetCycle(s, T0)).toBeGreaterThan(0);
    expect(s.picks.offers).toEqual([]);
    expect(s.picks.retake).toEqual(["7/7/301", "8/8/8"]);
  });

  it("let an offer be taken only while the tree, the filters and the rule still allow it", () => {
    const base: Offer = {
      family: "polygon",
      N: 7,
      M: 7,
      P: 300,
      tier: "loose",
      weakness: 0.01,
      leader: { score: 9, name: "Bo", id: 4 },
      target: null,
      source: null,
      retake: false,
      score: 1,
      prior: 1,
      bucket: "loose|t300|f",
      at: T0,
    };
    const yes = () => true;
    const tree = { retake: false, tiers: new Set(["loose"] as const), ringMin: 300 };
    expect(offerFits(base, tree, yes)).toBe(true);
    // a size ring or a tier the tree no longer reaches, or a rule or filter that refuses it
    expect(offerFits({ ...base, P: 200 }, tree, yes)).toBe(false);
    expect(offerFits({ ...base, tier: "batch" }, tree, yes)).toBe(false);
    expect(offerFits(base, { ...tree, ringMin: Infinity }, yes)).toBe(false);
    expect(offerFits(base, tree, () => false)).toBe(false);
    // an open problem needs no reach; a retake needs Retake
    expect(offerFits({ ...base, tier: "open", leader: null }, { ...tree, ringMin: Infinity }, yes)).toBe(true);
    expect(offerFits({ ...base, retake: true, P: 20 }, { ...tree, retake: true }, yes)).toBe(true);
    expect(offerFits({ ...base, retake: true, P: 20 }, tree, yes)).toBe(false);
  });

  it("keep a pipeline's stages through a reload, even for methods a reset took away", () => {
    const s = newGame(T0, 1);
    owning(s, ["standing", "pipeline"]);
    s.runplan.pipeline = ["mc_compress", "penalty", "harden"];
    const r = readSave(JSON.parse(toJson(s)), T0);
    expect(r.ok && r.state.runplan.pipeline).toEqual(["mc_compress", "penalty", "harden"]);
    const raw = JSON.parse(toJson(s));
    raw.runplan.pipeline = ["mc_compress", "warp", 7];
    const t = readSave(raw, T0);
    expect(t.ok && t.state.runplan.pipeline).toEqual(["mc_compress"]);
  });

  it("read a save of the live per-click build and play on", () => {
    // the per-click build (live 2026-10-20) wrote version 2 without levels, standing, economy, picks or run plans
    const { s } = withRecord();
    const raw = JSON.parse(toJson(s));
    for (const k of ["levels", "standing", "economy", "picks", "runplan"]) delete raw[k];
    for (const q of raw.queue) delete q.published;
    raw.owned = ["trace", "click2", "click3", "click4", "auto1", "reach2"];
    const r = readSave(raw, T0 + 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = r.state;
    expect(g).toMatchObject({ levels: {}, standing: { points: 0, total: 0, resets: 0, rule: null } });
    expect(g.queue[0].published).toBeNull();
    expect(g.economy).toMatchObject({ recorded: [], base: {}, checks: {} });
    expect(g.picks).toMatchObject({ offers: [], retake: [], dealt: {} });
    // plays on: the next improvement pays (with consent), with no multiplier
    const p = g.queue[0];
    const better = { ...p.board!, pieces: p.board!.pieces.map((q) => ({ ...q, y: q.y + 0.01 })) };
    const c = applyStep(
      g,
      p,
      { evaluations: 1, best: better, score: 6.4, run: run(102), ms: 1, ended: false, click: true },
      T0 + 2000,
    );
    expect(c.points).toMatchObject({ multiplier: 1 });
    expect(pay(g, p)).toBeNull();
  });

  it("fall back safely from malformed slices", () => {
    const { s } = withRecord();
    const raw = JSON.parse(toJson(s));
    raw.standing = {
      points: "x",
      total: -3,
      rule: "nope",
      rulesDone: ["circles", 4, "warp"],
      history: [5, {}],
      marks: [],
    };
    raw.economy = { recorded: "x", tiers: [1], base: { "1/2/3": -1, "4/5/6": 2 }, checks: [], lastRent: { key: 1 } };
    raw.picks = {
      offers: [{ N: 1 }, null],
      filters: 7,
      dealt: { a: 1, "1/2/3": { bucket: 4 } },
      bandit: [],
      retake: [3],
    };
    raw.runplan = { auto: "yes", pipeline: "mc_compress", bandit: { a: { n: 1.5 } }, draws: -1 };
    raw.levels = [];
    const r = readSave(raw, T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.standing).toMatchObject({ points: 0, total: 0, rule: null, rulesDone: ["circles"] });
    expect(r.state.economy).toMatchObject({ recorded: [], base: { "4/5/6": 2 }, checks: {}, lastRent: null });
    expect(r.state.picks).toMatchObject({ offers: [], filters: null, dealt: {}, bandit: {}, retake: [] });
    expect(r.state.runplan).toEqual({ auto: false, pipeline: [], bandit: {}, draws: 0 });
    expect(r.state.levels).toEqual({});
  });
});

describe("Tighter published values", () => {
  it("send a board only once it beats the published value, not a small gain on the published packing", () => {
    const p = newProblem({ family: "polygon", N: 4, M: 4, P: 30 }, "published", 0);
    p.phase = "ready";
    p.board = { N: 4, M: 4, P: 30, pieces: [], container_phi: 0 };
    p.run = { method: "mc_compress", params: {}, seed: 1, budget: { evals: 10 } };
    p.published = 6.0;
    p.floor = 6.2;
    p.leader = null;
    // better than the start (the published coordinates), not better than the value
    p.best = 6.1;
    expect(hasUnsent(p)).toBe(false);
    expect(submitTarget(p, null)).toBe(6.0);
    p.best = 5.99;
    expect(hasUnsent(p)).toBe(true);
    // with a site leader above the value, the value still decides
    expect(submitTarget(p, 6.3)).toBe(6.0);
    expect(submitTarget(p, 5.995)).toBe(5.995);
  });
});
