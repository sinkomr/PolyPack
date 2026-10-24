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
 * minute, saved up to a minute's worth. 2 s is 3% of a core's minute. Checking a valid board at
 * the orientation sent took 15 ms at most (500 100-gons on a ring, the largest hull a valid board
 * can have, when the hull of all its vertices has to be built; 1.5 ms otherwise) and 0.4 ms on
 * average over Tighter's largest problems (measured 2026-10-21), so even 120 boards a minute, all
 * the count limit lets through, stay below it. Boards of contested problems take under 1 ms.
 */
export const VERIFY_MS_PER_MINUTE = 2000;
/**
 * Event-loop delay (ms) above which new submissions are answered 503 with Retry-After. Ordinary
 * requests hold the loop for a few milliseconds at a time (a verification for 15 ms at most here,
 * two to three times that on a shared host CPU), so a longer delay means that work is queuing or
 * the host is throttling the CPU. Refusing the costly requests then keeps pages, live updates and
 * the health check (which fails after 5 s) answering. The reading of every problem's leader behind
 * the record holders count and the volunteers' work list (at most every HOLDERS_REFRESH_MS), the
 * ranking of that list (at most every TARGETS_REFRESH_MS) and the nightly records snapshot's
 * reading take longer on their own and may each refuse submissions for about two seconds.
 */
export const OVERLOAD_DELAY_MS = 250;
/** Retry-After (s) of the answer to a submission refused while the server is overloaded. */
export const OVERLOAD_RETRY_S = 5;
/**
 * Overlapping pairs the server looks for before rejecting. Finding every pair of a heavily
 * overlapping 500-piece configuration takes up to seconds; the first few are found at once.
 */
export const MAX_REPORTED_OVERLAPS = 20;
