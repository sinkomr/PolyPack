import type { LeadersAnswer } from "../api";
import { drawWide, nextRandom } from "./dealer";
import type { DealerState } from "./dealer";
import { ProblemKey, keyOf } from "./frontier";

/** Most candidates one /api/leaders request checks (the server's limit). */
export const BATCH = 200;
/** How long a key found taken is not asked about again. */
export const TAKEN_TTL_MS = 300_000;
/** Most batch requests one search makes per pool. */
const ROUNDS_PER_POOL = 2;

/** Where to look for open problems: a list, or the wide set (sides 21-100, 40 pieces up) leaning to small ones. */
export type Pool = { keys: readonly ProblemKey[] } | { wide: true; skew: number };

export interface FinderDeps {
  getLeaders: (keys: readonly string[]) => Promise<LeadersAnswer | null>;
  now: () => number;
}

/** Keys found taken (a leader or closed answers otherwise), kept for a few minutes. */
export class TakenCache {
  private at = new Map<string, number>();
  constructor(private now: () => number) {}
  add(key: string): void {
    this.at.set(key, this.now());
  }
  has(key: string): boolean {
    const t = this.at.get(key);
    if (t === undefined) return false;
    if (Math.abs(this.now() - t) >= TAKEN_TTL_MS) {
      this.at.delete(key);
      return false;
    }
    return true;
  }
}

/** N + M + P of a polygon problem (a space problem: its P). */
const smallness = (p: ProblemKey) => (p.family === "polygon" ? p.N + p.M + p.P : p.P);

/** Up to `max` distinct random members of `list` that `ok` accepts (a partial shuffle with the dealer's generator). */
function sample(d: DealerState, list: readonly ProblemKey[], ok: (p: ProblemKey) => boolean, max: number) {
  const pool = list.filter(ok);
  const n = Math.min(max, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(nextRandom(d) * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n);
}

function candidatesOf(d: DealerState, pool: Pool, ok: (p: ProblemKey) => boolean, exclude: ReadonlySet<string>) {
  if ("keys" in pool) return sample(d, pool.keys, ok, BATCH);
  const out = new Map<string, ProblemKey>();
  for (let i = 0; i < BATCH * 3 && out.size < BATCH; i++) {
    const k = drawWide(d, exclude, (p) => ok(p) && !out.has(keyOf(p)), 1, pool.skew);
    if (k) out.set(keyOf(k), k);
  }
  return [...out.values()];
}

export interface FindResult {
  /** Candidates whose leader is null: open, or closed (a single GET tells). Smallest first when asked, else in random order. */
  open: ProblemKey[];
  /** The server could not be reached. */
  offline: boolean;
  /** Requests made. */
  requests: number;
}

/**
 * Looks for open problems pool by pool, each round checking up to BATCH candidates in ONE request;
 * stops at the first round that finds any. Keys answered with a leader go into `taken`.
 */
export async function findOpen(
  deps: FinderDeps,
  d: DealerState,
  pools: readonly Pool[],
  opts: {
    exclude: ReadonlySet<string>;
    taken: TakenCache;
    allow?: (p: ProblemKey) => boolean;
    smallest?: boolean;
    /** Requests left to this search. */
    budget?: number;
  },
): Promise<FindResult> {
  const res: FindResult = { open: [], offline: false, requests: 0 };
  const budget = opts.budget ?? Infinity;
  const ok = (p: ProblemKey) => !opts.exclude.has(keyOf(p)) && !opts.taken.has(keyOf(p)) && (opts.allow?.(p) ?? true);
  for (const pool of pools)
    for (let round = 0; round < ROUNDS_PER_POOL; round++) {
      if (res.requests >= budget) return res;
      const cands = candidatesOf(d, pool, ok, opts.exclude);
      if (!cands.length) break;
      res.requests++;
      const answer = await deps.getLeaders(cands.map(keyOf));
      if (!answer) {
        res.offline = true;
        return res;
      }
      for (const k of cands) {
        const key = keyOf(k);
        const v = answer.leaders[key];
        if (v === null) res.open.push(k);
        else if (v !== undefined) opts.taken.add(key);
        // absent or unknown: not answered, so neither open nor remembered as taken
      }
      if (res.open.length) {
        if (opts.smallest) res.open.sort((a, b) => smallness(a) - smallness(b));
        return res;
      }
    }
  return res;
}

/** The pools of a first deal, in order: the starter corner, the rest of the frontier, then small problems of the wide set. */
export const firstDealPools = (starter: readonly ProblemKey[], frontier: readonly ProblemKey[]): Pool[] => [
  { keys: starter },
  { keys: frontier },
  { wide: true, skew: 2.5 },
];
