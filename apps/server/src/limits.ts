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
