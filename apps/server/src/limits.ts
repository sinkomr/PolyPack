import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";

/** Fixed-window rate limiter kept in memory. Good for one server process. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Records one hit; returns false when the key is over its limit. */
  allow(key: string): boolean {
    const t = this.now();
    if (this.hits.size > 10000) {
      for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    }
    const h = this.hits.get(key);
    if (!h || h.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return true;
    }
    h.count++;
    return h.count <= this.max;
  }
}

/**
 * Milliseconds of work each key may cause, refilled continuously at `perMinute` a minute, with at
 * most `perMinute` saved up. Work is charged after it is done, so one long piece of work can take a
 * key below zero; the key then waits until its balance is positive again.
 */
export class TimeBudget {
  private balances = new Map<string, { ms: number; at: number }>();

  constructor(
    private perMinute: number,
    private now: () => number = Date.now,
  ) {}

  private balance(key: string, t: number): number {
    const b = this.balances.get(key);
    return b ? Math.min(this.perMinute, b.ms + ((t - b.at) * this.perMinute) / 60_000) : this.perMinute;
  }

  /** Whole seconds until `key` may start more work; 0 when it may now. */
  wait(key: string): number {
    const ms = this.balance(key, this.now());
    return ms > 0 ? 0 : Math.max(1, Math.ceil((-ms * 60) / this.perMinute));
  }

  /** Charges `key` for `ms` milliseconds of work. */
  charge(key: string, ms: number): void {
    const t = this.now();
    if (this.balances.size > 10000) {
      for (const k of [...this.balances.keys()]) if (this.balance(k, t) >= this.perMinute) this.balances.delete(k);
    }
    this.balances.set(key, { ms: this.balance(key, t) - ms, at: t });
  }
}

/**
 * The key an address is limited by: an IPv4 address as it is, an IPv6 address by its /64 prefix,
 * since one connection is usually given a whole /64. An IPv4 address written as IPv6
 * (::ffff:1.2.3.4) counts as IPv4. Anything else is its own key.
 */
