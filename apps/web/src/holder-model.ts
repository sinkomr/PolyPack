import type { HolderResponse } from "@polypack/geometry";

/** How long the server may keep the page of a name before it counts again (HOLDER_MAX_AGE_MS of the server). */
export const REFRESH_MINUTES = 15;

/** The page of a name: what it leads, by pair of shapes. The name is free text, so it goes through the query. */
export const holderHref = (name: string): string => `/holder.html?name=${encodeURIComponent(name)}`;

/** The records page of a pair of shapes. */
export const pairHref = (N: number, M: number): string => `/browse.html#${N},${M}`;

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

/** Values of P in ascending order, as runs: [3, 4, 5, 6, 20, 25, 26] is "3–6, 20, 25–26". */
export function pRanges(P: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < P.length;) {
    let j = i;
    while (j + 1 < P.length && P[j + 1] === P[j]! + 1) j++;
    parts.push(j > i ? `${P[i]}–${P[j]}` : String(P[i]));
    i = j + 1;
  }
  return parts.join(", ");
}

/** The totals of a name in a sentence, in the style of the note of the holders page; the name is not part of it. */
export function holderTotals(
  h: Pick<HolderResponse, "records" | "beat_published" | "site_bests" | "pending">,
  pairs: number,
): string {
  let text = `leads ${plural(h.site_bests, "problem", "problems")} in ${plural(pairs, "pair of shapes", "pairs of shapes")}; ${count(h.records)} of these ${h.records === 1 ? "is a record" : "are records"}`;
  if (h.beat_published) text += `, ${count(h.beat_published)} below the published value`;
  if (h.pending) text += `; ${count(h.pending)} ${h.pending === 1 ? "awaits" : "await"} review`;
  return `${text}.`;
}

/** The time of day of an ISO time, such as "14:05" (in the viewer's zone and locale unless given); null when it cannot be read. */
export function timeOfDay(iso: string, locale?: string, timeZone?: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", timeZone });
}
