import type { HolderResponse } from "@polypack/geometry";
import type { LeadersAnswer } from "../api";
import { ensureArchive } from "./archive";
import type { ArchiveRow } from "./archive";
import { RENT_BATCH } from "./economy";
import { isPolygon, parseKey } from "./frontier";
import type { GameState } from "./game";
import { sanitizeName } from "./names";
import type { Owned } from "./upgrades";

/**
 * Recovery of records the save lost before the archive existed. The save trimmed the held records of
 * old problems along with the past list, but economy.recorded still lists the problems the player once
 * recorded. For those that are in neither the queue, the past nor the archive, the server is asked
 * which the player's name still leads, and each one it does lead counts again.
 */

export interface RecoveryDeps {
  /** GET /api/holder?name=: what the name leads; "refused" or null when it cannot be answered. */
  getHolder: (name: string) => Promise<HolderResponse | "refused" | null>;
  /** GET /api/leaders for these keys; null when the request failed. */
  getLeaders: (keys: string[]) => Promise<LeadersAnswer | null>;
  now: () => number;
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Looks for the records and archives the ones found. Returns how many were found, or null when it
 * could not finish (no name, the server did not answer): the game tries again at a later load. Done
 * once per save (archiveRecovered).
 */
export async function recoverRecords(s: GameState, _o: Owned, d: RecoveryDeps): Promise<number | null> {
  if (s.archiveRecovered || !s.name) return null;
  const a = ensureArchive(s);
  const inSave = new Set([...s.queue, ...s.past].map((p) => p.key));
  const missing = s.economy.recorded.filter((k) => {
    if (inSave.has(k) || a.has(k)) return false;
    const p = parseKey(k);
    return !!p && isPolygon(p);
  });
  if (!missing.length) {
    s.archiveRecovered = true;
    return 0;
  }
  const holder = await d.getHolder(s.name);
  if (!holder || holder === "refused") return null;
  const led = new Set<string>();
  for (const pair of holder.pairs) for (const P of pair.P) led.add(`${pair.N}/${pair.M}/${P}`);
  const candidates = missing.filter((k) => led.has(k));

  // the base of a recovered record is not known: the median of the player's other held records
  const bases: number[] = [];
  for (const p of [...s.queue, ...s.past]) if (p.ourId !== null) bases.push(p.base ?? p.rp);
  for (const r of a.values()) bases.push(r.base ?? r.rp);
  const base = median(bases);

  const me = sanitizeName(s.name);
  const found: ArchiveRow[] = [];
  for (let i = 0; i < candidates.length; i += RENT_BATCH) {
    const answer = await d.getLeaders(candidates.slice(i, i + RENT_BATCH));
    if (!answer) {
      // keep what was found; the rest is tried at a later load
      for (const r of found) a.put(r);
      return null;
    }
    for (const k of candidates.slice(i, i + RENT_BATCH)) {
      const leader = answer.leaders[k];
      const p = parseKey(k);
      if (!leader || leader.id === null || sanitizeName(leader.name) !== me || !p) continue;
      const now = d.now();
      found.push({
        ...p,
        key: k,
        tier: "batch",
        best: leader.score,
        verified: leader.score,
        ourId: leader.id,
        heldSince: now,
        rp: 0,
        leftAt: now,
        base,
      } as ArchiveRow);
    }
  }
  for (const r of found) a.put(r);
  s.archiveRecovered = true;
  return found.length;
}
