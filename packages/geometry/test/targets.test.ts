import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  LiteratureRecord,
  MAX_PIECES,
  ProblemId,
  SiteInfo,
  TARGET_WEIGHTS as W,
  TargetLeader,
  UNSOLVED_MAX_P,
  UNSOLVED_SHAPES,
  areaLowerBound,
  containerArea,
  improvementLikelihood,
  pieceArea,
  rankTargets,
  targetPriority,
  toothDepth,
} from "../src";

const lit = (N: number, M: number, P: number, value: number, extra: Partial<LiteratureRecord> = {}) =>
  ({
    N,
    M,
    P,
    value,
    display: String(value),
    display_precision: 6,
    status: "best_known",
    source_name: "test",
    source_url: "https://example.invalid",
    accessed: "2026-10-21",
    conversion_note: "none",
    ...extra,
  }) satisfies LiteratureRecord;

/** Site knowledge of one (N, M) pair: leaders and published values by P. */
const pair = (leaders: Record<number, number>, published: Record<number, number> = {}) => {
  return (p: ProblemId): SiteInfo | undefined => {
    const leader = leaders[p.P] ?? null;
    const pub = published[p.P] ?? null;
    return leader === null && pub === null ? undefined : { closed: false, published: pub, leader };
  };
};

/** toothDepth as first written for the batch runner, with a sort; the shared one must agree exactly. */
function toothDepthReference(p: ProblemId, info: (p: ProblemId) => SiteInfo | undefined): number | null {
  const own = info(p);
  if (!own || own.closed || own.leader === null) return null;
  if (own.published !== null) return null;
  const density = (P: number, size: number) => (P * pieceArea(p.N)) / containerArea(p.M, size);
  const w = Math.max(3, Math.ceil(0.04 * p.P));
  const around: number[] = [];
  for (let Q = Math.max(1, p.P - w); Q <= Math.min(MAX_PIECES, p.P + w); Q++) {
    if (Q === p.P) continue;
    const i = info({ N: p.N, M: p.M, P: Q });
    const record = Math.min(i?.leader ?? Infinity, i?.published ?? Infinity);
    if (Number.isFinite(record)) around.push(density(Q, record));
  }
  if (around.length < 2) return null;
  around.sort((a, b) => b - a);
  const target = around[1];
  const mine = density(p.P, own.leader);
  return mine >= target ? 0 : 1 - Math.sqrt(mine / target);
}

describe("toothDepth", () => {
  it("rates exactly as the sorted definition, repeated densities included", () => {
    // records drawn from a few values, so that equal densities are common
    const records = fc.array(fc.option(fc.constantFrom(3, 3.5, 4, 4.2, 5, 6), { nil: undefined }), {
      minLength: 60,
      maxLength: 60,
    });
    fc.assert(
      fc.property(records, fc.integer({ min: 1, max: 60 }), fc.constantFrom(0, 3, 4, 7), (list, P, N) => {
        const info = (p: ProblemId): SiteInfo | undefined => {
          const v = list[p.P - 1];
          return v === undefined ? undefined : { closed: false, published: p.P % 7 === 0 ? v : null, leader: v };
        };
        const p = { N, M: 4, P };
        expect(toothDepth(p, info)).toBe(toothDepthReference(p, info));
      }),
      { numRuns: 400 },
    );
  });
});

