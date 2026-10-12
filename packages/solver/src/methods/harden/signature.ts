import type { PackingConfig } from "@polypack/geometry";

/**
 * Bounded memory of the arrangements a run has already had scored, for duplicate suppression.
 *
 * Each arrangement is kept as a 64-bit hash of its float64 pose values (two 32-bit halves, at most
 * 15 characters) instead of its full text, which at P = 500 is about 29,000 characters. Zero and
 * negative zero hash alike and circle angles are left out, so two arrangements share a hash
 * input exactly when their scored poses are equal numbers. A hash collision between different
 * arrangements can therefore only make the method skip one re-assessment; it can never cause an
 * invalid submission, because nothing here decides what is valid. The hash reads no clock and no
 * random number, so a seeded evaluation-budget run stays reproducible (on a machine of the other
 * byte order the hash values differ, but equal arrangements still collide and others still do not).
 */
export class SeenArrangements {
  private readonly keys = new Set<string>();
  private values = new Float64Array(0);
  private words = new Uint32Array(0);

  constructor(
    private readonly N: number,
    /** Most hashes retained; the oldest is forgotten first. */
    readonly limit = 16384,
  ) {}

  get size(): number {
    return this.keys.size;
  }

  /** Characters held by the retained hashes. */
  get retained(): number {
    let characters = 0;
    for (const key of this.keys) characters += key.length;
    return characters;
  }

  /** 64-bit hash of the poses as two base-36 halves (the mixing of the public-domain cyrb53). */
  key(config: PackingConfig): string {
    const stride = this.N === 0 ? 2 : 3;
    const count = stride * config.pieces.length;
    if (this.values.length !== count) {
      this.values = new Float64Array(count);
      this.words = new Uint32Array(this.values.buffer);
    }
    const { values, words } = this;
    for (let i = 0; i < config.pieces.length; i++) {
      const p = config.pieces[i];
      // Adding zero maps -0 to +0, the one case where equal numbers have different bytes.
      values[stride * i] = p.x + 0;
      values[stride * i + 1] = p.y + 0;
      if (stride === 3) values[stride * i + 2] = p.theta + 0;
    }
    let h1 = 0xdeadbeef ^ count;
    let h2 = 0x41c6ce57 ^ count;
    for (let i = 0; i < words.length; i++) {
      h1 = Math.imul(h1 ^ words[i], 2654435761);
      h2 = Math.imul(h2 ^ words[i], 1597334677);
      // Rotating keeps the two halves from staying a fixed function of each other.
      h1 = (h1 << 13) | (h1 >>> 19);
      h2 = (h2 << 17) | (h2 >>> 15);
    }
    const a = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    const b = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
    return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
  }

  /** Remember an arrangement; false when it was already remembered. */
  add(config: PackingConfig): boolean {
    const key = this.key(config);
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > this.limit) this.keys.delete(this.keys.values().next().value as string);
    return true;
  }
}
