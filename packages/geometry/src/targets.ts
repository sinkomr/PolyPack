import { LiteratureRecord, Target, closedToSubmissions, reachesLiterature } from "./protocol";
import { MAX_PIECES, MAX_SIDES, areaLowerBound, containerArea, pieceArea } from "./shapes";

/**
 * Which problems are worth searching: the orders of the batch runner (scripts/batch-search.ts) and
 * the ranking behind GET /api/targets, the work list of volunteer searches. Pure: nothing here
 * reads the store, the network or the clock.
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
  // repeated highest value is also the second). The ranking rates every problem, hence no sort
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

/**
 * The weights of GET /api/targets. A priority estimates the fraction by which a problem's record
 * could still shrink, times how likely a long search is to get there and how much the site gains
 * when it does; several estimates can apply to one problem, and the largest is its priority
 * (see targetPriority). The values were set on 2026-10-21 from a sample of the live site: 20 pairs
 * of the core box, 14 with published values and 6 without, every P of each [CALC].
 */
export const TARGET_WEIGHTS = {
  /**
   * A problem with neither a site leader nor a published value: any valid packing becomes its
   * record and its first drawing. Counted as a 10% shrink, which puts it above every estimate
   * below in practice: in the sample none exceeded 6.5%.
   */
  unsolved: 0.1,
  /**
   * A published value without a site leader counts as a leader this far behind it: half as
   * valuable as an unsolved problem, since the value is known and only the site's own entry is
   * missing.
   */
  missingLeaderGap: 0.05,
  /**
   * Catching up with a published value whose coordinates the atlas already draws only fills the
   * site's own table; without coordinates, the entry is the first drawing of that packing. The
   * first gains a tenth of the second.
   */
  drawnPublished: 0.1,
  /**
   * Share of a site-only record's slack (its distance from the area bound) that a long search is
   * expected to recover. Where there are published values, the site's leaders from P = 20 on were
   * a median 0.06% to 0.4% above them (by range of P), against a median slack of about 8% for the
   * records of the families without published values [CALC]: about a twentieth.
   */
  siteSlackShare: 0.05,
  /**
   * The same for a record at least as good as a published value, which long dedicated searches
   * produced: ten times less likely to be beaten [SPEC].
   */
  publishedSlackShare: 0.005,
  /**
   * Below this P an improvement of a record is judged less than half as likely: the likelihood is
   * P² / (P² + likelyHalfP²). Few pieces leave little to find: below P = 20 the site's leaders were
   * a median of at most 0.01% above the published values, and the deepest teeth at P ≤ 10 come
   * from density that few pieces cannot reach at all (two circles in a nonagon sit 14% "below"
   * their neighbours) [CALC].
   */
  likelyHalfP: 20,
} as const;