describe("targetPriority", () => {
  const p = (P: number, N = 4, M = 4) => ({ N, M, P });

  it("leaves out closed problems only", () => {
    expect(targetPriority(p(2), lit(4, 4, 2, 2, { status: "proven" }), pair({}))).toBeNull();
    expect(targetPriority(p(4), lit(4, 4, 4, 2, { status: "trivial_tiling" }), pair({}))).toBeNull();
    // an unrefereed proof leaves the problem open
    expect(targetPriority(p(5), lit(4, 4, 5, 2.707107, { status: "proven_unrefereed" }), pair({}))).not.toBeNull();
  });

  it("puts a problem without a leader or a published value first", () => {
    expect(targetPriority(p(1), null, pair({}))).toEqual({ reason: "unsolved", priority: W.unsolved });
    expect(targetPriority(p(499, 0, 12), null, pair({}))).toEqual({ reason: "unsolved", priority: W.unsolved });
  });

  it("rates a leader behind the published value by the relative gap, a tenth when the packing is drawn", () => {
    const info = pair({ 30: 6.2 });
    expect(targetPriority(p(30), lit(4, 4, 30, 6), info)).toEqual({
      reason: "behind_published",
      priority: (6.2 - 6) / 6.2,
    });
    const drawn = targetPriority(p(30), lit(4, 4, 30, 6, { pieces: [] }), info)!;
    expect(drawn.reason).toBe("behind_published");
    expect(drawn.priority).toBeCloseTo((W.drawnPublished * 0.2) / 6.2, 15);
    // no leader at all: the fixed gap
    expect(targetPriority(p(30), lit(4, 4, 30, 6), pair({}))).toEqual({
      reason: "behind_published",
      priority: W.missingLeaderGap,
    });
    expect(targetPriority(p(30), lit(4, 4, 30, 6, { pieces: [] }), pair({}))!.priority).toBeCloseTo(
      W.missingLeaderGap * W.drawnPublished,
      15,
    );
  });

  it("counts a leader within the printed precision of the published value as level with it", () => {
    const rec = lit(4, 4, 30, 6, { display_precision: 6 });
    const bound = areaLowerBound(4, 4, 30);
    const level = targetPriority(p(30), rec, pair({ 30: 6.0000004 }))!;
    expect(level.reason).toBe("slack");
    expect(level.priority).toBeCloseTo(improvementLikelihood(30) * (1 - bound / 6) * W.publishedSlackShare, 15);
    // a leader below the published value is the record, still rated as a published one
    const ahead = targetPriority(p(30), rec, pair({ 30: 5.9 }))!;
    expect(ahead.reason).toBe("slack");
    expect(ahead.priority).toBeCloseTo(improvementLikelihood(30) * (1 - bound / 5.9) * W.publishedSlackShare, 15);
  });

  it("names the largest estimate: a hair behind a drawn packing is slack", () => {
    // 6.000002 does not reach 6 at six decimals, but the gap is a third of a millionth
    const r = targetPriority(p(30), lit(4, 4, 30, 6, { pieces: [] }), pair({ 30: 6.000002 }))!;
    expect(r.reason).toBe("slack");
    expect(r.priority).toBeGreaterThan(W.drawnPublished * (0.000002 / 6.000002));
  });

  it("rates a site-only record by the deeper of its tooth and its share of slack, discounted for small P", () => {
    // squares in a square on the plain ceil(sqrt P) grid: P = 10 is a deep tooth (see toothDepth)
    const grid: Record<number, number> = {};
    for (let P = 1; P <= 40; P++) grid[P] = Math.ceil(Math.sqrt(P));
    const info = pair(grid);
    const ten = targetPriority(p(10), null, info)!;
    expect(ten.reason).toBe("tooth");
    expect(ten.priority).toBeCloseTo(improvementLikelihood(10) * toothDepth(p(10), info)!, 15);
    // P = 16 packs as densely as it can: only its slack is left, which is nil (a perfect tiling)
    const sixteen = targetPriority(p(16), null, info)!;
    expect(sixteen.reason).toBe("slack");
    expect(sixteen.priority).toBeLessThan(1e-15);
    // P = 15 in side 4 is level with its neighbours and keeps the slack estimate
    const fifteen = targetPriority(p(15), null, info)!;
    expect(toothDepth(p(15), info)).toBe(0);
    expect(fifteen).toEqual({
      reason: "slack",
      priority: improvementLikelihood(15) * (1 - areaLowerBound(4, 4, 15) / 4) * W.siteSlackShare,
    });
  });

  it("discounts small P", () => {
    expect(improvementLikelihood(W.likelyHalfP)).toBeCloseTo(0.5, 15);
    expect(improvementLikelihood(2)).toBeLessThan(0.01);
    expect(improvementLikelihood(200)).toBeGreaterThan(0.99);
    // the same slack of 10% weighs a hundred times less at P = 2 than at P = 200
    const alone = (P: number) => targetPriority(p(P, 0, 9), null, pair({ [P]: areaLowerBound(0, 9, P) / 0.9 }))!;
    expect(alone(2).reason).toBe("slack");
    expect(alone(2).priority).toBeCloseTo(improvementLikelihood(2) * 0.1 * W.siteSlackShare, 12);
    expect(alone(200).priority).toBeCloseTo(improvementLikelihood(200) * 0.1 * W.siteSlackShare, 12);
    expect(alone(200).priority / alone(2).priority).toBeCloseTo(100, 9);
  });

  it("keeps the weights in their intended order", () => {
    // unsolved above a missing leader, a missing leader above the same with a drawn packing
    expect(W.unsolved).toBeGreaterThan(W.missingLeaderGap);
    expect(W.missingLeaderGap * W.drawnPublished).toBeLessThan(W.missingLeaderGap);
    // a published record is ten times harder to beat than a site-only one
    expect(W.siteSlackShare / W.publishedSlackShare).toBe(10);
  });
});

