/**
 * The client's side of the PolyPack HTTP API. Every request has a 30 s timeout and an answer of at
 * most 16 MB. A 429 is retried after a 65 s wait, at most three times. A GET is also retried after
 * network failures, timeouts and 5xx answers, with exponential backoff (2 s doubling to 60 s), and
 * gives up after 10 failed attempts.
 *
 * A POST is never sent again blindly: after such a failure the server may have stored it. submit()
 * reads the problem first, and sends again only when the packing is not there (see SubmitCheck).
 * Submissions are paced. fetch, sleep and the clock are injected, so that test/http.test.ts runs
 * it against a fake server with a fake clock.
 */
import { setTimeout as delay } from "node:timers/promises";
import { type SubmitCheck, isSoftwareRefusal } from "./submit";
import type { Problem } from "./types";

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
export const MAX_ANSWER_BYTES = 16 * 1024 * 1024;
/** POSTs of one submission whose fate stayed unknown, each followed by a re-read of the problem. */
export const MAX_SUBMIT_ATTEMPTS = 3;

export interface HttpOptions {
  fetch?: typeof fetch;
  sleep?: Sleep;
  /** Milliseconds, for the submission pacer. */
  now?: () => number;
  log?: (message: string) => void;
  /** Aborts every request and every wait: the client is shutting down. */
  signal?: AbortSignal;
  userAgent?: string;
  /** Failed attempts (network errors, 5xx) after which a GET gives up: 10 is about 6 minutes. */
  maxFailures?: number;
  timeoutMs?: number;
  maxAnswerBytes?: number;
  /** Called once, with the server's explanation, when it answers 426: this client works in units the server has left. */
  onUpgradeRequired?: (message: string) => void;
}

/** How one submission went. */
export interface SubmitOutcome {
  /** The server's answer to the last POST, when one came. */
  answer: Answer | null;
  /** POST requests actually made (none when the client stopped first). */
  requests: number;
  /** Whether `software` was dropped for a server that refuses it. */
  withoutSoftware: boolean;
  /** Why the last POST got no answer. */
  failure: string | null;
  /** What the re-read found after the last POST without an answer; null when it was not read. */
  check: SubmitCheck | null;
}

/** One request's result: an answer below 500, or a failure and whether the request went out. */
type Attempt = { kind: "answer"; answer: Answer } | { kind: "failed"; why: string; sent: boolean };

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

