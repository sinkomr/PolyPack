import type { Holder, HolderResponse } from "@polypack/geometry";

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

/** The columns of the holders table, each of which the table can be sorted by. */
export const HOLDER_SORT_KEYS = [
  "place",
  "name",
  "records",
  "peak",
  "beat_published",
  "site_bests",
  "pending",
] as const;
export type HolderSortKey = (typeof HOLDER_SORT_KEYS)[number];

export interface HolderSort {
  key: HolderSortKey;
  /** Largest first for a count, Z first for the name, last place first for the place. */
  descending: boolean;
}

/** The order the server sends: by place, which is by records and then by site bests. */
export const HOLDER_SORT_DEFAULT: HolderSort = { key: "place", descending: false };

export const isHolderSortKey = (key: unknown): key is HolderSortKey =>
  (HOLDER_SORT_KEYS as readonly unknown[]).includes(key);

/** A name with its place in the order of the server. */
export interface PlacedHolder extends Holder {
  place: number;
}

/**
 * The place of each name, from the list as the server sends it (by records, then by site bests): names equal in
 * both share a place, and the next name takes the place of its row. The place stays with the name however the
 * table is sorted.
 */
export function placeHolders(holders: readonly Holder[]): PlacedHolder[] {
  let place = 0;
  return holders.map((h, i) => {
    const before = holders[i - 1];
    if (!before || before.records !== h.records || before.site_bests !== h.site_bests) place = i + 1;
    return { ...h, place };
  });
}

/**
 * The sort after a click on the heading of a column: the same column turns round; another column starts with what
 * a reader looks for first, the largest counts, the first place or the start of the alphabet.
 */
export function nextHolderSort(now: HolderSort, key: HolderSortKey): HolderSort {
  if (now.key === key) return { key, descending: !now.descending };
  return { key, descending: key !== "place" && key !== "name" };
}

// capitals and accents order names only when nothing else does, and digits count as numbers: "team 2" before "team 10"
const byName = new Intl.Collator("en", { numeric: true });

/**
 * The rows in the order of a sort; `placed` is in the order of the server and is left as it is. Rows equal in the
 * sorted column keep the order of the server, whichever way the column runs, so the names with most records come
 * first among them.
 */
export function sortHolders(placed: readonly PlacedHolder[], sort: HolderSort): PlacedHolder[] {
  const { key, descending } = sort;
  // the places follow the order of the server, so last place first is that order turned round
  if (key === "place") return descending ? [...placed].reverse() : [...placed];
  const way = descending ? -1 : 1;
  const compare =
    key === "name"
      ? (a: PlacedHolder, b: PlacedHolder) => way * byName.compare(a.name, b.name)
      : (a: PlacedHolder, b: PlacedHolder) => way * (a[key] - b[key]);
  // the sort of an array is stable: rows that compare equal stay as they were
  return [...placed].sort(compare);
}
