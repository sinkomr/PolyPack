/**
 * The client's side of the PolyPack HTTP API. Every request has a 30 s timeout; network failures
 * and 5xx answers are retried with exponential backoff (2 s doubling to 60 s), and 429 answers
 * after a 65 s wait, at most three times. Submissions are paced. fetch, sleep and the clock are
 * injected, so that test/http.test.ts runs it against a fake server with a fake clock.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Problem } from "./types";
import { isSoftwareRefusal } from "./submit";

export interface Answer {
  status: number;
  /** The parsed JSON, or the text when it is not JSON. */
  body: unknown;
}

/** Resolves after `ms`, or rejects when `signal` aborts first. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
export const realSleep: Sleep = (ms, signal) => delay(ms, undefined, { signal });

export const RATE_LIMIT_WAIT_MS = 65_000;
export const RATE_LIMIT_RETRIES = 3;
export const MAX_BACKOFF_MS = 60_000;
export const SUBMISSIONS_PER_MINUTE = 6;

export interface HttpOptions {
  fetch?: typeof fetch;
  sleep?: Sleep;
  /** Milliseconds, for the submission pacer. */
  now?: () => number;
  log?: (message: string) => void;
  /** Aborts every request and every wait: the client is shutting down. */
  signal?: AbortSignal;
  userAgent?: string;
  /** Failed attempts (network errors, 5xx) after which a request gives up: 10 is about 6 minutes. */
  maxFailures?: number;
  timeoutMs?: number;
}

/**
 * Keeps the rate of submissions at or below `limit` per `windowMs`, over a sliding window;
 * acquisitions are served one at a time in call order. `block(ms)` holds every submission back,
 * as after a 429.
 */
export class Pacer {
  private sent: number[] = [];
  private blockedUntil = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  /** Milliseconds to wait before the next submission may be sent. */
  delay(): number {
    const t = this.now();
    while (this.sent.length && this.sent[0] <= t - this.windowMs) this.sent.shift();
    let d = Math.max(0, this.blockedUntil - t);
    if (this.sent.length >= this.limit) d = Math.max(d, this.sent[this.sent.length - this.limit] + this.windowMs - t);
    return d;
  }

  block(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }

  /** Resolves when one submission may be sent and counts it as sent. Rejects if `sleep` rejects. */
  acquire(): Promise<void> {
    const turn = this.chain.then(async () => {
      for (let d = this.delay(); d > 0; d = this.delay()) await this.sleep(d);
      this.sent.push(this.now());
    });
    this.chain = turn.catch(() => {});
    return turn;
  }
}

const describe = (error: unknown) => {
  const e = error as { message?: string; cause?: { code?: string; message?: string } };
  const cause = e?.cause?.code ?? e?.cause?.message;
  return `${e?.message ?? String(error)}${cause ? ` (${cause})` : ""}`;
};

export class Api {
  readonly pacer: Pacer;
  private readonly fetch: typeof fetch;
  private readonly sleep: Sleep;
  private readonly log: (message: string) => void;
  private readonly signal?: AbortSignal;
  private readonly userAgent: string;
  private readonly maxFailures: number;
  private readonly timeoutMs: number;

  constructor(
    readonly base: string,
    o: HttpOptions = {},
  ) {
    this.fetch = o.fetch ?? globalThis.fetch;
    this.sleep = o.sleep ?? realSleep;
    this.log = o.log ?? (() => {});
    this.signal = o.signal;
    this.userAgent = o.userAgent ?? "polypack-volunteer";
    this.maxFailures = o.maxFailures ?? 10;
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.pacer = new Pacer(SUBMISSIONS_PER_MINUTE, 60_000, o.now ?? Date.now, (ms) => this.sleep(ms, this.signal));
  }

  /**
   * One request, retried as described above. Returns the server's answer (any status below 500,
   * or the 429 that remains after three waits), or null when every attempt failed or the client
   * is shutting down. Never throws.
   */
  async request(method: "GET" | "POST", path: string, body?: unknown): Promise<Answer | null> {
    const url = this.base + path;
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { "user-agent": this.userAgent, accept: "application/json" };
    if (text !== undefined) headers["content-type"] = "application/json";
    let failures = 0;
    let limited = 0;
    for (;;) {
      if (this.signal?.aborted) return null;
      let problem: string;
      try {
        // every POST is a submission, and every attempt counts against the server's limit
        if (method === "POST") await this.pacer.acquire();
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const response = await this.fetch(url, {
          method,
          headers,
          body: text,
          signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
        });
        const raw = await response.text();
        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // not JSON: keep the text
        }
        if (response.status === 429 && limited < RATE_LIMIT_RETRIES) {
          limited++;
          this.log(
            `HTTP 429 (rate limit) from ${method} ${path}: waiting ${RATE_LIMIT_WAIT_MS / 1000} s ` +
              `(retry ${limited} of ${RATE_LIMIT_RETRIES})`,
          );
          // a POST waits through the pacer, so that every submission is held back
          if (method === "POST") this.pacer.block(RATE_LIMIT_WAIT_MS);
          else await this.sleep(RATE_LIMIT_WAIT_MS, this.signal);
          continue;
        }
        if (response.status < 500) return { status: response.status, body: parsed };
        problem = `HTTP ${response.status} from ${method} ${path}`;
      } catch (error) {
        if (this.signal?.aborted) return null;
        problem = `${method} ${path} failed: ${describe(error)}`;
      }
      failures++;
      if (failures >= this.maxFailures) {
        this.log(`${problem}; giving up after ${failures} attempts`);
        return null;
      }
      const wait = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (failures - 1));
      this.log(`${problem}; retrying in ${wait / 1000} s`);
      try {
        await this.sleep(wait, this.signal);
      } catch {
        return null;
      }
    }
  }

  targets(query = ""): Promise<Answer | null> {
    return this.request("GET", `/api/targets${query}`);
  }

  problem(p: Problem): Promise<Answer | null> {
    return this.request("GET", `/api/problems/${p.N}/${p.M}/${p.P}`);
  }

  entry(id: number): Promise<Answer | null> {
    return this.request("GET", `/api/submissions/${id}`);
  }

  /**
   * POST /api/submit. A server that does not yet accept `software` with found_with "optimizer"
   * refuses the body with exactly one known 400; the body is then sent once more without it.
   */
  async submit(body: Record<string, unknown>): Promise<{ answer: Answer | null; withoutSoftware: boolean }> {
    const answer = await this.request("POST", "/api/submit", body);
    if (!answer || !("software" in body) || !isSoftwareRefusal(answer.status, answer.body))
      return { answer, withoutSoftware: false };
    this.log('the server does not take "software" with optimizer entries yet: sending again without it');
    const { software: _software, ...rest } = body;
    return { answer: await this.request("POST", "/api/submit", rest), withoutSoftware: true };
  }
}

/** "0,3-6" from [0, 3, 4, 5, 6]: the filters as the work list's query takes them. */
export function compactList(values: readonly number[]): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(",");
}
