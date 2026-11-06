import { archiveOf } from "./archive";
import { parseDealtKey } from "./catalogue";
import { ballsProblemOf } from "@polypack/balls/catalogue";
import { SOLID_NAMES_LIST, pluralTitle, problemNameOf } from "@polypack/polyhedra/catalogue";
import { solidTitle } from "../spaces-model";
import { spaceFields } from "./families";
import { DimensionId, ProblemKey, familyDimension, isPolygon, parseKey, shapeName } from "./frontier";
import type { GameState, PastProblem, ProblemState } from "./game";
import { income } from "./income";
import { COMBO_RECORDS } from "./points";
import { RENT_CLASSES, rentClassFactor, ruleRewardFactor, standingMultiplier } from "./standing";
import { level } from "./upgrades";
import type { Owned } from "./upgrades";

/**
 * Records as an economy (plan §5).
 *
 * **Rent.** Every record the player still leads pays by the hour: 1 % of the record points that
 * problem earned (before multipliers), × 1.5 a level of Higher rent, × today's points multiplier
 * [SPEC]. Rent accrues between paydays; every day at noon, local time (payday.ts), the game asks the server
 * about every record held in batches (GET /api/leaders). When every batch has answered, a record still held
 * pays the rent since the last payday, or since it became the player's if that was later, at most a week of
 * it; one found lost, by that or by a live event, pays nothing for the unsettled time. The server says who
 * leads, so rent needs no other trust. What a record earned (its base) lives on the record itself.
 *
 * **Collections**, counted from records the server confirmed and kept through resets: every
 * combination of a piece shape and a container shape with 9 records, of any sides and piece counts
 * (+2 % to all points each), 10, 30 and 100 records with one piece shape (+1 % each), the first
 * record in each tier (+5 % each).
 */

export interface EconomyState {
  /** Keys of every problem where the server confirmed a record of the player's (collections count these). */
  recorded: string[];
  /** Tiers with a confirmed record (tier firsts). */
  tiers: string[];
  /** Rent paid in all. */
  rentPaid: number;
  /** The last rent paid, for the panel. */
  lastRent: { key: string; rp: number; at: number } | null;
  /** When the next payday is due (epoch ms), while Rent is owned. Missing: one payday at the next load. */
  paydayAt?: number;
  /** The end of the last paid window (epoch ms): the last payday, or when Rent was bought. Records pay from here. */
  paidUntil?: number;
}

export const newEconomy = (): EconomyState => ({
  recorded: [],
  tiers: [],
  rentPaid: 0,
  lastRent: null,
});

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isKey = (k: unknown): k is string => typeof k === "string" && parseDealtKey(k) !== null;

/** Most problems remembered as recorded. */
export const RECORDED_LIMIT = 20000;
export const TIERS = ["open", "loose", "batch", "published"] as const;

export function normalizeEconomy(v: unknown): EconomyState {
  const d = newEconomy();
  if (!isObj(v)) return d;
  const last = isObj(v.lastRent) ? v.lastRent : null;
  return {
    recorded: Array.isArray(v.recorded) ? [...new Set(v.recorded.filter(isKey))].slice(-RECORDED_LIMIT) : [],
    tiers: Array.isArray(v.tiers)
      ? [...new Set(v.tiers.filter((t): t is string => typeof t === "string" && t.length <= 20))].slice(0, 20)
      : [],
    rentPaid: typeof v.rentPaid === "number" && Number.isFinite(v.rentPaid) && v.rentPaid >= 0 ? v.rentPaid : 0,
    lastRent:
      last && isKey(last.key) && typeof last.rp === "number" && last.rp >= 0 && typeof last.at === "number"
        ? { key: last.key, rp: last.rp, at: last.at }
        : null,
    ...(typeof v.paydayAt === "number" && Number.isFinite(v.paydayAt) && v.paydayAt >= 0
      ? { paydayAt: v.paydayAt }
      : {}),
    ...(typeof v.paidUntil === "number" && Number.isFinite(v.paidUntil) && v.paidUntil >= 0
      ? { paidUntil: v.paidUntil }
      : {}),
  };
}

// ---------- collections ----------

