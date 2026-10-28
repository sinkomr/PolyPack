import { describe, expect, it } from "vitest";
import { areaLowerBound, findFreeSpot } from "@polypack/geometry";
import type { LeaderboardEntry, PackingConfig, Pose, ProblemInfo } from "@polypack/geometry";
import type { RecordsResponse } from "../src/api";
import {
  CONTESTED_SIDES,
  WIDE,
  contestedCandidates,
  contestedDealable,
  drawContestedPair,
  drawWide,
  mulberry32,
  newDealer,
  publishedTarget,
  retakeTier,
  weaknesses,
} from "../src/tighter/dealer";
import { FRONTIER_P, keyOf } from "../src/tighter/frontier";
import { addToQueue, applyStep, leave, newGame, newProblem, pay } from "../src/tighter/game";
import { MAX_OFFERS, addRetake, learnOnLeave, newPicks, normalizeOffer, normalizePicks } from "../src/tighter/picks";
import { CONTEST, Tier, costFactor } from "../src/tighter/points";
import {
  COST_TABLE,
  Candidate,
  LEARN_MIN_EVALS,
  bucketOf,
  collectorTargets,
  formatShapes,
  learn,
  learnedRatio,
  msPerEval,
  normalizeFilters,
  parseShapes,
  passes,
  RP_PER_EVAL,
  priorPerEval,
  rankCandidates,
  room,
  sizeRing,
  speedFactor,
} from "../src/tighter/rank";
import { fromJson, toJson } from "../src/tighter/save";
import {
  SWITCHES,
  dealerChoices,
  inUse,
  offText,
  offerCount,
  owning,
  ringMin,
  switchName,
  switchOf,
} from "../src/tighter/upgrades";

const T0 = 1_700_000_000_000;

const entry = (P: number, score: number, over: Partial<LeaderboardEntry> = {}) => ({
  P,
  id: 1000 + P,
  name: "Bob",
  found_with: null,
  agent_note: "",
  score,
  created_at: "",
  verification: "none" as const,
  ...over,
});

/** A pair's records with every P from `from` to `to` at a gap of `g` (or `gapOf(P)`). */
function records(
  N: number,
  M: number,
  from: number,
  to: number,
  gapOf: (P: number) => number,
  literature: RecordsResponse["literature"] = [],
): RecordsResponse {
  const site = [];
  for (let P = from; P <= to; P++) site.push(entry(P, areaLowerBound(N, M, P) * (1 + gapOf(P))));
  return { N, M, literature, site };
}

const lit = (P: number, value: number, status = "best_known", has_coordinates = true) =>
  ({
    N: 7,
    M: 7,
    P,
    value,
    display: value.toFixed(4),
    display_precision: 4,
    status,
    source_name: "Erich",
    source_url: "",
    accessed: "",
    conversion_note: "",
    has_coordinates,
  }) as RecordsResponse["literature"][number];

const allTiers = new Set<Tier>(["loose", "batch", "published"]);

const generator = (seed: number) => {
  let k = 0;
  return () => mulberry32((seed + Math.imul(k++, 0x9e3779b1)) >>> 0);
};

