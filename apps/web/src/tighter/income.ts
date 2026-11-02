import type { Tier } from "./points";

/**
 * The income view: record points earned in the last hour, by where they came from. It is kept in
 * memory only, so it starts empty when the page opens and nothing about it is saved. game.ts notes
 * each improvement paid and economy.ts each rent payday.
 *
 * How the view groups the points is in GROUPS and SOURCES. Changing the grouping (for a points
 * rework that removes tiers, say) means changing those two lists and `groupOf`, not the sums.
 */
export type IncomeSource = "record" | "rent";
export const SOURCES: readonly { id: IncomeSource; label: string }[] = [
  { id: "record", label: "Record improvements" },
  { id: "rent", label: "Rent paydays" },
];

/** The rows of the view. Each problem tier belongs to one row. */
export const GROUPS: readonly { id: string; label: string; tiers: readonly Tier[] }[] = [
  { id: "open", label: "Open problems", tiers: ["open"] },
  { id: "loose", label: "Loose records", tiers: ["loose"] },
  { id: "site", label: "Site records", tiers: ["batch"] },
  { id: "published", label: "Published values", tiers: ["published"] },
];
export const groupOf = (tier: Tier): string => GROUPS.find((g) => g.tiers.includes(tier))?.id ?? tier;

export const INCOME_WINDOW_MS = 3_600_000;

export interface IncomeEvent {
  at: number;
  rp: number;
  source: IncomeSource;
  group: string;
}

export class IncomeLog {
  private events: IncomeEvent[] = [];

  /** Notes `rp` points earned at `at`. Points that are not above zero are not noted. */
  add(at: number, rp: number, source: IncomeSource, tier: Tier): void {
    if (!(rp > 0)) return;
    this.events.push({ at, rp, source, group: groupOf(tier) });
    this.trim(at);
  }

  /** Drops what is older than the window; events come in time order, so the old ones are at the front. */
  private trim(now: number): void {
    let n = 0;
    while (n < this.events.length && this.events[n].at <= now - INCOME_WINDOW_MS) n++;
    if (n) this.events.splice(0, n);
  }

  clear(): void {
    this.events = [];
  }

  /**
   * Points in the hour up to `now`, by group and source. A page open for less than an hour
   * has less than an hour to show, so this is the sum, not a rate scaled up.
   */
  sums(now: number): IncomeSums {
    const out: IncomeSums = { cells: {}, bySource: {}, byGroup: {}, total: 0 };
    for (const e of this.events) {
      if (e.at <= now - INCOME_WINDOW_MS || e.at > now) continue;
      const k = `${e.group}/${e.source}`;
      out.cells[k] = (out.cells[k] ?? 0) + e.rp;
      out.bySource[e.source] = (out.bySource[e.source] ?? 0) + e.rp;
      out.byGroup[e.group] = (out.byGroup[e.group] ?? 0) + e.rp;
      out.total += e.rp;
    }
    return out;
  }
}

export interface IncomeSums {
  /** `${group}/${source}` to points. */
  cells: Record<string, number>;
  bySource: Partial<Record<IncomeSource, number>>;
  byGroup: Record<string, number>;
  total: number;
}

/** The game's one log. */
export const income = new IncomeLog();
