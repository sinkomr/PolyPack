import { MAX_PIECES, areaLowerBound, closedToSubmissions } from "@polypack/geometry";
import type { ProblemInfo } from "@polypack/geometry";
import type { RecordsResponse } from "../api";
import { FRONTIER_P, FRONTIER_SIDES, ProblemKey, keyOf, poly } from "./frontier";
import type { Tier } from "./points";
import { Candidate, Filters, LOOSE_WEAKNESS, NEIGHBOURS, passes } from "./rank";

/**
 * The dealer: which problem the player gets next, and how often (design.md §5, §6).
 *
 * New problems are earned by work, not time: each queue slot is dealt one problem per DEAL_CLICKS
 * clicks, as a token bucket of `slots` tokens. Work counts in clicks (creditOf): the player's
 * evaluations at the player's click size, so an Evolve click is one click whatever its size, and
 * auto-eval's at AUTO_CLICK_EVALS to the click, so its rate earns problems at one pace whatever the
 * player's click size. Clicking faster, or auto-eval, brings the next problem sooner. The rate also
 * stands in for a server-side limit on new problems per address. Every problem is checked with
 * GET /api/problems just before it is dealt.
 *
 * What is dealt (plan 2026-10-20 §3): open problems of the frontier (and, with More open problems,
 * of every side from 21 to 100), and contested problems (N, M <= 20) from the site's records, by tier
 * (loose, batch, published) and down to the player's size ring. rank.ts judges the candidates.
 *
 * Pure apart from the random draws, which come from a seeded generator kept in the save, so a game
 * started with the same seed is dealt the same candidates.
 */
export const DEAL_CLICKS = 300;
/**
 * Auto-eval's evaluations earn deals as clicks of this many evaluations (K₀): the end of the click
 * ladder, about the click size of a player who buys Auto-advance and the lanes, so idle dealing keeps
 * the pace it had there, and a larger click no longer slows it.
 */
export const AUTO_CLICK_EVALS = 10;

export interface DealerState {
  /** Seed of the dealer's draws. */
  seed: number;
  /** Draws made so far; draw k uses the k-th value of the sequence. */
  draws: number;
  /** Problems dealt so far. */
  dealt: number;
  /** Deal tokens; a deal takes one. */
  tokens: number;
  /** Work done since `tokens` was last brought up to date, in clicks (creditOf). */
  credit: number;
}

export const newDealer = (seed: number): DealerState => ({
  seed: seed >>> 0,
  draws: 0,
  dealt: 0,
  tokens: 1,
  credit: 0,
});

/**
 * The clicks that `evaluations` count as: the player's at `perClick` evaluations to the click (an
 * Evolve click is one, Compact's 100 evaluations 100 / perClick), auto-eval's (null) at AUTO_CLICK_EVALS.
 */
export const creditOf = (evaluations: number, perClick: number | null) =>
  evaluations / (perClick === null ? AUTO_CLICK_EVALS : Math.max(1, perClick));

/** Work done, in clicks: the next refill turns it into tokens. */
export function earn(d: DealerState, clicks: number): void {
  if (clicks > 0) d.credit += clicks;
}