describe("Tighter contested problems", () => {
  it("judge a record against its neighbours in P, not by its raw gap", () => {
    // gaps fall smoothly with size; P = 305 is 2 points weaker than its neighbours, P = 310 a hair
    const r = records(7, 7, 300, 320, (P) => 0.1 - P * 1e-4 + (P === 305 ? 0.02 : P === 310 ? 0.001 : 0));
    const w = weaknesses(r);
    expect(w.get(305)).toBeCloseTo(0.02, 3);
    expect(w.get(310)).toBeCloseTo(0.001, 3);
    const list = contestedCandidates(r, { ringMin: 300, tiers: allTiers, exclude: new Set() });
    const tierOf = (P: number) => list.find((c) => c.P === P)?.tier;
    expect(tierOf(305)).toBe("loose");
    expect(tierOf(310)).toBe("batch");
    expect(tierOf(300)).toBe("batch");
    // a record with fewer than two neighbours is judged as typical
    const lone = records(7, 7, 300, 301, () => 0.3);
    expect([...weaknesses(lone).values()]).toEqual([0, 0]);
  });

  it("deal only the tiers and the size ring the player has reached, and nothing excluded or in review", () => {
    const r = records(7, 7, 280, 300, (P) => (P === 290 ? 0.12 : 0.08));
    r.site.push(entry(301, 1, { verification: "pending" }));
    const only = (tiers: Tier[], ringMinimum: number, exclude: string[] = []) =>
      contestedCandidates(r, { ringMin: ringMinimum, tiers: new Set(tiers), exclude: new Set(exclude) });
    // N + M + P >= 300 is P >= 286 for heptagons in a heptagon
    expect(only(["loose"], 300).map((c) => c.P)).toEqual([290]);
    expect(only(["loose", "batch"], 300).every((c) => c.P >= 286 && c.P <= 300)).toBe(true);
    expect(only(["loose", "batch"], 300)).toHaveLength(15);
    expect(only(["loose"], Infinity)).toEqual([]);
    expect(only(["loose"], 300, ["7/7/290"])).toEqual([]);
    // the cycle's rule and the filters reach every candidate
    expect(
      contestedCandidates(r, { ringMin: 0, tiers: allTiers, exclude: new Set(), allow: (c) => c.P % 2 === 0 }).every(
        (c) => c.P % 2 === 0,
      ),
    ).toBe(true);
  });

  it("make published values candidates of their own, to beat by more than their printed precision", () => {
    const r = records(7, 7, 296, 304, () => 0.08, [
      lit(298, 30),
      lit(300, 31, "proven"),
      lit(302, 32, "best_known", false),
      lit(303, 33, "best_known", false),
    ]);
    r.site = r.site.filter((e) => e.P !== 303);
    const list = contestedCandidates(r, { ringMin: 0, tiers: allTiers, exclude: new Set() });
    const at = (P: number) => list.filter((c) => c.P === P);
    // a site record on a problem with a published value is never a site-record candidate
    expect(at(298)).toEqual([
      expect.objectContaining({ tier: "published", target: 30 - 1e-4, leader: expect.objectContaining({ id: 1298 }) }),
    ]);
    expect(at(298)[0].source).toBe("30.0000 (Erich)");
    // proven values are closed: never dealt
    expect(at(300)).toEqual([]);
    // without coordinates, a published value needs a site record to start from
    expect(at(302)).toHaveLength(1);
    expect(at(303)).toEqual([]);
    expect(publishedTarget({ value: 2.5, display_precision: 3 })).toBeCloseTo(2.499, 12);
    // without the tier, none
    expect(
      contestedCandidates(r, { ringMin: 0, tiers: new Set(["loose", "batch"]), exclude: new Set() }).some(
        (c) => c.tier === "published",
      ),
    ).toBe(false);
  });

  it("check a candidate again just before it is dealt", () => {
    const info = (over: Partial<ProblemInfo>): ProblemInfo => ({
      N: 7,
      M: 7,
      P: 300,
      conventions: {},
      area_bound: 1,
      literature: null,
      site_best: { ...entry(300, 9), id: 5 },
      accepts_submissions: true,
      ...over,
    });
    const c: Candidate = {
      N: 7,
      M: 7,
      P: 300,
      tier: "batch",
      weakness: 0,
      leader: { score: 9, name: "Bob", id: 5 },
      target: null,
      source: null,
      retake: false,
    };
    expect(contestedDealable(info({}), c)).toBe(true);
    expect(contestedDealable(null, c)).toBe(false);
    expect(contestedDealable(info({ site_best: { ...entry(300, 8), id: 6 } }), c)).toBe(false);
    expect(contestedDealable(info({ site_best: { ...entry(300, 9, { verification: "pending" }), id: 5 } }), c)).toBe(
      false,
    );
    expect(contestedDealable(info({ accepts_submissions: false }), c)).toBe(false);
    expect(contestedDealable(info({ literature: lit(300, 8) as never }), c)).toBe(false);
    const pub = { ...c, tier: "published" as const, leader: null, target: 8 };
    expect(contestedDealable(info({ site_best: null, literature: lit(300, 8) as never }), pub)).toBe(true);
    expect(contestedDealable(info({ site_best: null, literature: lit(300, 8, "proven") as never }), pub)).toBe(false);
  });

  it("classify a lost record for a retake", () => {
    expect(retakeTier(24, 30, 60, null)).toBe("loose");
    const r = records(7, 7, 296, 304, (P) => (P === 300 ? 0.2 : 0.08), [lit(302, 1)]);
    expect(retakeTier(7, 7, 300, r)).toBe("loose");
    expect(retakeTier(7, 7, 298, r)).toBe("batch");
    expect(retakeTier(7, 7, 302, r)).toBe("published");
  });

  it("draw the wider frontier and contested pairs reproducibly, within their ranges", () => {
    const a = newDealer(3);
    const b = newDealer(3);
    for (let i = 0; i < 50; i++) {
      const p = drawWide(a, new Set())!;
      expect(drawWide(b, new Set())).toEqual(p);
      expect(p.N).toBeGreaterThanOrEqual(WIDE.minSide);
      expect(p.M).toBeLessThanOrEqual(WIDE.maxSide);
      expect(p.P).toBeGreaterThanOrEqual(WIDE.minP);
      expect(p.P).toBeLessThanOrEqual(500);
    }
    expect(drawWide(a, new Set(), () => false)).toBeNull();
    const pairs = new Set<string>();
    for (let i = 0; i < 200; i++) {
      // circles only (a filter), in any contested container
      const q = drawContestedPair(a, [0])!;
      expect(q.N).toBe(0);
      expect(CONTESTED_SIDES).toContain(q.M);
      pairs.add(`${q.N}/${q.M}`);
    }
    expect(pairs.size).toBeGreaterThan(10);
    expect(drawContestedPair(a, [0], [4])).toEqual({ N: 0, M: 4 });
    // only sides above 20: no contested pair
    expect(drawContestedPair(a, [30, 40])).toBeNull();
  });
});