export interface Collections {
  /** Pairings (a piece shape in a container shape, in one Dimension) with at least COMBO_RECORDS records. */
  combos: number;
  /** The pairings closest to COMBO_RECORDS without reaching it, most records first: up to three. `label` is "21-gons in a 24-gon" or "cubes in a tetrahedron". */
  nearest: { label: string; have: number }[];
  /** Piece shapes per Dimension with records, and the milestones (10, 30, 100) each has reached. `label` is the plural of the shape, with its Dimension when the records span several. */
  shapes: { label: string; count: number; milestones: number }[];
  milestones: number;
  /** Tiers with a first record. */
  tiers: string[];
  /** What it adds to all points (0.02 a pairing, 0.01 a milestone, 0.05 a tier first). */
  bonus: number;
}

export { COMBO_RECORDS };
export const COMBO_BONUS = 0.02;
export const SHAPE_BONUS = 0.01;
export const TIER_BONUS = 0.05;
export const SHAPE_MILESTONES = [10, 30, 100] as const;

/** Collections are counted at every paid click: kept per list of records until it changes. */
const memo = new WeakMap<string[], { key: string; value: Collections }>();

const DIMENSION_NAME: Record<DimensionId, string> = { "2-in-2": "2D in 2D", "2-on-3": "2D on 3D", "3-in-3": "3D in 3D", "3-on-4": "3D on 4D" };
const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
const article = (t: string) => (/^[aeiou8]|^1[18]-/.test(t) ? `an ${t}` : `a ${t}`);
const SOLID_TITLE = new Map(SOLID_NAMES_LIST.map((s) => [s.name, s.title]));
const TORUS_NAMES = { sq: "square torus", hex: "hexagonal torus", free: "free-lattice torus" } as const;
/** "cubes", "triangular prisms of height 1.5", "balls". */
const solidPlural = (name: string) => (name === "ball" ? "balls" : lowerFirst(pluralTitle(SOLID_TITLE.get(name) ?? name)));

/**
 * A pairing: the Dimension, the piece shape and the container shape of a problem, whatever its P.
 * `piece` and `container` are ids that keep the shapes of different families apart; `pieceLabel`
 * and `label` read them.
 *
 * What the container is, per family (the id's other fields, P and the mode, do not count):
 *  - polygon: the M-gon (or circle); curved: the M-gon or disk of the domain, whatever its curvature K
 *    (K is a setting of the domain, as the fold mode is of a surface; with K a pairing would split into 10);
 *  - surface: the solid, folded or not (the game deals no unfolded ones that equal 2D in 2D);
 *  - sphere: the sphere; torus: the lattice (square, hexagonal, free);
 *  - polyhedra: the container solid; balls: the container ball or solid.
 * A piece is an N-gon (N = 0: a disk) in the first four, a solid or a ball in the last two.
 */
export interface Pairing {
  dimension: DimensionId;
  piece: string;
  container: string;
  pieceLabel: string;
  label: string;
}

const gons = (N: number) => shapeName(N, true);
const polygonContainer = (M: number) => article(shapeName(M, false));

/** The pairing of a problem, or null for an id that names none (a solid or a code the catalogues do not know). */
export function pairingOf(p: ProblemKey): Pairing | null {
  const dimension = familyDimension(p.family);
  const make = (piece: string, container: string, pieceLabel: string, label: string): Pairing => ({
    dimension,
    piece,
    container,
    pieceLabel,
    label,
  });
  if (isPolygon(p))
    return make(`${p.N}`, `p${p.M}`, gons(p.N), `${gons(p.N)} in ${polygonContainer(p.M)}`);
  const f = spaceFields(p.id);
  if (!f || f.family !== p.family) return null;
  switch (f.family) {
    case "surface":
      return make(`${f.N}`, `s${f.solid}`, gons(f.N), `${gons(f.N)} on ${article(solidTitle(f.solid))}`);
    case "curved":
      return make(`${f.N}`, `c${f.M}`, gons(f.N), `${gons(f.N)} in ${polygonContainer(f.M)}`);
    case "sphere":
      return make(`${f.N}`, "sphere", gons(f.N), `${gons(f.N)} on a sphere`);
    case "torus":
      return make(`${f.N}`, `t${f.lattice}`, gons(f.N), `${gons(f.N)} on ${article(TORUS_NAMES[f.lattice])}`);
    case "polyhedra": {
      const n = problemNameOf(f.code);
      return n ? make(`b${n.piece}`, `b${n.container}`, solidPlural(n.piece), lowerFirst(n.title)) : null;
    }
    case "balls": {
      const n = ballsProblemOf(f.code);
      return n ? make(`b${n.piece}`, `b${n.container}`, solidPlural(n.piece), lowerFirst(n.title)) : null;
    }
  }
}

