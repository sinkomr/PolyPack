/**
 * Pure parts of the batch runner (scripts/batch-search.ts): option parsing, the problem set and its
 * order, resume keys, the submission pacer and summary statistics. Nothing here touches the
 * network, the file system or the clock, so it is unit tested in scripts/test/batch-search.test.ts.
 */
import {
  type LeaderboardEntry,
  type LiteratureRecord,
  MAX_METHOD_PARAMS_BYTES,
  MAX_PIECES,
  MAX_SIDES,
  type PackingConfig,
  closedToSubmissions,
  utf8Length,
} from "@polypack/geometry";

export interface Problem {
  N: number;
  M: number;
  P: number;
}

export interface Budget {
  evals: number;
  time_s: number;
}

/**
 * The body of POST /api/submit for a problem's best run: the packing, the display name, how it was
 * found (the method, its resolved parameters, the seed and the budget) and the user's note, which
 * is sent only when one was given. Parameters larger than the server accepts are left out.
 */
export function submissionBody(
  best: { config: PackingConfig; method: string; params?: Record<string, unknown>; seed: number; budget: Budget },
  name: string,
  note: string,
): Record<string, unknown> {
  const { N, M, P, pieces, container_phi } = best.config;
  const params =
    best.params && utf8Length(JSON.stringify(best.params)) <= MAX_METHOD_PARAMS_BYTES ? best.params : undefined;
  return {
    N,
    M,
    P,
    pieces,
    container_phi,
    name,
    ...(note ? { agent_note: note.slice(0, 200) } : {}),
    found_with: "optimizer",
    method: best.method,
    ...(params ? { method_params: params } : {}),
    seed: best.seed,
    budget: { evals: best.budget.evals, time_s: best.budget.time_s },
  };
}

/** Shape codes: 0 (circle) and 3..MAX_SIDES. */
export const ALL_SHAPES: readonly number[] = [0, ...Array.from({ length: MAX_SIDES - 2 }, (_, i) => i + 3)];
export const ALL_PIECE_COUNTS: readonly number[] = Array.from({ length: MAX_PIECES }, (_, i) => i + 1);

/**
 * Parse "0,3-6,12" into the sorted distinct integers it names. Every value must lie in
 * [min, max] and, when `allowed` is given, belong to it (shape codes skip 1 and 2).
 * Throws an Error with a readable message otherwise.
 */
export function parseIntList(
  text: string,
  what: string,
  min: number,
  max: number,
  allowed?: (v: number) => boolean,
): number[] {
  const out = new Set<number>();
  const parts = text.split(",").map((s) => s.trim());
  if (parts.some((s) => s === "")) throw new Error(`--${what}: empty item in "${text}"`);
  for (const part of parts) {
    const m = /^(\d{1,6})(?:-(\d{1,6}))?$/.exec(part);
    if (!m) throw new Error(`--${what}: "${part}" is not an integer or a range a-b`);
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (hi < lo) throw new Error(`--${what}: range "${part}" is reversed`);
    if (lo < min || hi > max) throw new Error(`--${what}: "${part}" is outside ${min}..${max}`);
    for (let v = lo; v <= hi; v++) if (!allowed || allowed(v)) out.add(v);
  }
  if (out.size === 0) throw new Error(`--${what}: "${text}" names no allowed value`);
  return [...out].sort((a, b) => a - b);
}

export const isShape = (v: number) => v === 0 || (v >= 3 && v <= MAX_SIDES);
export const parseShapes = (text: string, what: "N" | "M") => parseIntList(text, what, 0, MAX_SIDES, isShape);
export const parsePieceCounts = (text: string) => parseIntList(text, "P", 1, MAX_PIECES);

/** Seeded generator (mulberry32, the same one as the solver's seededRandom). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle of a copy, driven by `random`. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** All problems of the cross product, in N, M, P order. */
export function crossProblems(Ns: readonly number[], Ms: readonly number[], Ps: readonly number[]): Problem[] {
  const out: Problem[] = [];
  for (const N of Ns) for (const M of Ms) for (const P of Ps) out.push({ N, M, P });
  return out;
}

/**
 * K distinct problems drawn uniformly from the cross product, reproducibly from `seed`. Drawing by
 * rejection keeps memory proportional to K even for the full ranges (99 x 99 x 500 problems).
 */
