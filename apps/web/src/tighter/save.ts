import { parseConfig } from "@polypack/geometry";
import type { PackingConfig } from "@polypack/geometry";
import { DealerState, newDealer } from "./dealer";
import { keyOf, parseKey } from "./frontier";
import {
  GameState,
  LOG_LIMIT,
  Leader,
  PAST_LIMIT,
  PastProblem,
  PendingSend,
  Phase,
  ProblemState,
  TRACE_LIMIT,
  newGame,
} from "./game";
import { sanitizeName } from "./names";
import { PacerState, newPacer } from "./pacer";
import { CONTEST, Tier } from "./points";
import type { RunRecord } from "./submission";
import { isUpgradeId } from "./upgrades";

/**
 * Saves. The game lives in the browser: a versioned JSON document in localStorage, and the same
 * document as a save string for export and import ("tighter:" + version + ":" + encoding + ":" +
 * base64url). Loading is defensive: every field is checked, anything malformed falls back to its
 * default, and boards are parsed with the site's own parseConfig. A save from a newer version is
 * refused rather than read wrongly.
 *
 * Adding a field needs no new version (missing fields take their default). A change that would
 * misread old saves bumps SAVE_VERSION and adds a step to MIGRATIONS.
 */
export const SAVE_VERSION = 1;
export const STORAGE_KEY = "tighter.save";

/** Step k turns a save of version k into one of version k + 1. */
export type Migration = (save: Record<string, unknown>) => Record<string, unknown>;
export const MIGRATIONS: Record<number, Migration> = {};

export type LoadResult = { ok: true; state: GameState } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity): number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
const int = (v: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : fallback;
const posOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const str = (v: unknown, fallback: string, max = 200): string => (typeof v === "string" ? v.slice(0, max) : fallback);
const tier = (v: unknown): Tier => (typeof v === "string" && v in CONTEST ? (v as Tier) : "open");
const idOrNull = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null);

/** Runs the migrations from the save's version up to SAVE_VERSION. */
export function migrate(
  raw: Record<string, unknown>,
  migrations: Record<number, Migration> = MIGRATIONS,
  target = SAVE_VERSION,
): { ok: true; save: Record<string, unknown> } | { ok: false; error: string } {
  let save = raw;
  let version = save.version;
  if (!Number.isSafeInteger(version) || (version as number) < 1) return { ok: false, error: "not a Tighter save" };
  if ((version as number) > target)
    return { ok: false, error: `this save is from a newer version of Tighter (save format ${version})` };
  while ((version as number) < target) {
    const step = migrations[version as number];
    if (!step) return { ok: false, error: `no way to read save format ${version}` };
    save = step(save);
    version = (version as number) + 1;
    save = { ...save, version };
  }
  return { ok: true, save };
}

function board(v: unknown, key: string): PackingConfig | null {
  if (!isObj(v)) return null;
  const parsed = parseConfig(v);
  if (!parsed.ok) return null;
  const c = parsed.config;
  if (keyOf(c) !== key || c.pieces.length !== c.P) return null;
  return { N: c.N, M: c.M, P: c.P, pieces: c.pieces, container_phi: c.container_phi };
}

function runRecord(v: unknown): RunRecord | null {
  if (!isObj(v) || typeof v.method !== "string" || !/^[a-z_]+$/.test(v.method)) return null;
  if (!Number.isSafeInteger(v.seed) || (v.seed as number) < 0 || (v.seed as number) > 0xffffffff) return null;
  if (!isObj(v.budget) || !Number.isSafeInteger(v.budget.evals) || (v.budget.evals as number) < 1) return null;
  return {
    method: v.method,
    params: isObj(v.params) ? v.params : {},
    seed: v.seed as number,
    budget: { evals: v.budget.evals as number },
  };
}

function leader(v: unknown): Leader | null {
  if (!isObj(v) || posOrNull(v.score) === null) return null;
  return { score: v.score as number, name: str(v.name, "another name", 40), id: idOrNull(v.id) };
}

function pendingSend(v: unknown): PendingSend | null {
  if (!isObj(v) || posOrNull(v.score) === null || typeof v.name !== "string") return null;
  const name = sanitizeName(v.name);
  if (!name) return null;
  return { score: v.score as number, name, leaderBefore: leader(v.leaderBefore), at: num(v.at, 0) };
}