describe("Tighter ranking", () => {
  const cand = (over: Partial<Candidate>): Candidate => ({
    family: "polygon",
    N: 24,
    M: 30,
    P: 60,
    tier: "open",
    weakness: null,
    leader: null,
    target: null,
    source: null,
    retake: false,
    ...over,
  });

  it("knows what an evaluation costs by size, from the measured table", () => {
    for (const [t, ms] of COST_TABLE) expect(msPerEval(t)).toBeCloseTo(ms, 6);
    expect(msPerEval(100)).toBeGreaterThan(msPerEval(85));
    expect(msPerEval(100)).toBeLessThan(msPerEval(180));
    expect(msPerEval(1000)).toBeGreaterThan(52.3);
    expect(msPerEval(4)).toBeLessThan(0.22);
    expect(speedFactor(85)).toBeCloseTo(1, 12);
    expect(speedFactor(500)).toBeCloseTo(Math.sqrt(1.77 / 52.3), 6);
  });

  it("expects more of open problems and of loose records than of tight ones, weighted by contest", () => {
    expect(room("open", null)).toBe(1);
    expect(room("loose", 0.005)).toBeLessThan(room("loose", 0.02));
    expect(room("loose", 1)).toBe(1);
    expect(room("batch", 0)).toBeLessThan(room("loose", 0.005));
    expect(room("published", null)).toBeLessThan(room("batch", 0));
    const small = priorPerEval(cand({ family: "polygon", N: 7, M: 7, P: 300, tier: "batch", weakness: 0 }));
    expect(small).toBeCloseTo(
      CONTEST.batch * room("batch", 0) * costFactor({ family: "polygon", N: 7, M: 7, P: 300 }) * RP_PER_EVAL,
      12,
    );
    expect(RP_PER_EVAL).toBe(4);
    // a published value is expected to pay less per evaluation than a site record, whatever its weight
    expect(CONTEST.published * room("published", null)).toBeLessThan(CONTEST.batch * room("batch", 0));
    // the shape weight: 100-gons in a 100-gon pay a twenty-fifth of what heptagons do
    // (same cost factor at the same N+M+P is not given, so the factor is taken out)
    const per = (N: number, M: number) =>
      priorPerEval(cand({ family: "polygon", N, M, P: 60 })) / costFactor({ family: "polygon", N, M, P: 60 });
    expect(per(100, 100)).toBeCloseTo(per(7, 7) / 25, 12);
    // the prior grows with the cost of an evaluation: a 300-piece problem pays more per evaluation than a 40-piece one
    expect(priorPerEval(cand({ P: 300 }))).toBeGreaterThan(priorPerEval(cand({ P: 40 })));
  });

  it("rank retakes first, then by expected points per second of solver time", () => {
    const big = cand({ family: "polygon", N: 100, M: 100, P: 300 });
    const starter = cand({ family: "polygon", N: 21, M: 24, P: 40 });
    const retake = cand({ N: 90, M: 90, P: 250, tier: "loose", retake: true, leader: { score: 9, name: "x", id: 1 } });
    const ranked = rankCandidates([big, starter, retake], null, generator(1));
    expect(ranked.map((r) => r.candidate)).toEqual([retake, starter, big]);
    expect(ranked[1].score).toBeGreaterThan(ranked[2].score);
    expect(ranked[1].bucket).toBe(bucketOf(starter));
    expect(rankCandidates([], null, generator(1))).toEqual([]);
  });

  it("learns which buckets pay, and ranks by what it learned once the learning dealer is owned", () => {
    const open = cand({ family: "polygon", N: 24, M: 30, P: 60 });
    const loose = cand({ N: 7, M: 7, P: 300, tier: "loose", weakness: 0.01, leader: { score: 9, name: "x", id: 1 } });
    // the prior prefers the loose record
    expect(rankCandidates([open, loose], null, generator(2))[0].candidate).toBe(loose);
    const b = {};
    // ... but loose records have paid a tenth of their prior, and open problems three times theirs
    for (let i = 0; i < 20; i++) {
      learn(b, bucketOf(loose), 0.1 * priorPerEval(loose) * 500, 500, priorPerEval(loose));
      learn(b, bucketOf(open), 3 * priorPerEval(open) * 500, 500, priorPerEval(open));
    }
    const wins = { open: 0, loose: 0 };
    const rand = generator(5);
    for (let i = 0; i < 200; i++) wins[rankCandidates([open, loose], b, rand)[0].candidate.tier as "open"]++;
    expect(wins.open).toBeGreaterThan(190);
    // a problem that ran too little teaches nothing
    expect(learnedRatio(10, LEARN_MIN_EVALS - 1, 1)).toBeNull();
    expect(learnedRatio(1e9, 1000, 1)).toBe(20);
    expect(learnedRatio(-5, 1000, 1)).toBe(0);
  });

  it("puts problems in buckets of tier, size ring and shape class", () => {
    expect(sizeRing(500)).toBe(0);
    expect(sizeRing(300)).toBe(0);
    expect(sizeRing(299)).toBe(1);
    expect(sizeRing(29)).toBe(6);
    expect(bucketOf({ family: "polygon", N: 0, M: 4, P: 300, tier: "loose" })).toBe("loose|r0|cf");
    expect(bucketOf({ family: "polygon", N: 21, M: 100, P: 40, tier: "open" })).toBe("open|r2|nn");
    expect(bucketOf({ family: "polygon", N: 12, M: 7, P: 30, tier: "batch" })).toBe("batch|r5|mm");
  });
});