describe("rankTargets", () => {
  const leader = (N: number, M: number, P: number, id: number, score: number): TargetLeader => ({ N, M, P, id, score });
  // outside the core box (N = 20), so that nothing else is listed for these shapes
  const records = [
    lit(20, 20, 1, 1, { status: "trivial_tiling", pieces: [{ x: 0, y: 0, theta: 0 }] }),
    lit(20, 20, 3, 3.5, { pieces: [] }),
    lit(20, 20, 4, 4),
    lit(20, 20, 6, 5, { status: "proven" }),
  ];
  const leaders = [
    leader(20, 20, 1, 11, 1), // a closed problem's entry is not shown
    leader(20, 20, 2, 12, 2.6),
    leader(20, 20, 3, 13, 3.6), // behind a drawn packing
    leader(20, 20, 4, 14, 4.4), // behind, nothing drawn
    leader(20, 20, 5, 15, 4.9),
    leader(20, 20, 6, 16, 4.8), // closed
  ];
  const outside = (t: { N: number }) => t.N === 20;

  it("lists every open problem with a leader or a published value, and the empty core box", () => {
    const ranking = rankTargets(leaders, records);
    const listed = ranking.select({ N: [20] });
    expect(listed.map((t) => t.P).sort()).toEqual([2, 3, 4, 5]);
    // every other problem is an unsolved one of the core box
    const box = UNSOLVED_SHAPES.length ** 2 * UNSOLVED_MAX_P;
    expect(ranking.size).toBe(4 + box);
    const rest = ranking.select({}).filter((t) => !outside(t));
    expect(rest).toHaveLength(box);
    expect(rest.every((t) => t.reason === "unsolved" && UNSOLVED_SHAPES.includes(t.N))).toBe(true);
  });

  it("fills each target from what is known", () => {
    const byP = new Map(
      rankTargets(leaders, records)
        .select({ N: [20] })
        .map((t) => [t.P, t]),
    );
    expect(byP.get(3)).toEqual({
      N: 20,
      M: 20,
      P: 3,
      reason: "behind_published",
      priority: targetPriority({ N: 20, M: 20, P: 3 }, records[1], pair({ 3: 3.6 }, { 3: 3.5 }))!.priority,
      leader: 3.6,
      leader_id: 13,
      published: 3.5,
      published_coordinates: true,
      area_bound: areaLowerBound(20, 20, 3),
    });
    expect(byP.get(4)).toMatchObject({
      reason: "behind_published",
      priority: (4.4 - 4) / 4.4,
      published_coordinates: false,
    });
    expect(byP.get(2)).toMatchObject({ leader: 2.6, leader_id: 12, published: null, published_coordinates: false });
    // an unsolved problem has nothing but its bound
    expect(rankTargets([], []).select({ N: [7], M: [9], maxP: 1 })).toEqual([
      {
        N: 7,
        M: 9,
        P: 1,
        reason: "unsolved",
        priority: W.unsolved,
        leader: null,
        leader_id: null,
        published: null,
        published_coordinates: false,
        area_bound: areaLowerBound(7, 9, 1),
      },
    ]);
  });

  it("orders by priority, then by smaller P, N and M", () => {
    const all = rankTargets(leaders, records).select({});
    for (let i = 1; i < all.length; i++) {
      const [a, b] = [all[i - 1], all[i]];
      const before = a.P - b.P || a.N - b.N || a.M - b.M;
      expect(a.priority > b.priority || (a.priority === b.priority && before < 0)).toBe(true);
    }
    // the unsolved problems tie, so they come by P, then N, then M
    expect(all.slice(0, 13).map((t) => `${t.N}/${t.M}/${t.P}`)).toEqual([
      ...[0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((M) => `0/${M}/1`),
      "3/0/1",
      "3/3/1",
    ]);
    // the same input in another order ranks the same
    expect(rankTargets([...leaders].reverse(), [...records].reverse()).select({})).toEqual(all);
  });

  it("filters by shapes and largest P, and stops at the limit", () => {
    const ranking = rankTargets(leaders, records);
    const some = ranking.select({ N: [0, 5], M: [3], maxP: 10, limit: 7 });
    expect(some).toHaveLength(7);
    expect(some.every((t) => [0, 5].includes(t.N) && t.M === 3 && t.P <= 10)).toBe(true);
    expect(ranking.select({ N: [0, 5], M: [3], maxP: 10 })).toHaveLength(20);
    expect(
      ranking
        .select({ N: [20], maxP: 3 })
        .map((t) => t.P)
        .sort(),
    ).toEqual([2, 3]);
    expect(ranking.select({ N: [13] })).toEqual([]);
    expect(ranking.select({ limit: 0 })).toEqual([]);
  });

  it("does not let a known core problem count as unsolved, and leaves out closed ones in the box", () => {
    const ranking = rankTargets([leader(4, 4, 2, 1, 2.1)], [lit(4, 4, 4, 2, { status: "trivial_tiling" })]);
    const squares = ranking.select({ N: [4], M: [4], maxP: 5 });
    expect(squares.map((t) => [t.P, t.reason])).toEqual([
      [1, "unsolved"],
      [3, "unsolved"],
      [5, "unsolved"],
      [2, "slack"],
    ]);
  });

  it("rates teeth against the published values of closed neighbours too", () => {
    // squares on the ceil(sqrt P) grid, 9 squares closed as a tiling of side 3: P = 10 is a tooth
    const grid = Array.from({ length: 30 }, (_, i) => leader(20, 4, i + 1, i + 1, Math.ceil(Math.sqrt(i + 1))));
    const closed = lit(20, 4, 9, 3, { status: "trivial_tiling" });
    const without = rankTargets(grid, []).select({ N: [20], M: [4], maxP: 11 });
    const withClosed = rankTargets(grid, [closed]).select({ N: [20], M: [4], maxP: 11 });
    expect(withClosed.map((t) => t.P)).not.toContain(9);
    const ten = (list: typeof without) => list.find((t) => t.P === 10)!;
    expect(ten(withClosed)).toEqual(ten(without));
  });
});
