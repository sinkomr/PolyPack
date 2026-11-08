import { DEFAULT_PATIENCE, ProblemState, evolvable } from "./game";
import { isPolygon } from "./frontier";
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

/**
 * The queue's problems auto-eval leaves alone: a space problem on a page that cannot run space
 * problems (not cross-origin isolated), and a problem whose last run failed to start (`reasons`,
 * by key) until the player presses Evolve on it again.
 */
export function unrunnableKeys(
  queue: readonly ProblemState[],
  spacesRun: boolean,
  reasons: ReadonlyMap<string, string>,
): Set<string> {
  return new Set(queue.filter((p) => reasons.has(p.key) || (!spacesRun && !isPolygon(p))).map((p) => p.key));
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

/**
 * How auto-eval's rate `rate` (evaluations a second, all lanes) is split over the lanes that have
 * work, one entry of `msEach` (the expected ms of one evaluation on that lane's problem with its
 * run's method) for each. Each lane gets about the same solving time, so a share is proportional to
 * 1 / msEach. But a lane gets at least `floor` of an equal share (rate / lanes / 4), at most what its
 * core runs (1000 / msEach a second), and what a lane cannot use goes to the others. Returns the
 * evaluations a second for each lane, in the same order. Where every lane is at its core's limit the
 * total is less than `rate`.
 */
export function laneSplit(msEach: readonly number[], rate: number, floor = 0.25): number[] {
  const L = msEach.length;
  if (!L || !(rate > 0)) return msEach.map(() => 0);
  const ms = msEach.map((m) => (m > 0 ? m : 1e-6));
  const base = ms.map((m) => Math.min((floor * rate) / L, 1000 / m));
  const rest = rate - base.reduce((a, b) => a + b, 0);
  // the rest goes by equal solving time on top of the floor: find the time T each lane works at
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 200; i++) {
    const T = (lo + hi) / 2;
    const extra = ms.reduce((a, m, k) => a + Math.max(0, Math.min(1000, T) / m - base[k]), 0);
    if (extra > rest) hi = T;
    else lo = T;
  }
  const e = ms.map((m, k) => Math.max(base[k], Math.min(1000, lo) / m));
  const sum = e.reduce((a, b) => a + b, 0);
  return sum > rate + 1e-6 ? e.map((x) => (x * rate) / sum) : e;
}

/** How long the measured rate looks back, and the least time of auto-eval's work it needs to speak. */
export const AUTO_METER_WINDOW_MS = 30_000;
export const AUTO_METER_MIN_SECONDS = 10;
/** Below this share of the rate bought, the lanes note says the computer is the limit. */
export const AUTO_METER_NOTE = 0.95;
/** Below this share, Faster auto-eval's card says so (lower, so that it does not flicker). */
export const AUTO_METER_CARD = 0.9;

/**
 * A rolling count over the last 30 s of the evaluations auto-eval was due, counted only over time when
 * it had work and was not held, and of those it actually ran. In 1 s buckets, with times passed in.
 */
export class AutoMeter {
  private readonly buckets = new Map<number, { due: number; ran: number; secs: number }>();

  private bucket(now: number) {
    const k = Math.floor(now / 1000);
    let b = this.buckets.get(k);
    if (!b) this.buckets.set(k, (b = { due: 0, ran: 0, secs: 0 }));
    for (const old of this.buckets.keys()) if (old < k - AUTO_METER_WINDOW_MS / 1000 - 1) this.buckets.delete(old);
    return b;
  }

  /** `seconds` passed up to `now` with auto-eval working at `rate` evaluations a second. */
  addDue(now: number, rate: number, seconds: number): void {
    if (!(seconds > 0) || !(rate > 0)) return;
    const b = this.bucket(now);
    b.due += rate * seconds;
    b.secs += seconds;
  }

  /** `evals` evaluations of auto-eval ran, finishing at `now`. */
  addRan(now: number, evals: number): void {
    if (evals > 0) this.bucket(now).ran += evals;
  }

  /** The evaluations due and run over the window to `now`, and the seconds of work they cover. */
  summary(now: number): { due: number; ran: number; seconds: number } {
    const from = Math.floor((now - AUTO_METER_WINDOW_MS) / 1000);
    let due = 0;
    let ran = 0;
    let seconds = 0;
    for (const [k, b] of this.buckets)
      if (k > from && k <= Math.floor(now / 1000)) {
        due += b.due;
        ran += b.ran;
        seconds += b.secs;
      }
    return { due, ran, seconds };
  }

  clear(): void {
    this.buckets.clear();
  }
}

/** The share of the evaluations due that ran, or null while there is too little of auto-eval's work to tell. */
export function meterShare(s: { due: number; ran: number; seconds: number }): number | null {
  return s.seconds >= AUTO_METER_MIN_SECONDS && s.due > 0 ? s.ran / s.due : null;
}
