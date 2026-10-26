/**
 * Starts for the restarting methods (seed, penalty): the kernel's structured seeds (capability
 * "seeds") mixed with its random starts in a fixed share, and the iterations a descent may spend so
 * that its offer still fits in the evaluation budget.
 *
 * Seeds come in batches. A kernel may build its seeds from the random stream (the reference
 * kernel's lattice patches at random offsets) or list the same layouts on every call (rings, a
 * fixed set of symmetric layouts). Starts already given are skipped, so the second kind is not
 * repeated: a batch with nothing new doubles the request, and a doubled request with nothing new
 * ends the seeds; random starts take their place.
 */
import type { MethodContext } from "../framework";
import type { KernelState, SpaceKernel } from "../kernel";

/** The largest seed request, so a kernel with a long fixed list is not asked for ever more. */
const MAX_BATCH = 1024;
/** A nudge, as a share of the jitter: it breaks exact symmetry and keeps the layout. */
const NUDGE = 1e-4;

/** A short hash of a state's configuration, to recognise a seed given before. */
function signature(k: SpaceKernel, s: KernelState): string {
  const text = JSON.stringify(k.toConfig(s));
  // two 32-bit FNV-1a hashes with different offsets: about 64 bits, enough for thousands of seeds
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 13);
  }
  return `${a >>> 0}:${b >>> 0}:${text.length}`;
}

/**
 * The starts of a run. A structured start is moved by a seeded jitter of `jitter` piece steps: a
 * symmetric layout can hold a descent at a saddle, and some need a real knock (polyhedra seeds turn
 * every piece alike; docs/methods/dimensions/penalty.md). A given start is only nudged, by
 * NUDGE * jitter, which breaks exact symmetry and keeps the layout; random starts need neither.
 */
export class StartStream {
  private readonly queue: KernelState[] = [];
  private readonly seen = new Set<string>();
  private exhausted: boolean;
  private request: number;
  private count = 0;

  /**
   * `share` in [0, 1] is the fraction of starts taken from the seeds (of every 1/share starts, one
   * is a seed); `batch` is the seeds asked for at once; `jitter` the knock, in piece steps.
   */
  constructor(
    private readonly ctx: MethodContext,
    private readonly share: number,
    batch: number,
    private readonly jitter: number,
  ) {
    this.exhausted = !ctx.kernel.seeds || !(share > 0);
    this.request = batch;
  }

  /** The given start, nudged. */
  given(s: KernelState): KernelState {
    jiggleAll(this.ctx, s, NUDGE * this.jitter);
    return s;
  }

  /** The next start: a seed when the share calls for one and the kernel still gives new seeds, else a random start. */
  next(): KernelState {
    const t = this.count++;
    // start t is a seed when the running share passes an integer: with share 1/2, every other start
    const seeded = Math.floor((t + 1) * this.share) > Math.floor(t * this.share);
    const seed = seeded ? this.seed() : null;
    if (!seed) return this.ctx.kernel.randomStart(this.ctx.rng);
    jiggleAll(this.ctx, seed, this.jitter);
    return seed;
  }

  private seed(): KernelState | null {
    const k = this.ctx.kernel;
    let doubled = false;
    while (!this.queue.length && !this.exhausted) {
      // seeds are charged one evaluation each; near the end of the budget ask for no more than is left
      const n = Math.max(1, Math.min(this.request, Math.floor(this.ctx.remaining())));
      const fresh = k.seeds!(this.ctx.rng, n).filter((s) => {
        const key = signature(k, s);
        if (this.seen.has(key)) return false;
        this.seen.add(key);
        return true;
      });
      this.queue.push(...fresh);
      if (fresh.length) continue;
      if (doubled || this.request >= MAX_BATCH || n < this.request) this.exhausted = true;
      else {
        this.request = Math.min(MAX_BATCH, 2 * this.request);
        doubled = true;
      }
    }
    return this.queue.shift() ?? null;
  }
}

/**
 * L-BFGS iterations per solve for a descent of `solves` solves: `wanted`, or fewer so that the
 * descent and the offer after it fit in the evaluations left. A run's first descent (`first`) takes
 * at most half of what the offer leaves, so the run has a result early and can go on; all of it
 * when a second offer would not fit anyway. An iteration costs about 1.5 gradients with its line
 * search. At least 1, so a run with almost no budget still descends a little and offers once.
 * Without an evaluation budget, `wanted`.
 */
export function fitIterations(ctx: MethodContext, wanted: number, solves: number, first: boolean): number {
  const left = ctx.remaining();
  if (!Number.isFinite(left)) return wanted;
  const k = ctx.kernel;
  const offer = k.finishCost + (k.validateCost ?? k.finishCost);
  const spare = left - offer;
  const share = first && spare >= 2 * offer ? spare / 2 : spare;
  const perIteration = 1.5 * (k.gradCost ?? 1) * solves;
  return Math.max(1, Math.min(wanted, Math.floor(share / perIteration)));
}

/** Moves every piece by a uniform random amount of up to `amount` steps in each variable. */
function jiggleAll(ctx: MethodContext, s: KernelState, amount: number): void {
  if (!(amount > 0)) return;
  for (let i = 0; i < ctx.kernel.P; i++) ctx.kernel.jiggle(s, i, amount, ctx.rng);
}