export function addressKey(ip: string): string {
  const text = ip
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/%.*$/, "");
  if (!text.includes(":")) return text;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (mapped) return mapped[1];
  const halves = text.split("::");
  if (halves.length > 2) return text;
  // an IPv4 address at the end (64:ff9b::1.2.3.4) takes the place of two groups
  const groups = (s: string) => (s ? s.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : []);
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...Array<string>(Math.max(0, fill)).fill("0"), ...tail];
  if (fill < 0 || all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return text;
  return `${all
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

export const MAX_BODY_BYTES = 256 * 1024;

/** hono/body-limit at MAX_BODY_BYTES; its answer when the body is larger only marks that case. */
const limitBody = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: () => new Response(null, { status: 413 }) });

/**
 * The request body as text, or null when it is larger than MAX_BODY_BYTES. A body sent without a
 * Content-Length (chunked) is read only up to the limit, so an endless one cannot fill the memory;
 * with a Content-Length above the limit nothing is read.
 */
export async function readBodyWithin(c: Context): Promise<string | null> {
  const over = await limitBody(c, async () => {});
  if (over) return null;
  const text = await c.req.text();
  return text.length > MAX_BODY_BYTES ? null : text;
}
export const MAX_NAME_LENGTH = 40;
export const MAX_NOTE_LENGTH = 200;

/**
 * Display text from an untrusted string: control characters and angle brackets removed,
 * whitespace collapsed, length capped. The client also only ever inserts names as text.
 */
export function sanitizeText(raw: string, maxLength: number): string {
  return raw
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}
/** Submissions per minute from one address. Cloud batch sessions may share one address. */
export const SUBMISSIONS_PER_MINUTE = 120;
/**
 * Milliseconds of verification (the geometry check of submissions) one address may cause a
 * minute, saved up to a minute's worth. 4 s is 6.7% of a core's minute. Checking a valid board at
 * the orientation sent took 15 ms at most (500 100-gons on a ring, the largest hull a valid board
 * can have, when the hull of all its vertices has to be built; 1.5 ms otherwise) and 0.4 ms on
 * average over Tighter's largest problems (measured 2026-10-21), so even 120 boards a minute, all
 * the count limit lets through, stay below it. Boards of contested problems take under 1 ms.
 */
// [CALC] A strict P = 500 polyhedra entry needs two passes, about 1.4 s together.
// Four seconds per minute allows a few such entries, at most 6.7% of a core.
export const VERIFY_MS_PER_MINUTE = 4000;
/**
 * The header that carries the server's submit key (SUBMIT_KEY), which the operator gives to a
 * submitter who needs more than an address's limits. A submission that carries it counts against
 * the key's limits below, wherever it comes from, instead of its address's.
 */
export const SUBMIT_KEY_HEADER = "x-submit-key";
/**
 * Submissions per minute with the submit key, all its holders together. Measured 2026-11-08 on the
 * live server: about 540 submissions a minute from everyone, the busiest hour at 7-11% CPU and the
 * event loop delayed 84-220 ms at most (OVERLOAD_DELAY_MS is 250), so 600 more a minute still
 * leaves the overload refusal (503) as the brake when it is too much.
 */
export const KEYED_SUBMISSIONS_PER_MINUTE = 600;
/** Verification a minute with the submit key: the address's budget in the same ratio as the count (20 s). */
export const KEYED_VERIFY_MS_PER_MINUTE =
  (VERIFY_MS_PER_MINUTE * KEYED_SUBMISSIONS_PER_MINUTE) / SUBMISSIONS_PER_MINUTE;
/** A shorter SUBMIT_KEY is not used: a key is a secret that a guess must not find. */
export const MIN_SUBMIT_KEY_LENGTH = 32;

/** The limits one submission counts against. */
export interface Submitter {
  /** What its count and its verification are kept under: the address, or the submit key. */
  key: string;
  count: RateLimiter;
  budget: TimeBudget;
  /** For the reasons of a refusal: "from this address" or "with this submit key". */
  from: string;
}

/**
 * Chooses the limits of a submission: the submit key's when it carries the server's key, its
 * address's when it carries none, and none (null: the caller answers 401) when it carries a key
 * that is not the server's. A wrong key still counts against the address, so that guessing keys
 * is held to the address's limit.
 */
export class SubmitLimits {
  readonly address: RateLimiter;
  readonly addressBudget: TimeBudget;
  private keyed: RateLimiter;
  private keyedBudget: TimeBudget;

  constructor(
    private submitKey: string | undefined,
    limits: {
      perIp: number;
      windowMs: number;
      verifyMsPerMinute: number;
      perKey: number;
      keyVerifyMsPerMinute: number;
    },
  ) {
    this.address = new RateLimiter(limits.perIp, limits.windowMs);
    this.addressBudget = new TimeBudget(limits.verifyMsPerMinute);
    this.keyed = new RateLimiter(limits.perKey, limits.windowMs);
    this.keyedBudget = new TimeBudget(limits.keyVerifyMsPerMinute);
  }

  of(address: string, givenKey: string | undefined): Submitter | null {
    if (givenKey === undefined)
      return { key: address, count: this.address, budget: this.addressBudget, from: "from this address" };
    if (!this.submitKey || !constantTimeEqual(givenKey, this.submitKey)) {
      this.address.allow(address);
      return null;
    }
    return { key: "submit-key", count: this.keyed, budget: this.keyedBudget, from: "with this submit key" };
  }
}

/** String equality whose time does not depend on where the strings first differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
/**
 * Event-loop delay (ms) above which new submissions are answered 503 with Retry-After. Ordinary
 * requests hold the loop for a few milliseconds at a time (a verification for 15 ms at most here,
 * two to three times that on a shared host CPU), so a longer delay means that work is queuing or
 * the host is throttling the CPU. Refusing the costly requests then keeps pages, live updates and
 * the health check (which fails after 5 s) answering. The nightly records snapshot's reading takes
 * longer on its own and may refuse submissions for about two seconds.
 */
export const OVERLOAD_DELAY_MS = 250;
/** Retry-After (s) of the answer to a submission refused while the server is overloaded. */
export const OVERLOAD_RETRY_S = 5;
/**
 * Overlapping pairs the server looks for before rejecting. Finding every pair of a heavily
 * overlapping 500-piece configuration takes up to seconds; the first few are found at once.
 */
export const MAX_REPORTED_OVERLAPS = 20;
