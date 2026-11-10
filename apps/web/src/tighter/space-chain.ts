import { type SpaceKernel, runMethod } from "@polypack/methods";
import type { SpaceConfig } from "@polypack/spaces";
import {
  type SearchProblem,
  checkSpaceConfig,
  checkSpaceMethod,
  isAutoMethod,
  parseSearchProblem,
  readSpaceConfig,
  spaceKernel,
  spaceKernelError,
} from "@polypack/spaces/search";
import { type ChainEvent, chainLinkEvals, chainLinkSeed } from "./space-chain-core";
import type { SpaceRunRequest, SpaceRunState } from "./space-run-types";

/**
 * A space run for a page that cannot share memory with the worker (space-chain-core.ts): a chain of
 * links, each a fresh run of the request's method (packages/methods) from the best board of the
 * chain, with a seed derived from the request's. Same kernel under the server's rule as SpaceRun
 * (space-run.ts), so every best the chain keeps is strict, and a chain is reproducible from its
 * request and the page's allowances.
 *
 * Nothing in the worker blocks: a link is synchronous code, but between links the worker yields to
 * its event loop, so the page's allowances and its close get in. A link starts only once the
 * allowance has passed the end of the chain so far, so the worker is at most one link ahead of what
 * the page has paid for. Events go to the page as they happen, and the page reveals them up to its
 * allowance (chainStateAt).
 */

const RULE = { noRecord: true } as const;

/** The least time between two progress events during a link. */
const HEARTBEAT_MS = 100;

export class ChainedSpaceRun {
  readonly params: Record<string, unknown>;
  private readonly p: SearchProblem;
  private readonly kernel: SpaceKernel;
  private readonly start: SpaceConfig | null;
  private readonly linkEvals: number;
  /** The most kernel evaluations the page has allowed in all. */
  private allowed = 0;
  /** Kernel evaluations at the end of the last link. */
  private computed = 0;
  /** Kernel evaluations in the running link so far (the framework's count at its latest poll). */
  private inLink = 0;
  private links = 0;
  private best: SpaceConfig | null = null;
  private score: number | null = null;
  private last: number | null = null;
  private found: number | null = null;
  private offers = 0;
  private ended = false;
  private closed = false;
  private error: string | undefined;
  private lastBeat = 0;
  private wake: (() => void) | null = null;

  constructor(
    readonly request: SpaceRunRequest,
    private readonly emit: (event: ChainEvent) => void,
  ) {
    const parsed = parseSearchProblem(request.id);
    if (!parsed || parsed.space !== request.family)
      throw new Error(`not a problem of ${request.family}: ${String(request.id).slice(0, 80)}`);
    const p = parsed;
    const kernel = spaceKernel(p);
    if (!kernel) throw new Error(spaceKernelError(p) ?? `${request.id} has no kernel`);
    if (isAutoMethod(p.space, request.method)) throw new Error("a space run needs one of the generic methods");
    const why = checkSpaceMethod(p, request.method, request.params);
    if (why) throw new Error(why);
    if (!Number.isInteger(request.unit) || request.unit < 1) throw new Error("unit must be a positive whole number");
    this.p = p;
    this.params = structuredClone(request.params);
    this.start = request.start === null ? null : readSpaceConfig(p, request.start);
    if (request.start !== null && !this.start) throw new Error("the start is not a configuration of this problem");
    this.kernel = {
      ...kernel,
      validate: (config) => checkSpaceConfig(p.space, p.id, config, RULE),
      finish: (s, poll) => {
        // the finish is charged before it runs: its offer is at the count after the charge
        this.inLink += kernel.finishCost;
        const f = kernel.finish(s, poll);
        if (f) this.offered(f.config as SpaceConfig, f.score);
        return f;
      },
    };
    this.linkEvals = chainLinkEvals(kernel, request.unit);
    if (this.start) {
      const c = checkSpaceConfig(p.space, p.id, this.start, RULE);
      if (c.valid && c.score !== null) {
        this.best = structuredClone(this.start);
        this.score = c.score;
        this.last = c.score;
      }
    }
  }

