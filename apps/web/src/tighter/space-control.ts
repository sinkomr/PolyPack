/**
 * The control word of a space run, in memory the page and the lane's worker share. The run is
 * synchronous code that blocks inside the method framework's stop poll, so it cannot read a message
 * while it works: the page steps, holds and ends it through these slots and wakes it with
 * Atomics.notify (space-run.ts waits on the epoch slot). Kept apart from space-run.ts so that the
 * page does not load the search code.
 */
const ALLOWED = 0;
const ABORTED = 1;
const HELD = 2;
const EPOCH = 3;

/** Largest allowance the Int32 slot holds. */
const MAX_ALLOWED = 2 ** 31 - 1;

export class SpaceRunControl {
  readonly buffer: SharedArrayBuffer;
  private readonly slots: Int32Array;

  constructor(buffer?: SharedArrayBuffer) {
    this.buffer = buffer ?? new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
    this.slots = new Int32Array(this.buffer);
  }

  private bump(): void {
    Atomics.add(this.slots, EPOCH, 1);
    Atomics.notify(this.slots, EPOCH);
  }

  /** Kernel evaluations the run may have used in all (never lowered). */
  allow(total: number): void {
    Atomics.store(
      this.slots,
      ALLOWED,
      Math.max(Atomics.load(this.slots, ALLOWED), Math.min(MAX_ALLOWED, Math.floor(total))),
    );
    this.bump();
  }

  /** While held the run does nothing, whatever it is allowed. */
  hold(held: boolean): void {
    Atomics.store(this.slots, HELD, held ? 1 : 0);
    this.bump();
  }

  /** Ends the run at its next poll. */
  abort(): void {
    Atomics.store(this.slots, ABORTED, 1);
    this.bump();
  }

  get allowed(): number {
    return Atomics.load(this.slots, ALLOWED);
  }
  get held(): boolean {
    return Atomics.load(this.slots, HELD) === 1;
  }
  get aborted(): boolean {
    return Atomics.load(this.slots, ABORTED) === 1;
  }

  /** The change counter: read it before reading the other slots, then wait on it. */
  epoch(): number {
    return Atomics.load(this.slots, EPOCH);
  }

  /** Blocks until the epoch is no longer `epoch` (returns at once when it already is not). Worker only. */
  wait(epoch: number): void {
    Atomics.wait(this.slots, EPOCH, epoch);
  }
}