function problemState(v: unknown, now: number): ProblemState | null {
  if (!isObj(v)) return null;
  const k = parseKey(str(v.key, ""));
  if (!k || k.N !== v.N || k.M !== v.M || k.P !== v.P) return null;
  const key = keyOf(k);
  let phase: Phase = v.phase === "loaded" || v.phase === "ready" ? v.phase : "bare";
  const b = board(v.board, key);
  const best = posOrNull(v.best);
  // a board that cannot be read takes the problem back to the start
  if (phase !== "bare" && (!b || best === null)) phase = "bare";
  const run = runRecord(v.run);
  if (phase === "ready" && !run && tier(v.tier) === "open") phase = "bare";
  const trace = Array.isArray(v.trace)
    ? v.trace.filter((x): x is number => posOrNull(x) !== null).slice(-TRACE_LIMIT)
    : [];
  const refused =
    isObj(v.refused) && posOrNull(v.refused.score) !== null && Array.isArray(v.refused.reasons)
      ? { score: v.refused.score as number, reasons: v.refused.reasons.map(String).slice(0, 20) }
      : null;
  return {
    ...k,
    key,
    tier: tier(v.tier),
    dealtAt: num(v.dealtAt, now),
    floor: posOrNull(v.floor),
    phase,
    board: phase === "bare" ? null : b,
    best: phase === "bare" ? null : best,
    run: phase === "bare" ? null : run,
    nextSeed: int(v.nextSeed, 2, 2, 0xffffffff),
    leader: leader(v.leader),
    verified: posOrNull(v.verified),
    ourId: idOrNull(v.ourId),
    beatPaid: bool(v.beatPaid, false),
    closed: bool(v.closed, false),
    refused,
    leaving: bool(v.leaving, false),
    sending: pendingSend(v.sending),
    trace: phase === "bare" ? [] : trace,
    deadRuns: int(v.deadRuns, 0),
    runs: int(v.runs, 0),
    lastRunAt: num(v.lastRunAt, 0),
    rp: num(v.rp, 0, 0),
  };
}

function pastProblem(v: unknown, now: number): PastProblem | null {
  if (!isObj(v)) return null;
  const k = parseKey(str(v.key, ""));
  if (!k) return null;
  return {
    ...k,
    key: keyOf(k),
    tier: tier(v.tier),
    best: posOrNull(v.best),
    verified: posOrNull(v.verified),
    ourId: idOrNull(v.ourId),
    rp: num(v.rp, 0, 0),
    leftAt: num(v.leftAt, now),
  };
}

function dealer(v: unknown, now: number): DealerState {
  const d = newDealer(Math.floor(Math.random() * 0xffffffff), now);
  if (!isObj(v)) return d;
  return {
    seed: int(v.seed, d.seed, 0, 0xffffffff),
    draws: int(v.draws, 0),
    dealt: int(v.dealt, 0),
    tokens: num(v.tokens, 1, 0, 100),
    updatedAt: num(v.updatedAt, now),
  };
}

function pacer(v: unknown): PacerState {
  if (!isObj(v)) return newPacer();
  const last: Record<string, number> = {};
  if (isObj(v.lastByProblem))
    for (const [k, t] of Object.entries(v.lastByProblem))
      if (parseKey(k) && typeof t === "number" && Number.isFinite(t)) last[k] = t;
  return {
    sent: Array.isArray(v.sent)
      ? v.sent.filter((t): t is number => typeof t === "number" && Number.isFinite(t)).slice(-20)
      : [],
    lastByProblem: last,
    pausedUntil: num(v.pausedUntil, 0),
  };
}