  /** The state of the chain as computed, not as revealed to the page. */
  state(): SpaceRunState {
    return {
      kind: "space",
      evaluations: Math.floor((this.computed + this.inLink) / this.request.unit),
      best: this.best ? structuredClone(this.best) : null,
      score: this.score,
      last: this.last,
      found: this.found,
      offers: this.offers,
      ended: this.ended,
      closed: this.closed,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Allows the chain `total` game evaluations in all (never lowered). */
  allow(total: number): void {
    this.allowed = Math.max(this.allowed, Math.floor(total) * this.request.unit);
    this.wake?.();
  }

  /** Ends the chain: at its next break between links (a running link cannot be interrupted). */
  close(): void {
    this.closed = true;
    this.wake?.();
  }

  private at(): number {
    return this.computed + this.inLink;
  }

  private offered(config: SpaceConfig, score: number): void {
    this.last = score;
    // the strictness test is the costly part: only for a score that would be the chain's best find
    if (this.found === null || score < this.found) {
      const c = checkSpaceConfig(this.p.space, this.p.id, config, RULE);
      if (c.valid && c.score !== null) this.found = score;
    }
  }

  private beat(used: number): void {
    // the framework's count is exact where mine was estimated
    this.inLink = Math.max(this.inLink, used);
    const t = Date.now();
    if (t - this.lastBeat >= HEARTBEAT_MS) {
      this.lastBeat = t;
      this.emit({ k: "progress", at: this.at() });
    }
  }

  /** One link, from the chain's best (or the request's start for the first); false when the chain is over. */
  private link(): boolean {
    const { request } = this;
    const unit = request.unit;
    const total = request.budget.evals * unit;
    const room = total - this.computed;
    if (room < 1) return false;
    const evals = Math.min(this.linkEvals, Math.ceil(room));
    const start = this.best ?? this.start;
    const t = performance.now();
    this.inLink = 0;
    let stopped = "";
    try {
      const r = runMethod(this.kernel, request.method, {
        seed: chainLinkSeed(request.seed, this.links),
        params: request.params,
        ...(start ? { start } : {}),
        budget: { evals, time_s: 3600 },
        shouldStop: (used) => {
          this.beat(used);
          return this.closed;
        },
        onOffer: () => {
          this.offers++;
          this.emit({ k: "offer", at: this.at(), last: this.last!, found: this.found });
        },
        onImprove: (f) => {
          // the validation of an improvement is charged before it is kept
          this.inLink += this.kernel.validateCost ?? this.kernel.finishCost;
          this.best = structuredClone(f.config as SpaceConfig);
          this.score = f.score;
          this.emit({ k: "best", at: this.at(), config: this.best, score: f.score });
        },
      });
      stopped = r.stopped;
      if (r.stopped === "error") this.error = r.reasons.join("; ") || "the method failed";
      this.inLink = Math.max(this.inLink, r.evaluations);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      stopped = "error";
    }
    const used = this.inLink;
    this.computed += used;
    this.inLink = 0;
    this.links++;
    this.emit({ k: "link", at: this.computed, evals: used, ms: performance.now() - t });
    // a link that ran its whole budget goes on while the chain has room; any other end (the method done, the bound, an error) ends the chain
    return stopped === "evals" && used > 0 && room - used >= 1;
  }

  /** Runs the chain to its end, one link at a time as the page allows; resolves when it ends or is closed. */
  async run(): Promise<SpaceRunState> {
    try {
      while (!this.closed) {
        // a break for the event loop, so that allowances and a close get in between links
        await new Promise<void>((r) => setTimeout(r, 0));
        if (this.closed) break;
        if (this.allowed <= this.computed) {
          await new Promise<void>((r) => (this.wake = r));
          this.wake = null;
          continue;
        }
        if (!this.link()) {
          this.ended = true;
          break;
        }
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.ended = true;
    }
    if (this.ended) this.emit({ k: "end", at: this.computed, ...(this.error ? { error: this.error } : {}) });
    return this.state();
  }
}