describe("Tighter dealer filters", () => {
  it("read shapes as lists and ranges, and write them back the same way", () => {
    expect(parseShapes("")).toBeNull();
    expect(parseShapes("0, 3-5 9")).toEqual([0, 3, 4, 5, 9]);
    expect(parseShapes("1-4")).toEqual([3, 4]);
    expect(parseShapes("12–14")).toEqual([12, 13, 14]);
    expect(parseShapes("x")).toEqual({ error: "cannot read “x”" });
    expect(parseShapes("9-3")).toHaveProperty("error");
    expect(parseShapes("1, 2")).toHaveProperty("error");
    expect(parseShapes("90-120")).toHaveProperty("error");
    expect(formatShapes([0, 3, 4, 5, 9, 21, 22])).toBe("0, 3-5, 9, 21-22");
    expect(formatShapes(null)).toBe("");
  });

  it("pass only what they allow, and read only well-formed filters from a save", () => {
    const f = normalizeFilters({
      pieces: [0, 4, 4, 7, 2, "x"],
      containers: [],
      minP: 50,
      maxP: 20,
      tiers: ["loose", "warp"],
    })!;
    expect(f).toEqual({ pieces: [0, 4, 7], containers: null, minP: 50, maxP: 50, tiers: ["loose"] });
    expect(passes(f, { family: "polygon", N: 4, M: 9, P: 50, tier: "loose" })).toBe(true);
    expect(passes(f, { family: "polygon", N: 5, M: 9, P: 50, tier: "loose" })).toBe(false);
    expect(passes(f, { family: "polygon", N: 4, M: 9, P: 51, tier: "loose" })).toBe(false);
    expect(passes(f, { family: "polygon", N: 4, M: 9, P: 50, tier: "batch" })).toBe(false);
    // without a tier, only the shape and size are judged (a pair drawn before its records are read)
    expect(passes(f, { family: "polygon", N: 4, M: 9, P: 50 })).toBe(true);
    expect(passes(null, { family: "polygon", N: 5, M: 9, P: 1 })).toBe(true);
    expect(normalizeFilters("x")).toBeNull();
    expect(normalizeFilters({})).toEqual({ pieces: null, containers: null, minP: 1, maxP: 500, tiers: null });
  });
});

