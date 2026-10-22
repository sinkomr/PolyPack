/**
 * Active time: seconds since the clock was made, not counting the intervals during which it was
 * paused. The engine measures its time limits with it, so that a search paused on battery power
 * resumes with the time it had left. The base clock is injected for tests.
 */
export class ActiveClock {
  private readonly origin: number;
  private pausedAt: number | null = null;
  private pausedTotal = 0;

  constructor(private readonly base: () => number = () => performance.now() / 1000) {
    this.origin = base();
  }

  /** Active seconds, monotonic; frozen while paused. */
  now(): number {
    const t = this.base();
    const pausing = this.pausedAt === null ? 0 : t - this.pausedAt;
    return t - this.origin - this.pausedTotal - pausing;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  pause(): void {
    if (this.pausedAt === null) this.pausedAt = this.base();
  }

  resume(): void {
    if (this.pausedAt === null) return;
    this.pausedTotal += this.base() - this.pausedAt;
    this.pausedAt = null;
  }
}
