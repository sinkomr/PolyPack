import type { HolderPair, HolderResponse } from "@polypack/geometry";
import { sanitizeName } from "./names";

/**
 * Rivals: the names that took records from the player, kept newest first (a short list in the
 * save), and the reading of what they hold (GET /api/holder), asked for rarely.
 */

export interface Rival {
  /** The name as the server keeps it (cleaned as sanitizeName does). */
  name: string;
  /** How many records of the player's this name took. */
  took: number;
}

/** Most rivals kept. */
export const MAX_RIVALS = 20;

/** Rivals read from a save: valid rows only, names cleaned, at most MAX_RIVALS, none twice. */
export function normalizeRivals(v: unknown): Rival[] {
  if (!Array.isArray(v)) return [];
  const out: Rival[] = [];
  for (const x of v) {
    if (typeof x !== "object" || x === null) continue;
    const r = x as Record<string, unknown>;
    const name = typeof r.name === "string" ? sanitizeName(r.name) : "";
    const took = typeof r.took === "number" && Number.isSafeInteger(r.took) && r.took >= 1 ? r.took : 1;
    if (!name || out.some((y) => y.name === name)) continue;
    out.push({ name, took });
    if (out.length >= MAX_RIVALS) break;
  }
  return out;
}

/**
 * A name took a record from `own`: it goes to the front of the list with one more taken. Returns false
 * (and changes nothing) for the player's own name, an empty name, or a placeholder the game uses
 * when the name is not known.
 */
export function addRival(list: Rival[], rawName: string, own: string): boolean {
  const name = sanitizeName(rawName);
  if (!name || name === sanitizeName(own) || name === "another name" || name === "the research record") return false;
  const i = list.findIndex((r) => r.name === name);
  const took = i >= 0 ? list[i].took + 1 : 1;
  if (i >= 0) list.splice(i, 1);
  list.unshift({ name, took });
  if (list.length > MAX_RIVALS) list.length = MAX_RIVALS;
  return true;
}

/** Removes a rival by name; returns whether it was there. */
export function removeRival(list: Rival[], name: string): boolean {
  const i = list.findIndex((r) => r.name === name);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

/** Ask for each rival at most once in this long. */
export const HOLDER_ASK_MS = 15 * 60_000;
/** Most requests to /api/holder in any window of one minute, all rivals together. */
export const HOLDER_PER_MINUTE = 3;

type Asked = HolderResponse | "refused" | null;

/**
 * Reads of GET /api/holder for the rivals, kept in memory: an answer (or a failed ask) stands for
 * HOLDER_ASK_MS, and at most HOLDER_PER_MINUTE requests go in a minute whichever names are asked for.
 * `get` gives the last answer when a new request may not go yet, or null when there is none.
 */
export class HolderReader {
  private kept = new Map<string, { at: number; answer: HolderResponse | null }>();
  private sent: number[] = [];
  constructor(
    private ask: (name: string) => Promise<Asked>,
    private now: () => number,
  ) {}

  /** Requests made so far in the last minute. */
  recent(): number {
    const t = this.now();
    this.sent = this.sent.filter((s) => t - s < 60_000);
    return this.sent.length;
  }

  async get(name: string): Promise<HolderResponse | null> {
    const have = this.kept.get(name);
    const t = this.now();
    if (have && t - have.at < HOLDER_ASK_MS) return have.answer;
    if (this.recent() >= HOLDER_PER_MINUTE) return have?.answer ?? null;
    this.sent.push(t);
    // marked before the request goes, so that two callers do not ask for the same name together
    this.kept.set(name, { at: t, answer: have?.answer ?? null });
    const r = await this.ask(name);
    const answer = r && r !== "refused" ? r : null;
    this.kept.set(name, { at: t, answer: answer ?? have?.answer ?? null });
    return answer ?? have?.answer ?? null;
  }

  /** What is kept for a name, without asking. */
  peek(name: string): HolderResponse | null {
    return this.kept.get(name)?.answer ?? null;
  }
}

/** The problems a holder answer lists, as "N/M/P" keys. */
export function heldKeys(answer: HolderResponse): string[] {
  const out: string[] = [];
  for (const pair of answer.pairs as HolderPair[]) for (const P of pair.P) out.push(`${pair.N}/${pair.M}/${P}`);
  return out;
}

/** Whether a site entry is held by a Tighter player other than `own` (the game sends agent_note "tighter/…"). */
export function heldByTighter(e: { name: string; agent_note?: string | null }, own: string): boolean {
  return (e.agent_note ?? "").startsWith("tighter/") && sanitizeName(e.name) !== sanitizeName(own);
}
