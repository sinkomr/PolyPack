import { MAX_PIECES, containerArea, pieceArea } from "./shapes";

/**
 * Which problems are worth searching: the orders of the batch runner (scripts/batch-search.ts).
 * Pure: nothing here reads the store, the network or the clock.
 */

/** One problem: P pieces of shape N in a container of shape M. */
export interface ProblemId {
  N: number;
  M: number;
  P: number;
}

/** What the site knows about one problem, from GET /api/records?N=&M=. */
export interface SiteInfo {
  closed: boolean;
  /** Published value, if any. */
  published: number | null;
  /** Current site leader's score, if any. */
  leader: number | null;
}

/**
 * How deep a problem sits in a sawtooth: the fraction by which its record container would shrink
 * if it were packed as densely as its neighbours. Density is the pieces' area over the container's;
 * the neighbours are the P within max(3, 4%) on either side, and the target is the second-highest
 * density among them, so that one exceptional neighbour (a perfect tiling such as k^2 squares)
 * does not mark everything around it. Only problems with a site leader and no published value are
 * rated: a published value, matched or not, comes from long searches that a batch run will not
 * beat. Null when not rated.
 */
export function toothDepth(p: ProblemId, info: (p: ProblemId) => SiteInfo | undefined): number | null {
  const own = info(p);
  if (!own || own.closed || own.leader === null) return null;
  if (own.published !== null) return null;
  // density of Q pieces in a container of the given size: (Q * piece) / containerArea(M, size)
  const piece = pieceArea(p.N);
  const w = Math.max(3, Math.ceil(0.04 * p.P));
  // The highest and second-highest density around, as a sorted list's first two would be (a
  // repeated highest value is also the second). A batch order rates every problem, hence no sort
  // and no closure in this loop.
  let first = -Infinity;
  let target = -Infinity;
  let rated = 0;
  for (let Q = Math.max(1, p.P - w); Q <= Math.min(MAX_PIECES, p.P + w); Q++) {
    if (Q === p.P) continue;
    const i = info({ N: p.N, M: p.M, P: Q });
    const record = Math.min(i?.leader ?? Infinity, i?.published ?? Infinity);
    if (!Number.isFinite(record)) continue;
    const d = (Q * piece) / containerArea(p.M, record);
    rated++;
    if (d > first) {
      target = first;
      first = d;
    } else if (d > target) target = d;
  }
  if (rated < 2) return null;
  const mine = (p.P * piece) / containerArea(p.M, own.leader);
  return mine >= target ? 0 : 1 - Math.sqrt(mine / target);
}

/**
 * Priority class for missing-first: 0 when the site has neither a leader nor a published value
 * (nothing at all is known), 1 when the site has no leader or its leader is worse than the
 * published value (there is a known target the board does not show yet), 2 otherwise.
 */
export function missingClass(info: SiteInfo | undefined): 0 | 1 | 2 {
  const published = info?.published ?? null;
  const leader = info?.leader ?? null;
  if (leader === null && published === null) return 0;
  if (published !== null && (leader === null || leader > published)) return 1;
  return 2;
}