/** The body as text, refusing more than `max` bytes. */
async function readCapped(response: Response, max: number): Promise<string> {
  const tooLarge = () => new Error(`the answer is larger than ${Math.round(max / 1048576)} MB`);
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class Api {
  readonly pacer: Pacer;
  private readonly fetch: typeof fetch;
  private readonly sleep: Sleep;
  private readonly log: (message: string) => void;
  private readonly signal?: AbortSignal;
  private readonly userAgent: string;
  private readonly maxFailures: number;
  private readonly timeoutMs: number;
  private readonly maxAnswerBytes: number;
  private readonly onUpgradeRequired?: (message: string) => void;
  private upgradeReported = false;

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
    this.maxAnswerBytes = o.maxAnswerBytes ?? MAX_ANSWER_BYTES;
    this.onUpgradeRequired = o.onUpgradeRequired;
    this.pacer = new Pacer(SUBMISSIONS_PER_MINUTE, 60_000, o.now ?? Date.now, (ms) => this.sleep(ms, this.signal));
  }

  /** One request, never retried here. */
  private async attempt(method: "GET" | "POST", path: string, body?: unknown): Promise<Attempt> {
    if (this.signal?.aborted) return { kind: "failed", why: "the client is stopping", sent: false };
    const headers: Record<string, string> = { "user-agent": this.userAgent, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const response = await this.fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
      });
      const raw = await readCapped(response, this.maxAnswerBytes);
      if (response.status >= 500)
        return { kind: "failed", why: `HTTP ${response.status} from ${method} ${path}`, sent: true };
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // not JSON: keep the text
      }
      if (response.status === 426 && !this.upgradeReported) {
        // 426: the server has changed units (2026-10-27) and takes this client's packings as valid but poor, or not at all
        this.upgradeReported = true;
        const said = (parsed as { error?: unknown; reasons?: unknown } | null)?.error;
        this.onUpgradeRequired?.(typeof said === "string" ? said : "the server requires a newer client");
      }
      return { kind: "answer", answer: { status: response.status, body: parsed } };
    } catch (error) {
      return { kind: "failed", why: `${method} ${path} failed: ${describe(error)}`, sent: true };
    }
  }

  private rateLimited(method: string, path: string, retry: number): string {
    return (
      `HTTP 429 (rate limit) from ${method} ${path}: waiting ${RATE_LIMIT_WAIT_MS / 1000} s ` +
      `(retry ${retry} of ${RATE_LIMIT_RETRIES})`
    );
  }

  /**
   * A GET, retried as described above. Returns the server's answer (any status below 500, or the
   * 429 that remains after three waits), or null when every attempt failed or the client is
   * shutting down. Never throws.
   */
  async get(path: string): Promise<Answer | null> {
    let failures = 0;
    let limited = 0;
    for (;;) {
      if (this.signal?.aborted) return null;
      const a = await this.attempt("GET", path);
      if (a.kind === "answer") {
        if (a.answer.status !== 429 || limited >= RATE_LIMIT_RETRIES) return a.answer;
        limited++;
        this.log(this.rateLimited("GET", path, limited));
        try {
          await this.sleep(RATE_LIMIT_WAIT_MS, this.signal);
        } catch {
          return null;
        }
        continue;
      }
      if (this.signal?.aborted) return null;
      failures++;
      if (failures >= this.maxFailures) {
        this.log(`${a.why}; giving up after ${failures} attempts`);
        return null;
      }
      const wait = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (failures - 1));
      this.log(`${a.why}; retrying in ${wait / 1000} s`);
      try {
        await this.sleep(wait, this.signal);
      } catch {
        return null;
      }
    }
  }

  /**
   * One POST through the pacer. A 429 means nothing was stored: it is sent again after 65 s, at
   * most three times, and every submission waits with it. Any other failure is returned as it is.
   */
  async post(
    path: string,
    body: unknown,
  ): Promise<{ answer: Answer | null; failure: string | null; requests: number }> {
    let limited = 0;
    let requests = 0;
    for (;;) {
      try {
        await this.pacer.acquire();
      } catch {
        return { answer: null, failure: "the client is stopping", requests };
      }
      const a = await this.attempt("POST", path, body);
      if (a.kind === "failed") return { answer: null, failure: a.why, requests: requests + (a.sent ? 1 : 0) };
      requests++;
      if (a.answer.status !== 429 || limited >= RATE_LIMIT_RETRIES)
        return { answer: a.answer, failure: null, requests };
      limited++;
      this.log(this.rateLimited("POST", path, limited));
      this.pacer.block(RATE_LIMIT_WAIT_MS);
    }
  }

  targets(query = ""): Promise<Answer | null> {
    return this.get(`/api/targets${query}`);
  }

  problem(p: Problem): Promise<Answer | null> {
    return this.get(`/api/problems/${p.N}/${p.M}/${p.P}`);
  }

  entry(id: number): Promise<Answer | null> {
    return this.get(`/api/submissions/${id}`);
  }

  /** GET /api/spaces/targets, the optional work list of the new spaces. */
  spaceTargets(query = ""): Promise<Answer | null> {
    return this.get(`/api/spaces/targets${query}`);
  }

  /** GET /api/spaces/:space/problems/<id>; the id has passed parseSpaceId, so it needs no escaping. */
  spaceProblem(space: string, id: string): Promise<Answer | null> {
    return this.get(`/api/spaces/${space}/problems/${id}`);
  }

  /**
   * POST /api/submit, or `path` (POST /api/spaces/submit). A server older than the client refuses `software` with found_with
   * "optimizer" with exactly one known 400; the body is then sent once more without it.
   *
   * When a POST goes out but no answer comes back (a network error, a timeout, a 5xx), the server
   * may have stored the packing. `check` then reads the problem, and the POST is sent again, after
   * a backoff, only when the packing is not there and could still lead: at most
   * MAX_SUBMIT_ATTEMPTS POSTs in all.
   */
  async submit(
    body: Record<string, unknown>,
    check: () => Promise<SubmitCheck | null>,
    path = "/api/submit",
  ): Promise<SubmitOutcome> {
    let current = body;
    let withoutSoftware = false;
    let requests = 0;
    let checked: SubmitCheck | null = null;
    for (let attempt = 1; ;) {
      const r = await this.post(path, current);
      requests += r.requests;
      if (r.answer) {
        if (withoutSoftware || !("software" in current) || !isSoftwareRefusal(r.answer.status, r.answer.body))
          return { answer: r.answer, requests, withoutSoftware, failure: null, check: null };
        this.log('the server does not take "software" with optimizer entries yet: sending again without it');
        const { software: _software, ...rest } = current;
        current = rest;
        withoutSoftware = true;
        continue;
      }
      const outcome = (): SubmitOutcome => ({
        answer: null,
        requests,
        withoutSoftware,
        failure: r.failure,
        check: checked,
      });
      // nothing went out, or the client is stopping and can no longer read the problem
      if (r.requests === 0 || this.signal?.aborted) return outcome();
      this.log(`${r.failure}: the server may have stored the packing; reading the problem before sending it again`);
      checked = await check();
      if (!checked || checked.state !== "absent" || attempt >= MAX_SUBMIT_ATTEMPTS) return outcome();
      attempt++;
      const wait = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (attempt - 2));
      this.log(
        `It was not stored: sending it again in ${wait / 1000} s (attempt ${attempt} of ${MAX_SUBMIT_ATTEMPTS})`,
      );
      try {
        await this.sleep(wait, this.signal);
      } catch {
        return outcome();
      }
    }
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