/** A game state from a parsed save document of the current version, with every field checked. */
export function normalize(save: Record<string, unknown>, now: number): GameState {
  const g = newGame(now, 0);
  const settings = isObj(save.settings) ? save.settings : {};
  const stats = isObj(save.stats) ? save.stats : {};
  const queue: ProblemState[] = [];
  const keys = new Set<string>();
  for (const q of Array.isArray(save.queue) ? save.queue : []) {
    const p = problemState(q, now);
    if (p && !keys.has(p.key) && queue.length < 12) {
      queue.push(p);
      keys.add(p.key);
    }
  }
  const past: PastProblem[] = [];
  for (const q of Array.isArray(save.past) ? save.past.slice(-PAST_LIMIT) : []) {
    const p = pastProblem(q, now);
    if (p && !keys.has(p.key)) {
      past.push(p);
      keys.add(p.key);
    }
  }
  const owned = [...new Set(Array.isArray(save.owned) ? save.owned.filter(isUpgradeId) : [])];
  const focus =
    typeof save.focus === "string" && queue.some((p) => p.key === save.focus) ? save.focus : (queue[0]?.key ?? null);
  return {
    version: SAVE_VERSION,
    createdAt: num(save.createdAt, now),
    rp: num(save.rp, 0, 0),
    rpEarned: num(save.rpEarned, 0, 0),
    owned,
    // the name as the server stores it; no consent without one
    name: sanitizeName(str(save.name, "", 400)),
    consent: bool(save.consent, false) && sanitizeName(str(save.name, "", 400)) !== "",
    settings: {
      auto: bool(settings.auto, g.settings.auto),
      method: settings.method === "basin_hopping" && owned.includes("basin") ? "basin_hopping" : "mc_compress",
      background: bool(settings.background, false),
      battery: bool(settings.battery, false),
    },
    stats: {
      evaluations: int(stats.evaluations, 0),
      runs: int(stats.runs, 0),
      computeMs: int(stats.computeMs, 0),
      submissions: int(stats.submissions, 0),
      firstRecords: int(stats.firstRecords, 0),
      verifiedImprovements: int(stats.verifiedImprovements, 0),
    },
    dealer: dealer(save.dealer, now),
    pacer: pacer(save.pacer),
    queue,
    focus,
    past,
    reveal: Array.isArray(save.reveal)
      ? [...new Set(save.reveal.filter((r): r is string => typeof r === "string").slice(0, 50))]
      : [],
    log: Array.isArray(save.log)
      ? save.log
          .filter(
            (l): l is { t: number; text: string } => isObj(l) && typeof l.t === "number" && typeof l.text === "string",
          )
          .slice(-LOG_LIMIT)
          .map((l) => ({ t: l.t, text: l.text.slice(0, 300) }))
      : [],
  };
}

/** Reads a save document (already parsed from JSON). */
export function readSave(raw: unknown, now: number, migrations: Record<number, Migration> = MIGRATIONS): LoadResult {
  if (!isObj(raw)) return { ok: false, error: "not a Tighter save" };
  const m = migrate(raw, migrations);
  if (!m.ok) return m;
  return { ok: true, state: normalize(m.save, now) };
}

export function toJson(state: GameState): string {
  return JSON.stringify({ ...state, version: SAVE_VERSION });
}

export function fromJson(text: string, now: number): LoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "the save is not valid JSON" };
  }
  return readSave(raw, now);
}

// ---------- save strings ----------

const PREFIX = "tighter";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const canCompress = () => typeof CompressionStream === "function" && typeof DecompressionStream === "function";

/** The save as one line of text: deflated where the browser can, plain JSON otherwise. */
export async function exportString(state: GameState): Promise<string> {
  const bytes = new TextEncoder().encode(toJson(state));
  if (canCompress())
    return `${PREFIX}:${SAVE_VERSION}:z:${toBase64Url(await pipe(bytes, new CompressionStream("deflate-raw")))}`;
  return `${PREFIX}:${SAVE_VERSION}:j:${toBase64Url(bytes)}`;
}

export async function importString(text: string, now: number): Promise<LoadResult> {
  const m = /^tighter:(\d+):([zj]):([A-Za-z0-9_-]+)$/.exec(text.trim().replace(/\s+/g, ""));
  if (!m) return { ok: false, error: "that is not a Tighter save string" };
  try {
    let bytes = fromBase64Url(m[3]);
    if (m[2] === "z") {
      if (!canCompress()) return { ok: false, error: "this browser cannot read compressed save strings" };
      bytes = await pipe(bytes, new DecompressionStream("deflate-raw"));
    }
    return fromJson(new TextDecoder().decode(bytes), now);
  } catch {
    return { ok: false, error: "the save string is damaged" };
  }
}
