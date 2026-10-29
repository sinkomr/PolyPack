import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  LiteratureRecord,
  beatsLiterature,
  literatureTolerance,
  reachesLiterature,
  MAX_PIECES,
  ProblemId,
  SiteInfo,
  areaLowerBound,
  containerArea,
  pieceArea,
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

describe("the tolerance of a published value follows its conversion", () => {
  const rec = (N: number, M: number) =>
    ({ N, M, P: 5, value: 3, display_precision: 3 }) as Parameters<typeof literatureTolerance>[0] & { value: number };
  it("doubles for a polygon in a circle, whose value is the diameter, and stays for the rest", () => {
    expect(literatureTolerance(rec(4, 0))).toBe(0.002);
    expect(literatureTolerance(rec(0, 4))).toBe(0.001);
    expect(literatureTolerance(rec(0, 0))).toBe(0.001);
    expect(literatureTolerance(rec(4, 4))).toBe(0.001);
    expect(beatsLiterature(2.9985, rec(4, 0) as never)).toBe(false);
    expect(beatsLiterature(2.9985, rec(4, 4) as never)).toBe(true);
    expect(reachesLiterature(3.0015, rec(4, 0) as never)).toBe(true);
    expect(reachesLiterature(3.0015, rec(4, 4) as never)).toBe(false);
  });
});
