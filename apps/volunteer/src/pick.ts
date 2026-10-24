/**
 * Which problem to search next, from the server's work list (GET /api/targets). Pure: the history,
 * the clock and the random source are passed in.
 *
 * The list is filtered (--N, --M, --max-P), problems this machine searched in the last week are
 * left out unless their leader has changed since, and one of the 50 highest priorities left is
 * drawn with probability proportional to its priority. The draw spreads machines that read the
 * same list over different problems, and still favours the most promising ones.
 *
 * The optional work list of the new spaces (GET /api/spaces/targets, --spaces) is drawn from in
 * the same way, keyed by the space problem id, with the spaces and --max-P as its filters; the
 * leader of a space problem is a site entry id, or null while the research record leads.
 */
import type { Target } from "@polypack/geometry";
import type { SpaceName, SpaceTarget } from "@polypack/spaces";
import { problemKey } from "./format";
import { type AnyHistoryLine, historyKey } from "./state";

export const RECENT_MS = 7 * 24 * 3600_000;
export const TOP = 50;

/** The last search of one problem: when, and the leaders seen before and after it. */
export interface Recent {
  time: number;
  leaders: (number | null)[];
}

export interface Filters {
  N: readonly number[] | null;
  M: readonly number[] | null;
  maxP: number | null;
}

/**
 * Records one finished search. A search cut short by a signal or by --hours does not count: the
 * problem may come back. One that failed does count, so that a failure is not repeated at once.
 * The leader after the search is usually this machine's own new entry; the list the server ranks
 * may still show the leader from before for a few minutes, so both count as seen.
 *
 * A dry run's search counts for later dry runs only: a real run must still search the problem and
 * submit, and the dry run's best packing, kept in best/, is offered then.
 */
export function noteSearch(recent: Map<string, Recent>, line: AnyHistoryLine, dryRun = false): void {
  if (line.stopped === "aborted" || line.stopped === "interrupted" || line.stopped === "crashed") return;
  // lines written before `dry_run` was recorded say so in their decision
  if (!dryRun && (line.dry_run === true || line.decision === "dry run: would submit")) return;
  const time = Date.parse(line.time);
  if (!Number.isFinite(time)) return;
  const key = historyKey(line);
  const old = recent.get(key);
  if (old && old.time > time) return;
  const leaders = [line.leader_before?.id ?? null];
  if (line.leader_after) leaders.push(line.leader_after.id);
  recent.set(key, { time, leaders });
}

export function recentFromHistory(lines: Iterable<AnyHistoryLine>, dryRun = false): Map<string, Recent> {
  const recent = new Map<string, Recent>();
  for (const line of lines) noteSearch(recent, line, dryRun);
  return recent;
}

/** Forgets searches older than RECENT_MS, which no longer skip anything. */
export function pruneRecent(recent: Map<string, Recent>, now: number): void {
  for (const [key, r] of recent) if (now - r.time >= RECENT_MS) recent.delete(key);
}

/** True when this machine searched the problem within RECENT_MS and its leader is one it saw then. */
export function searchedRecently(t: Target | SpaceTarget, recent: ReadonlyMap<string, Recent>, now: number): boolean {
  const r = recent.get("space" in t ? t.id : problemKey(t));
  if (!r || now - r.time >= RECENT_MS) return false;
  return r.leaders.includes(t.leader_id ?? null);
}

export function matchesFilters(t: Target, f: Filters): boolean {
  return (!f.N || f.N.includes(t.N)) && (!f.M || f.M.includes(t.M)) && (f.maxP === null || t.P <= f.maxP);
}

/** The problems a draw chooses from: filtered, not skipped, the TOP highest priorities. */
export function eligibleTargets(
  targets: readonly Target[],
  o: { filters: Filters; recent: ReadonlyMap<string, Recent>; skip: ReadonlySet<string>; now: number },
): Target[] {
  return targets
    .filter((t) => matchesFilters(t, o.filters) && !o.skip.has(problemKey(t)) && !searchedRecently(t, o.recent, o.now))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, TOP);
}

/**
 * One target drawn with probability proportional to its priority; priorities that are not
 * positive numbers weigh nothing, and when none is positive the draw is uniform.
 */
export function weightedDraw<T extends { priority: number }>(targets: readonly T[], random: () => number): T | null {
  if (targets.length === 0) return null;
  const weights = targets.map((t) => (Number.isFinite(t.priority) && t.priority > 0 ? t.priority : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return targets[Math.min(targets.length - 1, Math.floor(random() * targets.length))];
  let r = random() * total;
  for (let i = 0; i < targets.length; i++) {
    if (weights[i] === 0) continue;
    r -= weights[i];
    if (r < 0) return targets[i];
  }
  // rounding left r at or just above zero: the last positive weight
  for (let i = targets.length - 1; i >= 0; i--) if (weights[i] > 0) return targets[i];
  return null;
}

export function pickTarget(
  targets: readonly Target[],
  o: {
    filters: Filters;
    recent: ReadonlyMap<string, Recent>;
    skip: ReadonlySet<string>;
    now: number;
    random: () => number;
  },
): Target | null {
  return weightedDraw(eligibleTargets(targets, o), o.random);
}

export interface SpaceFilters {
  spaces: readonly SpaceName[];
  maxP: number | null;
}

export function matchesSpaceFilters(t: SpaceTarget, f: SpaceFilters): boolean {
  return f.spaces.includes(t.space) && (f.maxP === null || t.P <= f.maxP);
}

/**
 * The space problems a draw chooses from, by space: filtered, not skipped, not searched recently,
 * each space's TOP highest priorities, in the order of the filter's spaces (spaces with none are
 * left out).
 */
export function eligibleSpaceTargets(
  targets: readonly SpaceTarget[],
  o: { filters: SpaceFilters; recent: ReadonlyMap<string, Recent>; skip: ReadonlySet<string>; now: number },
): Map<SpaceName, SpaceTarget[]> {
  const bySpace = new Map<SpaceName, SpaceTarget[]>();
  for (const space of o.filters.spaces) bySpace.set(space, []);
  for (const t of targets)
    if (matchesSpaceFilters(t, o.filters) && !o.skip.has(t.id) && !searchedRecently(t, o.recent, o.now))
      bySpace.get(t.space)!.push(t);
  for (const [space, list] of bySpace) {
    if (list.length === 0) bySpace.delete(space);
    else bySpace.set(space, list.sort((a, b) => b.priority - a.priority).slice(0, TOP));
  }
  return bySpace;
}

/**
 * One space problem: first a space, uniformly among the requested spaces that have an eligible
 * problem, then one of that space's TOP highest priorities in proportion to its priority. The
 * server scales priorities so that each space's sum to the same share; a cut of the whole list to
 * its TOP highest would leave out the spaces with many problems, whose priorities are smallest.
 */
export function pickSpaceTarget(
  targets: readonly SpaceTarget[],
  o: {
    filters: SpaceFilters;
    recent: ReadonlyMap<string, Recent>;
    skip: ReadonlySet<string>;
    now: number;
    random: () => number;
  },
): SpaceTarget | null {
  const bySpace = eligibleSpaceTargets(targets, o);
  const spaces = [...bySpace.keys()];
  if (spaces.length === 0) return null;
  const space = spaces[Math.min(spaces.length - 1, Math.floor(o.random() * spaces.length))];
  return weightedDraw(bySpace.get(space)!, o.random);
}
