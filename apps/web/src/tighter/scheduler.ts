import { ProblemState, STALE_RUNS, evolvable } from "./game";
import type { UpgradeId } from "./upgrades";

/**
 * Auto-eval: which problem an idle lane works next. A lane is one solver worker; two lanes never
 * work the same problem, since a chain of runs from one board cannot be split.
 *
 * Without Auto-advance, lane 1 keeps to the problem on the board and lane 2 to the next problem of
 * the queue, and both only Evolve problems that already have a record. With it, lanes go where runs
 * still pay: a fresh problem first (its Compact is a first record), then the problem with the
 * fewest runs since its last improvement, skipping problems that have stopped paying (STALE_RUNS)
 * while anything else is left.
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
}): AutoTarget | null {
  const { lane, queue, focus, busy, owned } = opts;
  const free = queue.filter((p) => workable(p, busy));
  if (!owned.has("advance")) {
    const ready = free.filter(evolvable);
    const pick = lane === 0 ? ready.find((p) => p.key === focus) : ready.find((p) => p.key !== focus);
    return pick ? { key: pick.key, action: "evolve" } : null;
  }
  const fresh = free.find((p) => !evolvable(p));
  if (fresh) return { key: fresh.key, action: "compact" };
  const ready = free.filter(evolvable).sort((a, b) => a.deadRuns - b.deadRuns || a.lastRunAt - b.lastRunAt);
  const paying = ready.filter((p) => p.deadRuns < STALE_RUNS);
  const pick = (paying.length ? paying : ready)[0];
  return pick ? { key: pick.key, action: "evolve" } : null;
}

/** Why auto-eval is held back, or null when it may run. */
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
