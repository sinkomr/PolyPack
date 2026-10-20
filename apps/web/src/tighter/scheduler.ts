import { ProblemState, STALE_EVALS, evolvable, spent } from "./game";
import type { UpgradeId } from "./upgrades";

/**
 * Auto-eval: which problem a lane gives its next banked evaluation. A lane is one solver worker with
 * one open run; two lanes never work the same problem, since one run's evaluations cannot be split.
 *
 * Without Auto-advance, lane 1 keeps to the problem on the board and lane 2 to the next problem of
 * the queue, and both only Evolve problems that already have a record. With it, lanes go where
 * evaluations still pay: a fresh problem first (its Compact is a first record), then the problem
 * with the fewest evaluations since its last improvement, skipping problems that have stopped
 * paying (STALE_EVALS) while anything else is left. Problems whose seeds are spent are skipped.
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
  /** The bank can pay for a Compact (otherwise fresh problems wait and runs go on elsewhere). */
  canCompact?: boolean;
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
  const ready = free.filter(evolvable).sort((a, b) => a.sinceGain - b.sinceGain || a.lastRunAt - b.lastRunAt);
  const paying = ready.filter((p) => p.sinceGain < STALE_EVALS);
  const pick = (paying.length ? paying : ready)[0];
  return pick ? { key: pick.key, action: "evolve" } : null;
}

/** Why auto-eval (and its bank) is held back, or null when it may run. Clicks are never held. */
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