/** The core box whose problems without a leader or a published value are listed as unsolved. */
export const UNSOLVED_SHAPES: readonly number[] = [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
/**
 * The core box is listed whole, up to the largest P. The batch runs populated exactly this box
 * (docs/AUTOMATION.md), and on 2026-10-21 no problem of the 20 core pairs sampled lacked both a
 * leader and a published value [CALC], so a hole in it is a lost or removed entry, worth filling
 * first. It adds at most 11 × 11 × 500 = 60,500 candidates to the ranking.
 */
export const UNSOLVED_MAX_P = MAX_PIECES;

/** How likely a long search is to improve a record of P pieces; see TARGET_WEIGHTS.likelyHalfP. */
export function improvementLikelihood(P: number): number {
  const h = TARGET_WEIGHTS.likelyHalfP;
  return (P * P) / (P * P + h * h);
}

export type TargetReason = Target["reason"];

/**
 * The priority of one open problem and the estimate it comes from. `lit` is the problem's
 * published record, if any; `info` gives the site's knowledge of it and of its neighbours in P
 * (for toothDepth). The estimates, of which the largest wins (on a tie, the earlier in this list):
 *  - "slack": the record's distance from the area bound, 1 - bound / record, times the share a
 *    search is expected to recover (siteSlackShare, or publishedSlackShare once a published value
 *    exists) and the likelihood for P;
 *  - "tooth": toothDepth times the likelihood for P;
 *  - "behind_published": when the leader is missing or does not reach the published value, the
 *    relative gap (leader - published) / leader (missingLeaderGap without a leader), times
 *    drawnPublished when the published value has coordinates;
 *  - "unsolved": without a leader and a published value, the constant TARGET_WEIGHTS.unsolved.
 * Null for a closed problem, whose optimum is proven.
 */
export function targetPriority(
  p: ProblemId,
  lit: LiteratureRecord | null,
  info: (p: ProblemId) => SiteInfo | undefined,
): { reason: TargetReason; priority: number } | null {
  if (closedToSubmissions(lit)) return null;
  const leader = info(p)?.leader ?? null;
  const W = TARGET_WEIGHTS;
  if (leader === null && !lit) return { reason: "unsolved", priority: W.unsolved };
  const likely = improvementLikelihood(p.P);
  const record = Math.min(leader ?? Infinity, lit?.value ?? Infinity);
  const slack = Math.max(0, 1 - areaLowerBound(p.N, p.M, p.P) / record);
  let reason: TargetReason = "slack";
  let priority = likely * slack * (lit ? W.publishedSlackShare : W.siteSlackShare);
  const tooth = toothDepth(p, info);
  if (tooth !== null && likely * tooth > priority) {
    reason = "tooth";
    priority = likely * tooth;
  }
  if (lit && (leader === null || !reachesLiterature(leader, lit))) {
    const gap = leader === null ? W.missingLeaderGap : (leader - lit.value) / leader;
    const behind = gap * (lit.pieces ? W.drawnPublished : 1);
    if (behind > priority) {
      reason = "behind_published";
      priority = behind;
    }
  }
  return { reason, priority };
}

/** A problem's leader as the ranking takes it: its submission id and score. */
export interface TargetLeader extends ProblemId {
  id: number;
  score: number;
}

/** Which ranked problems one request asks for. */
export interface TargetFilter {
  /** Piece shapes to keep; all when absent. */
  N?: readonly number[];
  /** Container shapes to keep; all when absent. */
  M?: readonly number[];
  /** Largest P to keep. */
  maxP?: number;
  /** Most targets returned. */
  limit?: number;
}

const REASONS: readonly TargetReason[] = ["unsolved", "behind_published", "tooth", "slack"];
const SHAPE_CODES = MAX_SIDES + 1;

/**
 * Every open problem worth listing, ranked, in columns rather than objects: for 200,000 problems
 * Target objects would take about 32 MB of heap, the columns 11 MB [CALC]. `select` builds the
 * objects of the problems one request asks for.
 */
export class TargetRanking {
  /** Number of problems ranked. */
  readonly size: number;

  /** @internal Use rankTargets. Columns are indexed by candidate; `order` lists them by rank. */
  constructor(
    private readonly cols: {
      N: Uint8Array;
      M: Uint8Array;
      P: Uint16Array;
      reason: Uint8Array;
      priority: Float64Array;
      /** NaN for null, here and in the next two. */
      leader: Float64Array;
      leaderId: Float64Array;
      published: Float64Array;
      coordinates: Uint8Array;
    },
    private readonly order: Uint32Array,
  ) {
    this.size = order.length;
  }

  /** The highest-ranked problems that pass the filter, highest priority first. */
  select(filter: TargetFilter = {}): Target[] {
    const { N, M, P } = this.cols;
    const mask = (codes: readonly number[] | undefined) => {
      if (!codes) return null;
      const keep = new Uint8Array(SHAPE_CODES);
      for (const c of codes) if (c >= 0 && c < SHAPE_CODES) keep[c] = 1;
      return keep;
    };
    const keepN = mask(filter.N);
    const keepM = mask(filter.M);
    const maxP = filter.maxP ?? MAX_PIECES;
    const limit = filter.limit ?? Infinity;
    const out: Target[] = [];
    for (let r = 0; r < this.order.length && out.length < limit; r++) {
      const i = this.order[r];
      if (P[i] > maxP || (keepN && !keepN[N[i]]) || (keepM && !keepM[M[i]])) continue;
      out.push(this.target(i));
    }
    return out;
  }

  private target(i: number): Target {
    const c = this.cols;
    const orNull = (v: number) => (Number.isNaN(v) ? null : v);
    return {
      N: c.N[i],
      M: c.M[i],
      P: c.P[i],
      reason: REASONS[c.reason[i]],
      priority: c.priority[i],
      leader: orNull(c.leader[i]),
      leader_id: orNull(c.leaderId[i]),
      published: orNull(c.published[i]),
      published_coordinates: c.coordinates[i] === 1,
      area_bound: areaLowerBound(c.N[i], c.M[i], c.P[i]),
    };
  }
}

/**
 * Ranks the open problems for GET /api/targets: every problem with a site leader or a published
 * value, and the problems of the core box (UNSOLVED_SHAPES, P up to UNSOLVED_MAX_P) with neither.
 * Closed problems are left out, and so are the leaders of closed problems, which the site does not
 * show; their published values still count as neighbours for toothDepth. Ordered by priority
 * (targetPriority), highest first, then by smaller P, N and M.
 */
export function rankTargets(leaders: Iterable<TargetLeader>, records: readonly LiteratureRecord[]): TargetRanking {
  interface Known extends SiteInfo {
    lit: LiteratureRecord | null;
    id: number | null;
  }
  // what is known of each problem, by (N, M) pair and then by P
  const pairs = new Map<number, (Known | undefined)[]>();
  let count = 0;
  const slot = (N: number, M: number) => {
    let list = pairs.get(N * SHAPE_CODES + M);
    if (!list) pairs.set(N * SHAPE_CODES + M, (list = new Array<Known | undefined>(MAX_PIECES + 1)));
    return list;
  };
  for (const r of records) {
    slot(r.N, r.M)[r.P] = { closed: closedToSubmissions(r), published: r.value, leader: null, id: null, lit: r };
    count++;
  }
  for (const l of leaders) {
    const list = slot(l.N, l.M);
    const k = list[l.P];
    if (!k) {
      list[l.P] = { closed: false, published: null, leader: l.score, id: l.id, lit: null };
      count++;
    } else if (!k.closed) {
      k.leader = l.score;
      k.id = l.id;
    }
  }
  // toothDepth asks for the neighbours of one problem in turn, all of the same pair
  let lastPair = -1;
  let lastList: (Known | undefined)[] | undefined;
  const info = (p: ProblemId) => {
    const pair = p.N * SHAPE_CODES + p.M;
    if (pair !== lastPair) {
      lastPair = pair;
      lastList = pairs.get(pair);
    }
    return lastList?.[p.P];
  };

  const capacity = count + UNSOLVED_SHAPES.length ** 2 * UNSOLVED_MAX_P;
  const cols = {
    N: new Uint8Array(capacity),
    M: new Uint8Array(capacity),
    P: new Uint16Array(capacity),
    reason: new Uint8Array(capacity),
    priority: new Float64Array(capacity),
    leader: new Float64Array(capacity),
    leaderId: new Float64Array(capacity),
    published: new Float64Array(capacity),
    coordinates: new Uint8Array(capacity),
  };
  let n = 0;
  const add = (p: ProblemId, k: Known | undefined) => {
    const rated = targetPriority(p, k?.lit ?? null, info);
    if (!rated) return;
    cols.N[n] = p.N;
    cols.M[n] = p.M;
    cols.P[n] = p.P;
    cols.reason[n] = REASONS.indexOf(rated.reason);
    cols.priority[n] = rated.priority;
    cols.leader[n] = k?.leader ?? NaN;
    cols.leaderId[n] = k?.id ?? NaN;
    cols.published[n] = k?.lit?.value ?? NaN;
    cols.coordinates[n] = k?.lit?.pieces ? 1 : 0;
    n++;
  };
  for (const [pair, list] of pairs) {
    const N = Math.floor(pair / SHAPE_CODES);
    const M = pair % SHAPE_CODES;
    for (let P = 1; P <= MAX_PIECES; P++) {
      const k = list[P];
      if (k && !k.closed) add({ N, M, P }, k);
    }
  }
  for (const N of UNSOLVED_SHAPES)
    for (const M of UNSOLVED_SHAPES) {
      const list = pairs.get(N * SHAPE_CODES + M);
      for (let P = 1; P <= UNSOLVED_MAX_P; P++) if (!list?.[P]) add({ N, M, P }, undefined);
    }

  const { N, M, P, priority } = cols;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => priority[b] - priority[a] || P[a] - P[b] || N[a] - N[b] || M[a] - M[b]);
  return new TargetRanking(cols, order);
}