/** Pairings by record key: a key's pairing never changes, and collections re-read up to RECORDED_LIMIT keys when a record is added. */
const pairings = new Map<string, Pairing | null>();
function pairingOfKey(k: string): Pairing | null {
  let p = pairings.get(k);
  if (p === undefined) {
    const parsed = parseKey(k);
    p = parsed ? pairingOf(parsed) : null;
    pairings.set(k, p);
  }
  return p;
}

/**
 * The player's collections, from the records confirmed (whether or not Collections is owned). Every
 * Dimension counts. The records are distinct problems, so a pairing's count is its number of distinct
 * piece counts; the piece milestones are per Dimension and piece shape ("squares in 2D in 2D" and
 * "squares on a 3D surface" are two).
 */
export function collections(e: EconomyState): Collections {
  const key = `${e.recorded.length}|${e.recorded.at(-1)}|${e.tiers.join(",")}`;
  const seen = memo.get(e.recorded);
  if (seen?.key === key) return seen.value;
  const combos = new Map<string, { have: number; p: Pairing }>();
  const shapes = new Map<string, { count: number; p: Pairing }>();
  for (const k of e.recorded) {
    const p = pairingOfKey(k);
    if (!p) continue;
    const shape = shapes.get(`${p.dimension}|${p.piece}`) ?? { count: 0, p };
    shape.count++;
    shapes.set(`${p.dimension}|${p.piece}`, shape);
    const id = `${p.dimension}|${p.piece}|${p.container}`;
    const combo = combos.get(id) ?? { have: 0, p };
    combo.have++;
    combos.set(id, combo);
  }
  const complete = [...combos.values()].filter((x) => x.have >= COMBO_RECORDS).length;
  const nearest = [...combos.entries()]
    .filter(([, x]) => x.have < COMBO_RECORDS)
    .sort((a, b) => b[1].have - a[1].have || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([, x]) => ({ label: x.p.label, have: x.have }));
  const ranked = [...shapes.entries()]
    .map(([id, x]) => ({ id, ...x, milestones: SHAPE_MILESTONES.filter((m) => x.count >= m).length }))
    .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
  const dims = new Set(ranked.map((x) => x.p.dimension));
  const shapeList = ranked.map((x) => ({
    label: dims.size > 1 || x.p.dimension !== "2-in-2" ? `${x.p.pieceLabel} (${DIMENSION_NAME[x.p.dimension]})` : x.p.pieceLabel,
    count: x.count,
    milestones: x.milestones,
  }));
  const milestones = shapeList.reduce((t, x) => t + x.milestones, 0);
  const tiers = TIERS.filter((t) => e.tiers.includes(t));
  const value: Collections = {
    combos: complete,
    nearest,
    shapes: shapeList,
    milestones,
    tiers,
    bonus: complete * COMBO_BONUS + milestones * SHAPE_BONUS + tiers.length * TIER_BONUS,
  };
  memo.set(e.recorded, { key, value });
  return value;
}

/** What collections add to all points: their bonus once Collections is owned, else nothing. */
export function collectionsBonus(s: GameState, o: Owned): number {
  return o.has("collections") ? collections(s.economy).bonus : 0;
}

/**
 * The multiplier on every point the problem pays (improvements and rent): standing × collections ×
 * the rewards of the rules finished that apply to it (and to the method that found it).
 */
export function pointsMultiplier(s: GameState, o: Owned, p: ProblemKey, method: string | null): number {
  return standingMultiplier(s.standing) * (1 + collectionsBonus(s, o)) * ruleRewardFactor(s.standing, p, method);
}

