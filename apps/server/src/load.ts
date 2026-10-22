/**
 * How late the event loop runs. A timer due every `tickMs` notes how much later than due it ran: a
 * computation that holds the loop, or a host that throttles the CPU, delays the next tick by as
 * long. (perf_hooks' monitorEventLoopDelay measures the same, but its reset also drops the interval
 * in progress, which would hide a hold of the loop that begins just after a reading.)
 */
export class LoopDelay {
  private timer: ReturnType<typeof setInterval>;
  private due: number;
  /** Longest delay in the current window and in the one before it. */
  private current = 0;
  private previous = 0;
  private windowEnd: number;
  /** Longest delay since `takePeak` was last called. */
  private peak = 0;

  constructor(
    private tickMs = 20,
    private windowMs = 1000,
    private now: () => number = () => performance.now(),
  ) {
    const t = now();
    this.due = t + tickMs;
    this.windowEnd = t + windowMs;
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref?.();
  }

  private tick(): void {
    const t = this.now();
    if (t >= this.windowEnd) {
      // a window without a tick (the loop held for longer) leaves nothing to carry over
      this.previous = t >= this.windowEnd + this.windowMs ? 0 : this.current;
      this.current = 0;
      this.windowEnd = t + this.windowMs;
    }
    const late = Math.max(0, t - this.due);
    this.current = Math.max(this.current, late);
    this.peak = Math.max(this.peak, late);
    this.due = t + this.tickMs;
  }

  /**
   * The longest delay of about the last one to two seconds (ms). A hold that has just ended, whose
   * delayed tick has not run yet, counts already.
   */
  ms(): number {
    return Math.max(this.current, this.previous, this.now() - this.due);
  }

  /** The longest delay since the last call (ms). */
  takePeak(): number {
    const p = Math.max(this.peak, this.now() - this.due);
    this.peak = 0;
    return p;
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

/** Verification times kept for one minute's percentiles; more are counted but not kept. */
const MAX_SAMPLES = 100_000;

const fmtMs = (x: number) => `${x < 10 ? x.toFixed(2) : x.toFixed(1)} ms`;

/** The value below which a share `q` of the sorted values lie (nearest rank). */
function percentile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/**
 * What the server did with submissions, for the log: one line per POST /api/submit, with its
 * status, its time and its problem (never a name or an address), and one line a minute with the
 * counts by status and the percentiles of verification time, so that production load can be read.
 */
export class LoadStats {
  private statuses = new Map<number, number>();
  private verify: number[] = [];
  private verifyCount = 0;
  private verifyTotal = 0;
  private leaderChanges = 0;
  private streams = 0;

  constructor(private write: (line: string) => void) {}

  /** One answered submission. `problem` is "N/M/P", or null when the body did not name one. */
  submission(s: { status: number; ms: number; verifyMs: number | null; problem: string | null }): void {
    this.write(
      `[submit] ${s.status} ${s.problem ?? "-"} ${fmtMs(s.ms)}` +
        (s.verifyMs === null ? "" : `, verification ${fmtMs(s.verifyMs)}`),
    );
    this.statuses.set(s.status, (this.statuses.get(s.status) ?? 0) + 1);
    if (s.verifyMs !== null) {
      this.verifyCount++;
      this.verifyTotal += s.verifyMs;
      if (this.verify.length < MAX_SAMPLES) this.verify.push(s.verifyMs);
    }
  }

  /** A problem got a new leader. */
  leaderChanged(): void {
    this.leaderChanges++;
  }

  /** A live-update stream opened (+1) or closed (-1). */
  stream(change: 1 | -1): void {
    this.streams += change;
  }

  /**
   * The minute's line, then the counts start again. Nothing is written for a minute without
   * submissions while no live-update stream is open. `delayMs` is the longest event-loop delay of
   * the minute.
   */
  flush(delayMs: number): void {
    const count = [...this.statuses.values()].reduce((a, b) => a + b, 0);
    if (count || this.streams) {
      const byStatus = [...this.statuses]
        .sort(([a], [b]) => a - b)
        .map(([status, n]) => `${status}: ${n}`)
        .join(", ");
      const sorted = this.verify.sort((a, b) => a - b);
      const times = sorted.length
        ? `verification p50 ${fmtMs(percentile(sorted, 0.5))}, p90 ${fmtMs(percentile(sorted, 0.9))}, ` +
          `p99 ${fmtMs(percentile(sorted, 0.99))}, max ${fmtMs(sorted[sorted.length - 1])}, ` +
          `${fmtMs(this.verifyTotal)} in all over ${this.verifyCount} boards`
        : "no verification";
      this.write(
        `[load] last minute: ${count} submission${count === 1 ? "" : "s"}${count ? ` (${byStatus})` : ""}; ${times}; ` +
          `${this.leaderChanges} leader change${this.leaderChanges === 1 ? "" : "s"}; ${this.streams} live stream${this.streams === 1 ? "" : "s"}; ` +
          `event loop delay up to ${fmtMs(delayMs)}`,
      );
    }
    this.statuses.clear();
    this.verify = [];
    this.verifyCount = 0;
    this.verifyTotal = 0;
    this.leaderChanges = 0;
  }
}