describe("Tighter offers and the dealer's memory", () => {
  const offer = (over: Record<string, unknown> = {}) => ({
    family: "polygon",
    N: 7,
    M: 7,
    P: 300,
    tier: "loose",
    weakness: 0.01,
    leader: { score: 9.5, name: "Bob", id: 12 },
    target: null,
    source: null,
    retake: false,
    score: 0.4,
    prior: 0.6,
    bucket: "loose|r0|mm",
    at: T0,
    ...over,
  });

  it("read only offers that can be dealt from a save", () => {
    expect(normalizeOffer(offer())).toEqual(offer());
    expect(normalizeOffer(offer({ tier: "warp" }))).toBeNull();
    // a site record starts from its leader's packing: without one it cannot be dealt
    expect(normalizeOffer(offer({ leader: null }))).toBeNull();
    expect(normalizeOffer(offer({ tier: "published", leader: null, target: null }))).toBeNull();
    expect(normalizeOffer(offer({ tier: "published", leader: null, target: 9.4 }))).toMatchObject({ target: 9.4 });
    expect(normalizeOffer(offer({ tier: "open", leader: null, target: 3 }))).toMatchObject({ target: null });
    expect(normalizeOffer(offer({ N: -1 }))).toBeNull();
    expect(normalizeOffer(offer({ score: "high" }))).toBeNull();
    const many = Array.from({ length: 9 }, (_, i) => offer({ P: 300 + i }));
    const picks = normalizePicks({
      offers: [...many, offer()],
      dealt: { "7/7/300": { bucket: "b", prior: 1 }, x: {} },
    });
    expect(picks.offers).toHaveLength(MAX_OFFERS);
    expect(picks.dealt).toEqual({ "7/7/300": { bucket: "b", prior: 1 } });
    expect(normalizePicks(null)).toEqual(newPicks());
  });

  it("learn from a problem when it leaves the queue, in the bucket it was dealt under", () => {
    const s = newGame(T0, 1);
    const p = newProblem({ family: "polygon", N: 24, M: 30, P: 60 }, "open", T0);
    addToQueue(s, p);
    s.picks.dealt[p.key] = { bucket: "open|r2|nn", prior: 0.1 };
    p.rp = 60;
    p.evaluations = 300;
    leave(s, p.key, T0 + 1);
    expect(s.picks.dealt).toEqual({});
    expect(s.picks.bandit["open|r2|nn"]).toEqual({ n: 1, mean: 2, m2: 0 });
    // a problem dealt before the dealer remembered it teaches nothing
    expect(learnOnLeave(s.picks, { key: "1/2/3", rp: 1, evaluations: 1000 })).toBe(false);
  });

  it("keep lost records for a retake once each, newest last", () => {
    const picks = newPicks();
    addRetake(picks, "a");
    addRetake(picks, "b");
    addRetake(picks, "a");
    expect(picks.retake).toEqual(["b", "a"]);
    for (let i = 0; i < 250; i++) addRetake(picks, `k${i}`);
    expect(picks.retake).toHaveLength(200);
    expect(picks.retake.at(-1)).toBe("k249");
  });

  it("aim the Collector at the pair nearest to complete, its missing problems in order", () => {
    const rec = (N: number, M: number, ps: number[]) => ps.map((P) => keyOf({ family: "polygon", N, M, P }));
    const recorded = new Set([...rec(21, 24, FRONTIER_P.slice(0, 7)), ...rec(30, 30, FRONTIER_P.slice(0, 3))]);
    const exclude = new Set([keyOf({ family: "polygon", N: 21, M: 24, P: FRONTIER_P[7] })]);
    const targets = collectorTargets(recorded, exclude);
    expect(targets[0]).toEqual({ family: "polygon", N: 21, M: 24, P: FRONTIER_P[8] });
    expect(targets[1]).toEqual({ family: "polygon", N: 30, M: 30, P: FRONTIER_P[3] });
    expect(targets).toHaveLength(1 + 6);
    // a complete pair, or none begun, gives nothing
    expect(collectorTargets(new Set(rec(21, 24, [...FRONTIER_P])), new Set())).toEqual([]);
    expect(collectorTargets(new Set(), new Set())).toEqual([]);
  });

  it("names the dealer's upgrades as game parameters", () => {
    expect(dealerChoices(owning([]))).toBe(1);
    expect(dealerChoices(owning(["rank2", "rank4"]))).toBe(4);
    expect(offerCount(owning(["pick3"]))).toBe(3);
    expect(offerCount(owning(["pick3", "pick5"]))).toBe(5);
    expect(ringMin(owning([]))).toBe(Infinity);
    expect(ringMin(owning(["reach2", "ring200", "ring120"]))).toBe(120);
  });

  it("turns the dealer's upgrades off and on again: a ladder is one switch, named by its first rung", () => {
    expect(SWITCHES).toEqual(["rank2", "pick3", "filters", "retake", "collector", "learning"]);
    expect(switchOf("rank8")).toBe("rank2");
    expect(switchOf("pick5")).toBe("pick3");
    expect(switchOf("reach2")).toBeNull();
    const ids = ["rank2", "rank4", "pick3", "pick5", "filters", "learning"] as const;
    // the best of 4 off: the dealer deals the first problem it draws, not the best of 2
    const off = owning(ids, {}, null, [], ["rank2", "learning"]);
    expect(dealerChoices(off)).toBe(1);
    expect(offerCount(off)).toBe(5);
    expect(inUse(off, "learning")).toBe(false);
    expect(inUse(off, "filters")).toBe(true);
    // still owned: the tree, its prices and its prerequisites see no change
    expect(off.has("rank4")).toBe(true);
    expect(offerCount(owning(ids, {}, null, [], ["pick3"]))).toBe(0);
    // a switch off on an upgrade not owned changes nothing
    expect(inUse(owning(["retake"], {}, null, [], ["collector"]), "retake")).toBe(true);
    expect(switchName(off, "rank2")).toBe("Dealer: best of 4");
    expect(switchName(off, "pick3")).toBe("Your pick: 5");
    for (const id of SWITCHES) expect(offText(id)).toMatch(/^While it is off, [^—;:]+\.$/);
    expect(offText("rank8")).toBe(offText("rank2"));
    expect(offText("reach2")).toBeNull();
  });
});