/**
 * The server confirmed a record of the player's on the problem: it counts for collections (and its
 * tier for tier firsts). Its rent runs from when it became the player's (heldSince).
 */
export function noteRecorded(s: GameState, p: ProblemState): void {
  const e = s.economy;
  if (!e.recorded.includes(p.key)) {
    e.recorded.push(p.key);
    if (e.recorded.length > RECORDED_LIMIT) e.recorded.splice(0, e.recorded.length - RECORDED_LIMIT);
  }
  // tier firsts count every family: a space problem's tier is "open" or "batch" (a site record), the same tiers
  if (!e.tiers.includes(p.tier)) e.tiers.push(p.tier);
}

/** Points earned on a problem before multipliers (paid now), kept on the problem. */
export function addBase(p: { base?: number }, base: number): void {
  if (base > 0) p.base = (p.base ?? 0) + base;
}

/** Points taken back on a problem: its base falls in the same proportion as its points. */
export function takeBase(p: { base?: number }, taken: number, rpBefore: number): void {
  const b = p.base;
  if (b === undefined || !(taken > 0)) return;
  p.base = rpBefore > 0 ? Math.max(0, b * (1 - Math.min(1, taken / rpBefore))) : 0;
}

/**
 * Brings the economy up to a save made before it: every problem the server confirmed (queue and
 * past) counts as recorded, and a first cycle's earnings are all the points earned.
 */
export function syncEconomy(s: GameState): void {
  for (const p of [...s.past, ...s.queue]) {
    if (p.verified === null) continue;
    if (!s.economy.recorded.includes(p.key)) s.economy.recorded.push(p.key);
    if (isPolygon(p) && !s.economy.tiers.includes(p.tier)) s.economy.tiers.push(p.tier);
  }
  if (s.standing.resets === 0 && s.standing.cycleEarned < s.rpEarned) s.standing.cycleEarned = s.rpEarned;
}

// ---------- rent ----------

/** Rent per hour: a share of what the record earned [SPEC]. */
export const RENT_SHARE = 0.01;
/** Each level of Higher rent multiplies rent by this. */
export const RENT_GROWTH = 1.5;
/** Rent paid at most for this long without a payday. */
export const RENT_WINDOW_MS = 7 * 24 * 3_600_000;
/** A saved payday time further away than this is a clock that moved or a bad save: it counts as the next noon. */
export const RENT_PAYDAY_MS = 24 * 3_600_000;
/** After a payday that left records unanswered, the next try comes this soon. */
export const RENT_RETRY_MS = 10 * 60_000;
/** Most records one payday request asks about (the server's limit). */
export const RENT_BATCH = 200;

type Held = ProblemState | PastProblem;

/**
 * Records the player leads that are in the save: the queue's, then the past's. The ones past the
 * save's limit are in the archive (archive.ts), which the totals below add.
 */
export function heldRecords(s: GameState): Held[] {
  return [...s.queue.filter((p) => p.ourId !== null), ...s.past.filter((p) => p.ourId !== null)];
}

const methodOf = (p: Held) => ("run" in p ? (p.run?.method ?? null) : null);

/** A record's rent per hour now (0 without Rent). */
export function rentPerHour(s: GameState, o: Owned, p: Held): number {
  if (!o.has("rent")) return 0;
  const m = pointsMultiplier(s, o, p, methodOf(p));
  // a record from before the base was kept: its points, as earned (multipliers were 1 then)
  const base = p.base ?? p.rp;
  return RENT_SHARE * base * Math.pow(RENT_GROWTH, level(o, "rentx")) * m;
}

/** Rent of every record held, per hour. */
export function rentRate(s: GameState, o: Owned): number {
  if (!o.has("rent")) return 0;
  return heldRecords(s).reduce((t, p) => t + rentPerHour(s, o, p), 0) + archiveRate(s, o);
}

/** What every archived record shares in its rent: the level of Higher rent and the multipliers that do not depend on the problem. */
function archiveShare(s: GameState, o: Owned): number {
  return (
    RENT_SHARE *
    Math.pow(RENT_GROWTH, level(o, "rentx")) *
    standingMultiplier(s.standing) *
    (1 + collectionsBonus(s, o))
  );
}

