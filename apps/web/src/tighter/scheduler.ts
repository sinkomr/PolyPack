import { DEFAULT_PATIENCE, ProblemState, evolvable } from "./game";
import type { UpgradeId } from "./upgrades";

/**
 * Auto-eval: which problem a lane gives its next due evaluation. A lane is one solver worker with
 * one open run; two lanes never work the same problem, since one run's evaluations cannot be split.
 *
 * Without Auto-advance, lane 1 keeps to the problem on the board and lane 2 to the next problem of
 * the queue, and both only Evolve problems that already have a record. With it, lanes go where
 * evaluations still make progress: a fresh problem first (its Compact is a first record), else the
 * lane's own problem while it makes progress, else the problem with the fewest evaluations since its
 * last progress. A lane moves only when its problem has stalled (the player's patience without
 * progress): moving opens a new run, so lanes that hopped to whichever problem was a click behind
 * would go in circles, restarting a run each click. Once every problem has stalled, a lane keeps to
 * its own until another is a whole patience fresher (stalled problems leave the queue meanwhile,
 * game.ts advancePlan).
 */
export type AutoAction = "compact" | "evolve";

export interface AutoTarget {
  key: string;
  action: AutoAction;
}

const workable = (p: ProblemState, busy: ReadonlySet<string>) => !p.leaving && !p.closed && !busy.has(p.key);

export function autoTarget(opts: {
  lane: number;
  queue: readonly ProblemState[];
  focus: string | null;
  busy: ReadonlySet<string>;
  owned: ReadonlySet<UpgradeId>;
  /** Auto-eval is due a Compact's evaluations (otherwise fresh problems wait and runs go on elsewhere). */
  canCompact?: boolean;
  /** The problem the lane's open run is on (null: none). */
  current?: string | null;
  /** Evaluations without progress after which a problem has stalled (game.ts stallAfter). */
  stall?: number;
}): AutoTarget | null {
  const { lane, queue, focus, busy, owned } = opts;
  const free = queue.filter((p) => workable(p, busy));
  if (!owned.has("advance")) {
    const ready = free.filter(evolvable);
    const pick = lane === 0 ? ready.find((p) => p.key === focus) : ready.find((p) => p.key !== focus);
    return pick ? { key: pick.key, action: "evolve" } : null;
  }
  const fresh = opts.canCompact === false ? undefined : free.find((p) => !evolvable(p));
  if (fresh) return { key: fresh.key, action: "compact" };
  const stall = opts.stall ?? DEFAULT_PATIENCE;
  const ready = free.filter(evolvable).sort((a, b) => a.sinceGain - b.sinceGain || a.lastRunAt - b.lastRunAt);
  if (!ready.length) return null;
  const own = ready.find((p) => p.key === opts.current);
  const moving = ready.filter((p) => p.sinceGain < stall);
  const pick =
    own && own.sinceGain < stall
      ? own
      : moving.length
        ? moving[0]
        : own && own.sinceGain - ready[0].sinceGain < stall
          ? own
          : ready[0];
  return { key: pick.key, action: "evolve" };
}

/**
 * How many times slower than rank.ts's cost table (one mc_compress evaluation at a problem's
 * N+M+P) an evaluation runs on this device, kept apart for each kind of run (a method at a tuning
 * level, as "harden@2"): moving averages over the steps run here. Auto-eval sizes its jobs with them,
 * so that a slow method's jobs stay near a quarter second and its steps do not shrink every other
 * lane's jobs: basin_hopping, penalty, harden and asc evaluate 2 to 9 times slower than mc_compress,
 * ls_growth about 10 times (the method reports of 2026-10-22).
 */
export class Speeds {
  private readonly ratio = new Map<string, number>();

  /** A step of the kind `key` ran `done` evaluations in `ms`, where the table says `tableMs` for one. */
  observe(key: string, tableMs: number, done: number, ms: number): void {
    if (!(done > 0) || !(ms > 0) || !(tableMs > 0)) return;
    const r = Math.min(100, Math.max(0.01, ms / done / tableMs));
    const before = this.ratio.get(key);
    // the first step of a kind is its first measure; later ones move the average a fifth of the way
    this.ratio.set(key, before === undefined ? r : 0.8 * before + 0.2 * r);
  }

  /**
   * The ratio for the kind `key`: its own once measured, else (and for null, a kind not known yet)
   * the slowest measured, so that a first job is small rather than long; 1 before any.
   */
  slowness(key: string | null): number {
    const own = key === null ? undefined : this.ratio.get(key);
    return own ?? (this.ratio.size ? Math.max(...this.ratio.values()) : 1);
  }

  /** Whether any step has been measured here yet. */
  get measured(): boolean {
    return this.ratio.size > 0;
  }

  /** The expected ms of one evaluation of the kind `key` where the table says `tableMs`. */
  msEach(key: string | null, tableMs: number): number {
    return tableMs * this.slowness(key);
  }
}

/**
 * The most evaluations a second this computer runs for auto-eval, all lanes together: each lane is a
 * worker on a core of its own, and runs one evaluation in `msEach` ms (Speeds.msEach). Infinity where
 * nothing is known (msEach of 0).
 */
export function computerRate(lanes: number, msEach: number): number {
  return msEach > 0 ? (Math.max(1, lanes) * 1000) / msEach : Infinity;
}

/** The warning when auto-eval asks for more than this computer was measured to run. */
export const AUTO_LIMIT_WARNING =
  "This computer cannot run this many evaluations a second, so more auto-eval will not run faster here.";

/** Whether the rate asked for is more than this computer runs (a small margin keeps the sentence from flickering). */
export function autoOverLimit(rate: number, lanes: number, msEach: number): boolean {
  return rate > computerRate(lanes, msEach) * 1.05;
}

/** Why auto-eval is held back, or null when it may run. Clicks are never held. */
export function autoHold(opts: {
  hidden: boolean;
  onBattery: boolean;
  background: boolean;
  battery: boolean;
}): "hidden" | "battery" | null {
  if (opts.hidden && !opts.background) return "hidden";
  if (opts.onBattery && !opts.battery) return "battery";
  return null;
}
