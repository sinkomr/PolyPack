import { Bandit, normalizeBandit } from "./bandit";
import { keyOf, needPolygon, parseKey } from "./frontier";
import { CONTEST, Tier } from "./points";
import { Candidate, Filters, learn, normalizeFilters } from "./rank";

/**
 * The dealer's own state (plan 2026-10-20 §3): offers waiting for the player's pick, filters, what
 * the learning dealer has learned, the problems in play with the bucket and prior they were dealt
 * under, and records lost that wait for a retake.
 */

/** A candidate offered to the player (Your pick), with its ranking. */
export interface OfferFields {
  /** The ranking score when it was offered (expected record points per second of solver time). */
  score: number;
  /** Expected record points per evaluation (the prior). */
  prior: number;
  bucket: string;
  at: number;
}
export type Offer = Candidate & OfferFields;

/** What a problem in play was dealt under: the learning dealer learns from it when it leaves. */
export interface Dealt {
  bucket: string;
  prior: number;
}

export interface PicksState {
  offers: Offer[];
  filters: Filters | null;
  /** The learning dealer's arms: per bucket, the ratio of RP per evaluation earned to the prior's. */
  bandit: Bandit;
  /** Keys of problems whose record the player lost, waiting to be offered again (Retake). */
  retake: string[];
  /** Problems dealt and not yet left, by key. */
  dealt: Record<string, Dealt>;
}

export const newPicks = (): PicksState => ({ offers: [], filters: null, bandit: {}, retake: [], dealt: {} });

/** Most offers kept (Your pick: 5). */
export const MAX_OFFERS = 5;
/** Most lost records waiting for a retake. */
export const MAX_RETAKES = 200;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const validKey = (k: string): boolean => parseKey(k) !== null;

function leader(v: unknown): Candidate["leader"] {
  if (!isObj(v) || !pos(v.score) || !Number.isSafeInteger(v.id) || (v.id as number) < 1) return null;
  return {
    score: v.score,
    name: typeof v.name === "string" ? v.name.slice(0, 40) : "another name",
    id: v.id as number,
  };
}

/** An offer read from a save, or null when it is not one. */
export function normalizeOffer(v: unknown): Offer | null {
  if (!isObj(v)) return null;
  const k = parseKey(typeof v.id === "string" && v.family !== "polygon" ? v.id : `${v.N}/${v.M}/${v.P}`);
  if (!k || typeof v.tier !== "string" || !(v.tier in CONTEST)) return null;
  const tier = v.tier as Tier;
  const lead = leader(v.leader);
  // a contested offer starts from its leader; a published one from its leader or the published packing
  if ((tier === "loose" || tier === "batch") && !lead) return null;
  if (tier === "published" && !pos(v.target)) return null;
  if (!finite(v.score) || !finite(v.prior) || typeof v.bucket !== "string") return null;
  return {
    ...k,
    tier,
    weakness: finite(v.weakness) ? v.weakness : null,
    leader: lead,
    target: tier === "published" ? (v.target as number) : null,
    source: typeof v.source === "string" ? v.source.slice(0, 200) : null,
    retake: v.retake === true,
    score: v.score,
    prior: v.prior,
    bucket: v.bucket.slice(0, 120),
    at: finite(v.at) ? v.at : 0,
  };
}

export function normalizePicks(v: unknown): PicksState {
  const d = newPicks();
  if (!isObj(v)) return d;
  const offers: Offer[] = [];
  const seen = new Set<string>();
  for (const o of Array.isArray(v.offers) ? v.offers : []) {
    const offer = normalizeOffer(o);
    if (offer && !seen.has(keyOf(offer)) && offers.length < MAX_OFFERS) {
      offers.push(offer);
      seen.add(keyOf(offer));
    }
  }
  const dealt: Record<string, Dealt> = {};
  if (isObj(v.dealt))
    for (const [k, x] of Object.entries(v.dealt))
      if (validKey(k) && isObj(x) && typeof x.bucket === "string" && pos(x.prior))
        dealt[k] = { bucket: x.bucket.slice(0, 120), prior: x.prior };
  return {
    offers,
    filters: normalizeFilters(v.filters),
    bandit: normalizeBandit(v.bandit),
    retake: Array.isArray(v.retake)
      ? [...new Set(v.retake.filter((k): k is string => typeof k === "string" && validKey(k)))].slice(-MAX_RETAKES)
      : [],
    dealt,
  };
}

/**
 * Whether an offer can still be taken: the filters and the cycle's rule allow it (`allowed`), and the
 * tree still reaches it (a retake needs Retake; a site record or published value its tier and size
 * ring). Purchases, filters and resets change these after an offer was drawn.
 */
export function offerFits(
  x: Offer,
  tree: { retake: boolean; tiers: ReadonlySet<Tier>; ringMin: number },
  allowed: (x: Offer) => boolean,
): boolean {
  if (!allowed(x)) return false;
  if (x.retake) return tree.retake;
  if (x.tier === "open") return true;
  const q = needPolygon(x, "size ring");
  return tree.tiers.has(x.tier) && q.N + q.M + q.P >= tree.ringMin;
}

/**
 * A problem left the queue: the learning dealer learns, in the bucket it was dealt under, how far
 * what it paid per evaluation was from the prior. Returns whether it learned anything.
 */
export function learnOnLeave(picks: PicksState, p: { key: string; rp: number; evaluations: number }): boolean {
  const d = picks.dealt[p.key];
  if (!d) return false;
  delete picks.dealt[p.key];
  return learn(picks.bandit, d.bucket, p.rp, p.evaluations, d.prior);
}

/** Adds a lost record to the retake list (once, newest last). */
export function addRetake(picks: PicksState, key: string): void {
  picks.retake = [...picks.retake.filter((k) => k !== key), key].slice(-MAX_RETAKES);
}