/**
 * Rent per hour of the archived records, from the archive's sums of base per class of problem (a
 * pass over five numbers, not over the rows): the rules' rewards depend on the class alone.
 */
function archiveRate(s: GameState, o: Owned): number {
  const a = archiveOf(s);
  if (!a || a.size === 0) return 0;
  let sum = 0;
  for (let c = 0; c < RENT_CLASSES; c++) sum += a.baseSum(c) * rentClassFactor(s.standing, c);
  return archiveShare(s, o) * sum;
}

/**
 * How long a record held now would be paid for at a payday at `now`: from the last payday (paidUntil),
 * or from when it became the player's if that was later, at most RENT_WINDOW_MS. Pure.
 */
export function rentWindowMs(heldSince: number | undefined, paidUntil: number, now: number): number {
  const from = Math.max(paidUntil, heldSince ?? paidUntil);
  return Math.min(RENT_WINDOW_MS, Math.max(0, now - from));
}

/** Rent accrued and not yet paid, across the records held (paid at the next payday). */
export function rentWaiting(s: GameState, o: Owned, now: number): number {
  const until = s.economy.paidUntil;
  if (!o.has("rent") || until === undefined) return 0;
  let t = 0;
  for (const p of heldRecords(s)) t += (rentPerHour(s, o, p) * rentWindowMs(p.heldSince, until, now)) / 3_600_000;
  // archived records are old: each is taken as held since the last payday
  t += (archiveRate(s, o) * Math.min(RENT_WINDOW_MS, Math.max(0, now - until))) / 3_600_000;
  return t;
}

/**
 * The next payday after `now`: 12:00 in the browser's time zone, today if it is before noon, else
 * tomorrow. Built from local date fields, so a day with a clock change still ends at noon.
 */
export function nextNoon(now: number): number {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  if (d.getTime() <= now) {
    d.setDate(d.getDate() + 1);
    d.setHours(12, 0, 0, 0);
  }
  return d.getTime();
}

/**
 * When the next payday is due: 0 (at once) without a saved time. A saved time more than a day away
 * (the clock moved, or a bad save) counts as the next noon.
 */
export function paydayDueAt(e: EconomyState, now: number): number {
  if (e.paydayAt === undefined) return 0;
  return e.paydayAt > now + RENT_PAYDAY_MS ? nextNoon(now) : e.paydayAt;
}

/** When the payday after one that just ran is due: sooner if the server left records unanswered. */
export function nextPaydayAfter(now: number, unanswered: number): number {
  return unanswered > 0 ? now + RENT_RETRY_MS : nextNoon(now);
}

/**
 * Rent just bought (or back after a reset): its first window starts now and the first payday is the
 * next noon, so there is nothing to pay yet. Also forgets the base of a problem neither held nor in the queue.
 */
export function tidyRent(s: GameState, o: Owned, now: number): void {
  const e = s.economy;
  if (o.has("rent")) {
    if (e.paidUntil === undefined) e.paidUntil = now;
    if (e.paydayAt === undefined) e.paydayAt = nextNoon(now);
  }
  for (const p of s.past) if (p.ourId === null) delete p.base;
}

/**
 * A payday found the record still the player's: pays its rent for its window (rentWindowMs, at most a
 * week). It does not move paidUntil: the payday does that once, after every record is paid. Returns
 * the points paid (0 when it is not held, or without Rent).
 */
export function settleRent(s: GameState, o: Owned, p: Held, now: number): number {
  const e = s.economy;
  if (!o.has("rent") || p.ourId === null || e.paidUntil === undefined) return 0;
  const rp = (rentPerHour(s, o, p) * rentWindowMs(p.heldSince, e.paidUntil, now)) / 3_600_000;
  if (!(rp > 0)) return 0;
  s.rp += rp;
  s.rpEarned += rp;
  s.standing.cycleEarned += rp;
  e.rentPaid += rp;
  e.lastRent = { key: p.key, rp, at: now };
  income.add(now, rp, "rent", p.tier);
  return rp;
}