export function sampleProblems(
  K: number,
  seed: number,
  Ns: readonly number[],
  Ms: readonly number[],
  Ps: readonly number[],
): Problem[] {
  const total = Ns.length * Ms.length * Ps.length;
  if (K >= total) return crossProblems(Ns, Ms, Ps);
  const random = mulberry32(seed);
  const seen = new Set<string>();
  const out: Problem[] = [];
  while (out.length < K) {
    const p = {
      N: Ns[Math.floor(random() * Ns.length)],
      M: Ms[Math.floor(random() * Ms.length)],
      P: Ps[Math.floor(random() * Ps.length)],
    };
    const key = problemKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export const problemKey = (p: Problem) => `${p.N}-${p.M}-${p.P}`;
export const pairKey = (N: number, M: number) => `${N}-${M}`;

/**
 * The resume key of one run. Two runs with the same key are the same experiment, so a later
 * invocation skips it. The budget is part of the key: a longer budget is a new experiment.
 */
export function runKey(p: Problem, method: string, seed: number, budget: Budget): string {
  return `${problemKey(p)}|${method}|${seed}|${budget.evals}|${budget.time_s}`;
}

/** What the site knows about one problem, from GET /api/records?N=&M=. */
export interface SiteInfo {
  closed: boolean;
  /** Published value, if any. */
  published: number | null;
  /** Current site leader's score, if any. */
  leader: number | null;
}

export interface RecordsResponse {
  N: number;
  M: number;
  literature: Omit<LiteratureRecord, "pieces">[];
  site: (LeaderboardEntry & { P: number })[];
}

/** Per-P site information of one (N, M) pair. */
export function siteInfoByP(body: RecordsResponse): Map<number, SiteInfo> {
  const out = new Map<number, SiteInfo>();
  const get = (P: number) => {
    let v = out.get(P);
    if (!v) out.set(P, (v = { closed: false, published: null, leader: null }));
    return v;
  };
  for (const lit of body.literature ?? []) {
    const v = get(lit.P);
    v.published = lit.value;
    v.closed = closedToSubmissions(lit as LiteratureRecord);
  }
  for (const entry of body.site ?? []) get(entry.P).leader = entry.score;
  return out;
}

export type Order = "missing-first" | "smallest-first" | "random";
export const ORDERS: readonly Order[] = ["missing-first", "smallest-first", "random"];

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

const bySize = (a: Problem, b: Problem) => a.P - b.P || a.N - b.N || a.M - b.M;

/** Order the problems for searching; `info` gives the site's knowledge of each. */
export function orderProblems(
  problems: readonly Problem[],
  order: Order,
  info: (p: Problem) => SiteInfo | undefined,
  seed = 1,
): Problem[] {
  if (order === "random") return shuffled(problems, mulberry32(seed));
  if (order === "smallest-first") return [...problems].sort(bySize);
  return [...problems].sort((a, b) => missingClass(info(a)) - missingClass(info(b)) || bySize(a, b));
}

/**
 * Keeps the rate of submissions at or below `limit` per `windowMs`, over a sliding window, across
 * every caller: acquisitions are served one at a time in call order. `block(ms)` holds all
 * submissions back, e.g. after the server answered 429. The clock and sleep are injected so that a
 * test can drive the pacer with a fake clock.
 */
export class Pacer {
  private sent: number[] = [];
  private blockedUntil = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  /** Milliseconds to wait before the next submission may be sent. */
  delay(): number {
    const t = this.now();
    while (this.sent.length && this.sent[0] <= t - this.windowMs) this.sent.shift();
    let d = Math.max(0, this.blockedUntil - t);
    if (this.sent.length >= this.limit) d = Math.max(d, this.sent[this.sent.length - this.limit] + this.windowMs - t);
    return d;
  }

  block(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }

  /** Resolves when one submission may be sent and counts it as sent. Rejects if `sleep` rejects. */
  acquire(): Promise<void> {
    const turn = this.chain.then(async () => {
      for (let d = this.delay(); d > 0; d = this.delay()) await this.sleep(d);
      this.sent.push(this.now());
    });
    this.chain = turn.catch(() => {});
    return turn;
  }
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const a = [...values].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** "1h02m", "4m05s", "12s". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "?";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

/** Per-method statistics for the progress line and the closing summary. */
export class MethodStats {
  runs = 0;
  ratios: number[] = [];
  wall: number[] = [];
  bests = 0;
}

export function summaryTable(stats: ReadonlyMap<string, MethodStats>): string {
  const rows = [["method", "runs", "median ratio", "bests", "median wall s"]];
  for (const [name, s] of stats) {
    const r = median(s.ratios);
    const w = median(s.wall);
    rows.push([
      name,
      String(s.runs),
      r === null ? "-" : `${r.toFixed(6)} (n=${s.ratios.length})`,
      String(s.bests),
      w === null ? "-" : w.toFixed(2),
    ]);
  }
  const widths = rows[0].map((_, c) => Math.max(...rows.map((row) => row[c].length)));
  return rows
    .map((row) => row.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join("  "))
    .join("\n");
}
