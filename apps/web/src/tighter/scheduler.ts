import { DEFAULT_PATIENCE, ProblemState, evolvable, spent } from "./game";
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
 * game.ts advancePlan). Problems whose seeds are spent are skipped.
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
  /** Seeds the player may use per problem. */
  seeds: number;
  /** Auto-eval is due a Compact's evaluations (otherwise fresh problems wait and runs go on elsewhere). */
  canCompact?: boolean;
  /** The problem the lane's open run is on (null: none). */
  current?: string | null;
  /** Evaluations without progress after which a problem has stalled (game.ts stallAfter). */
  stall?: number;
}): AutoTarget | null {
  const { lane, queue, focus, busy, owned, seeds } = opts;
  const free = queue.filter((p) => workable(p, busy) && !spent(p, seeds));
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