describe("Tighter published values", () => {
  function loadAll(N: number, M: number, P: number): PackingConfig {
    const pieces: Pose[] = [];
    for (let k = 0; k < P; k++) pieces.push(findFreeSpot(N, pieces, 0, 0));
    return { N, M, P, pieces, container_phi: 0 };
  }

  it("pay nothing until the board beats the published value, then pay from it at 100x", () => {
    const s = newGame(T0, 1);
    s.name = "Ada";
    const p = newProblem({ family: "polygon", N: 7, M: 7, P: 40 }, "published", T0);
    addToQueue(s, p);
    const board = loadAll(7, 7, 40);
    p.phase = "ready";
    p.board = board;
    p.best = 10;
    p.floor = 10;
    p.leader = { score: 10, name: "Bob", id: 3 };
    p.published = 9;
    const step = (score: number) =>
      applyStep(
        s,
        p,
        {
          evaluations: 1,
          best: board,
          score,
          run: { method: "mc_compress", params: {}, seed: 1, budget: { evals: 2 } },
          ms: 1,
          ended: false,
          click: true,
        },
        T0,
      );
    // better than the site record, not than the published value: an improvement, no points
    const c1 = step(9.5);
    expect(c1.counted).toBe(true);
    expect(c1.points).toBeNull();
    expect(s.rp).toBe(0);
    const c2 = step(8.9);
    expect(c2.points).not.toBeNull();
    expect(c2.points!.c).toBe(100);
    // measured from the published value, not from the site record
    expect(c2.points!.delta).toBeCloseTo(1 - 8.9 / 9, 12);
    expect(pay(s, p)).toBeNull();
  });

  it("keep a problem's published value through a save", () => {
    const s = newGame(T0, 1);
    const p = newProblem({ family: "polygon", N: 7, M: 7, P: 40 }, "published", T0);
    p.published = 9.25;
    addToQueue(s, p);
    s.picks.offers.push(
      normalizeOffer({
        N: 4,
        M: 4,
        P: 300,
        tier: "batch",
        weakness: 0,
        leader: { score: 9, name: "x", id: 4 },
        target: null,
        source: null,
        retake: false,
        score: 1,
        prior: 1,
        bucket: "batch|r0|ff",
        at: T0,
      })!,
    );
    const r = fromJson(toJson(s), T0);
    expect(r.ok && r.state.queue[0].published).toBe(9.25);
    expect(r.ok && r.state.queue[0].tier).toBe("published");
    expect(r.ok && r.state.picks.offers).toEqual(s.picks.offers);
  });
});