/** mulberry32, the solver's generator (seededRandom), one value at a time. */
export function mulberry32(state: number): number {
  let t = (state + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** The next uniform value in [0, 1) of the dealer's sequence. */
export function nextRandom(d: DealerState): number {
  const value = mulberry32((d.seed + Math.imul(d.draws, 0x9e3779b1)) >>> 0);
  d.draws++;
  return value;
}

/** Brings the tokens up to date with the work done: `slots` per DEAL_CLICKS clicks, at most `slots`. */
export function refill(d: DealerState, slots: number): void {
  d.tokens = Math.min(slots, d.tokens + (d.credit * slots) / DEAL_CLICKS);
  d.credit = 0;
}

export function canDeal(d: DealerState, slots: number): boolean {
  refill(d, slots);
  return d.tokens >= 1 - 1e-9;
}

/** Clicks still to do before the next token (0 when one is there), AUTO_CLICK_EVALS of auto-eval's evaluations to one. */
export function clicksToNextDeal(d: DealerState, slots: number): number {
  refill(d, slots);
  if (d.tokens >= 1 - 1e-9) return 0;
  // less a hair, so that a rounding error in the bucket does not show one click too many
  return Math.ceil(((1 - d.tokens) * DEAL_CLICKS) / slots - 1e-9);
}

/**
 * Takes one token for a problem dealt. A problem dealt without a token (the queue was empty, so the
 * player had nothing to work on) leaves the bucket in debt, repaid by the next evaluations.
 */
export function takeToken(d: DealerState): void {
  d.tokens -= 1;
  d.dealt++;
}

/** A random problem of `list` not in `exclude`, or null after `attempts` draws found none. */
export function drawProblem(
  d: DealerState,
  list: readonly ProblemKey[],
  exclude: ReadonlySet<string>,
  attempts = 24,
): ProblemKey | null {
  for (let i = 0; i < attempts; i++) {
    const p = list[Math.floor(nextRandom(d) * list.length)];
    if (p && !exclude.has(keyOf(p))) return p;
  }
  // The list is nearly used up: take the first one left, if any.
  return list.find((p) => !exclude.has(keyOf(p))) ?? null;
}

/**
 * Whether an open problem can be dealt, from GET /api/problems just before: it takes submissions,
 * has no site entry (someone may have taken it) and no published value.
 */
export function openDealable(info: ProblemInfo | null): boolean {
  return !!info && info.accepts_submissions && !info.site_best && !info.literature;
}

// ---------- the wider frontier ----------

/** The wider frontier (More open problems): every side from 21 to 100 and from 40 to 500 pieces. */
export const WIDE = { minSide: 21, maxSide: 100, minP: 40, maxP: MAX_PIECES } as const;

/** The values of one axis of the wider frontier that the filters allow, smallest first (a shape list, or null for every one). */
function wideValues(min: number, max: number, only: readonly number[] | null): number[] {
  const out: number[] = [];
  for (let v = min; v <= max; v++) if (!only || only.includes(v)) out.push(v);
  return out;
}

/**
 * A random problem of the wider frontier, the player's filters and `allow` permitting, not in `exclude`.
 * The filters are applied before drawing: each side comes from the allowed shapes within 21 to 100 and
 * the piece count from the allowed range within 40 to 500, so every allowed problem can be drawn. Null at
 * once when an axis has no allowed value.
 */
export function drawWide(
  d: DealerState,
  exclude: ReadonlySet<string>,
  allow: (p: ProblemKey) => boolean = () => true,
  attempts = 24,
  skew = 1,
  within: Filters | null = null,
): ProblemKey | null {
  const ns = wideValues(WIDE.minSide, WIDE.maxSide, within?.pieces ?? null);
  const ms = wideValues(WIDE.minSide, WIDE.maxSide, within?.containers ?? null);
  const ps = wideValues(Math.max(WIDE.minP, within?.minP ?? 0), Math.min(WIDE.maxP, within?.maxP ?? WIDE.maxP), null);
  if (!ns.length || !ms.length || !ps.length) return null;
  // skew > 1 leans each draw toward the smallest allowed value (smaller problems open quicker)
  const pick = (values: readonly number[]) => values[Math.floor(Math.pow(nextRandom(d), skew) * values.length)];
  for (let i = 0; i < attempts; i++) {
    const p = poly(pick(ns), pick(ms), pick(ps));
    if (!exclude.has(keyOf(p)) && allow(p)) return p;
  }
  return null;
}

// ---------- contested problems: site records and published values (N, M <= 20) ----------

/** Shapes of contested problems: circles and 3 to 20 sides (the site's own range). */
export const CONTESTED_SIDES: readonly number[] = [0, ...Array.from({ length: 18 }, (_, i) => i + 3)];

/**
 * A random (N, M) pair of contested shapes, the pieces among `pieces` and the container among
 * `containers` when given (the player's filters); null when no contested shape is allowed.
 */
export function drawContestedPair(
  d: DealerState,
  pieces: readonly number[] | null = null,
  containers: readonly number[] | null = null,
): { N: number; M: number } | null {
  const ns = pieces ? CONTESTED_SIDES.filter((n) => pieces.includes(n)) : CONTESTED_SIDES;
  const ms = containers ? CONTESTED_SIDES.filter((n) => containers.includes(n)) : CONTESTED_SIDES;
  if (!ns.length || !ms.length) return null;
  const N = ns[Math.floor(nextRandom(d) * ns.length)];
  const M = ms[Math.floor(nextRandom(d) * ms.length)];
  return { N, M };
}

// ---------- what the filters leave to deal ----------

/** Where a candidate can come from: open problems, contested problems (site records and published values), space problems. */
export type Source = "open" | "contested" | "space";

/** What the player has reached, as far as the sources go. */
export interface SourceReach {
  /** Contested tiers owned (empty without Reach: site records). */
  contested: ReadonlySet<Tier>;
  /** The smallest N+M+P of a contested problem (the size ring); Infinity before any ring. */
  ringMin: number;
  /** More open problems is owned. */
  wide: boolean;
  /** Some space slice is open. */
  space: boolean;
  /** The cycle's rule's own open problems, which replace the dealer's lists (standing.ts ruleOpenProblems); null without one. */
  ruled?: readonly ProblemKey[] | null;
}

/** Whether any of `values` (a shape list, null for all) lies among `shapes`. */
const anyShape = (only: readonly number[] | null, shapes: readonly number[]) =>
  !only || shapes.some((n) => only.includes(n));

/**
 * Which sources can give a problem that passes the filters, so that a draw is not spent on one that
 * cannot. Open problems: the cycle's rule's own list when it has one, else the frontier's list, or with
 * More open problems sides 21 to 100 and 40 to 500 pieces. Contested: an owned tier the filter allows, shapes of 0 or 3 to 20 sides, and a size the ring
 * allows. Space problems ignore the shape filters, so they stay possible whenever a slice is open.
 */
export function filterSources(f: Filters | null, reach: SourceReach): Record<Source, boolean> {
  const tierOk = (t: Tier) => !f?.tiers || f.tiers.includes(t);
  const minP = f?.minP ?? 1;
  const maxP = f?.maxP ?? MAX_PIECES;
  const shapesOk = (from: readonly number[]) =>
    anyShape(f?.pieces ?? null, from) && anyShape(f?.containers ?? null, from);
  const wideSides = Array.from({ length: WIDE.maxSide - WIDE.minSide + 1 }, (_, i) => WIDE.minSide + i);
  const open =
    tierOk("open") &&
    (reach.ruled
      ? reach.ruled.some((k) => passes(f, { ...k, tier: "open" }))
      : reach.wide
        ? shapesOk(wideSides) && Math.max(minP, WIDE.minP) <= Math.min(maxP, WIDE.maxP)
        : shapesOk(FRONTIER_SIDES) && FRONTIER_P.some((P) => P >= minP && P <= maxP));
  const tiers = [...reach.contested].filter(tierOk);
  const largest = (only: readonly number[] | null | undefined) =>
    Math.max(...CONTESTED_SIDES.filter((n) => !only || only.includes(n)));
  const contested =
    tiers.length > 0 &&
    shapesOk(CONTESTED_SIDES) &&
    largest(f?.pieces) + largest(f?.containers) + Math.min(maxP, MAX_PIECES) >= reach.ringMin;
  return { open, contested, space: reach.space };
}

/**
 * The odds of each possible source for one draw: today's proportions (a space share, then two in three
 * of the rest contested, the remainder open) among the sources left, which are then scaled to add up to 1.
 * Empty when none is possible.
 */
export function sourceOdds(can: Record<Source, boolean>, spaceShare: number): [Source, number][] {
  const base: [Source, number][] = [
    ["space", spaceShare],
    ["contested", (1 - spaceShare) * (2 / 3)],
    ["open", (1 - spaceShare) / 3],
  ];
  const left = base.filter(([s]) => can[s]);
  const total = left.reduce((t, [, w]) => t + w, 0);
  if (!left.length) return [];
  // a source with weight 0 (a share of 1 with nothing else left) still counts: share them equally
  return left.map(([s, w]) => [s, total > 0 ? w / total : 1 / left.length]);
}

/** The source a draw `r` in [0, 1) falls on, given the odds. */
export function pickSource(odds: readonly [Source, number][], r: number): Source | null {
  let x = r;
  for (const [s, w] of odds) {
    x -= w;
    if (x < 0) return s;
  }
  return odds.length ? odds[odds.length - 1][0] : null;
}

/** Gap to the area bound, s / b − 1. */
const gap = (N: number, M: number, P: number, score: number) => score / areaLowerBound(N, M, P) - 1;

function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * How much weaker each site record of one pair is than its neighbours: its gap less the median gap
 * of the pair's records at P − 3 … P + 3 (not P itself, nor records awaiting review). The area bound
 * is loose for few pieces, so raw gaps are not comparable across sizes; neighbours of similar size
 * are. Zero when a record has fewer than 2 neighbours.
 */
export function weaknesses(records: RecordsResponse): Map<number, number> {
  const { N, M } = records;
  const gaps = new Map<number, number>();
  for (const e of records.site) if (e.verification !== "pending" && e.P >= 2) gaps.set(e.P, gap(N, M, e.P, e.score));
  const out = new Map<number, number>();
  for (const [P, g] of gaps) {
    const near: number[] = [];
    for (let q = P - NEIGHBOURS; q <= P + NEIGHBOURS; q++) if (q !== P && gaps.has(q)) near.push(gaps.get(q)!);
    out.set(P, near.length >= 2 ? g - median(near) : 0);
  }
  return out;
}

/** The score a record must beat to beat a published value, as the server judges it (beatsLiterature). */
export const publishedTarget = (lit: { value: number; display_precision: number }) =>
  lit.value - Math.pow(10, -lit.display_precision);

export interface ContestedOptions {
  /** Smallest N+M+P dealt (the player's size rings). */
  ringMin: number;
  /** Tiers the player may be dealt (of loose, batch and published). */
  tiers: ReadonlySet<Tier>;
  /** Problems never to deal again (dealt before, in the queue, or found taken). */
  exclude: ReadonlySet<string>;
  /** Filters and the cycle's rule. */
  allow?: (c: Candidate) => boolean;
}

/**
 * The contested candidates of one (N, M) pair, from GET /api/records: its site records, each loose
 * (clearly weaker than its neighbours) or batch, and its best-known published values. Problems with
 * a published value are only ever published candidates; proven ones (closed) and records awaiting
 * review are never candidates. A published value is a candidate only when there is a packing to
 * start from: its coordinates, or a site record.
 */
export function contestedCandidates(records: RecordsResponse, opts: ContestedOptions): Candidate[] {
  const { N, M } = records;
  const weak = weaknesses(records);
  const lit = new Map(records.literature.map((r) => [r.P, r]));
  const site = new Map(records.site.map((e) => [e.P, e]));
  const out: Candidate[] = [];
  const consider = (c: Candidate) => {
    if (N + M + c.P < opts.ringMin || !opts.tiers.has(c.tier) || opts.exclude.has(keyOf(c))) return;
    if (opts.allow && !opts.allow(c)) return;
    out.push(c);
  };
  for (const e of records.site) {
    if (e.verification === "pending" || e.P < 2 || lit.has(e.P)) continue;
    const weakness = weak.get(e.P) ?? 0;
    consider({
      family: "polygon",
      N,
      M,
      P: e.P,
      tier: weakness >= LOOSE_WEAKNESS ? "loose" : "batch",
      weakness,
      leader: { score: e.score, name: e.name, id: e.id },
      target: null,
      source: null,
      retake: false,
    });
  }
  for (const r of records.literature) {
    // proven (closed) values are never dealt
    if (r.status !== "best_known" || r.P < 2) continue;
    const e = site.get(r.P);
    if (e?.verification === "pending") continue;
    if (!r.has_coordinates && !e) continue;
    consider({
      family: "polygon",
      N,
      M,
      P: r.P,
      tier: "published",
      weakness: null,
      leader: e ? { score: e.score, name: e.name, id: e.id } : null,
      target: publishedTarget(r),
      source: `${r.display} (${r.source_name})`,
      retake: false,
    });
  }
  return out;
}

/**
 * Whether a contested candidate is still as it was found, from GET /api/problems just before it is
 * dealt: open to submissions, the same leader (none, for a published value without a site record),
 * not awaiting review; a site record has no published value, a published value is still best known.
 */
export function contestedDealable(info: ProblemInfo | null, c: Candidate): boolean {
  if (!info || !info.accepts_submissions || closedToSubmissions(info.literature)) return false;
  if (info.site_best?.verification === "pending") return false;
  const sameLeader = c.leader ? info.site_best?.id === c.leader.id : !info.site_best;
  if (!sameLeader) return false;
  if (c.tier === "published") return info.literature?.status === "best_known";
  return !info.literature;
}

/**
 * The tier of a problem whose record the player lost (Retake): on contested shapes, classified as
 * any site record; on the frontier (a side above 20), a loose record [SPEC]: someone has been there
 * once, so there is room left.
 */
export function retakeTier(N: number, M: number, P: number, records: RecordsResponse | null): Tier {
  if (N > 20 || M > 20 || !records) return "loose";
  if (records.literature.some((r) => r.P === P)) return "published";
  return (weaknesses(records).get(P) ?? 0) >= LOOSE_WEAKNESS ? "loose" : "batch";
}
