/**
 * Thompson sampling over arms with Gaussian rewards: the learning dealer's buckets of problems, and
 * method match's (problem kind, method) pairs. Each arm keeps a running mean and variance of its
 * rewards (Welford); a choice draws one plausible mean per arm from its posterior and takes the
 * highest, so arms with few observations are still tried. The draws come from a generator the caller
 * passes, so a seeded game chooses the same way.
 */

export interface Arm {
  /** Observations. */
  n: number;
  mean: number;
  /** Sum of squared differences from the mean (Welford). */
  m2: number;
}

export type Bandit = Record<string, Arm>;

/** What an arm is believed to pay before it has been tried. */
export interface Prior {
  mean: number;
  sd: number;
}

/** Most arms kept; the least observed are forgotten first. */
export const MAX_ARMS = 600;

/** Adds one observed reward to an arm. */
export function observe(b: Bandit, key: string, reward: number): void {
  if (!Number.isFinite(reward)) return;
  const a = b[key] ?? (b[key] = { n: 0, mean: 0, m2: 0 });
  a.n++;
  const d = reward - a.mean;
  a.mean += d / a.n;
  a.m2 += d * (reward - a.mean);
  const keys = Object.keys(b);
  if (keys.length > MAX_ARMS) {
    keys.sort((x, y) => b[x].n - b[y].n);
    for (const k of keys.slice(0, keys.length - MAX_ARMS)) if (k !== key) delete b[k];
  }
}

/** The arm's posterior: a normal prior updated with its observations (their variance, or the prior's). */
export function posterior(b: Bandit, key: string, prior: Prior): { mean: number; sd: number } {
  const a = b[key];
  const p0 = 1 / Math.max(1e-12, prior.sd * prior.sd);
  if (!a || a.n === 0) return { mean: prior.mean, sd: prior.sd };
  const variance = a.n >= 2 ? Math.max(a.m2 / (a.n - 1), 1e-12) : prior.sd * prior.sd;
  const pn = a.n / variance;
  const precision = p0 + pn;
  return { mean: (prior.mean * p0 + a.mean * pn) / precision, sd: Math.sqrt(1 / precision) };
}

/** A standard normal draw (Box-Muller) from a uniform generator. */
export function gaussian(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** One plausible mean for the arm. */
export function sampleArm(b: Bandit, key: string, prior: Prior, rand: () => number): number {
  const p = posterior(b, key, prior);
  return p.mean + p.sd * gaussian(rand);
}

/** The arm with the highest draw, or null for no arms. */
export function choose(
  b: Bandit,
  keys: readonly string[],
  priorOf: (key: string) => Prior,
  rand: () => number,
): string | null {
  let best: string | null = null;
  let top = -Infinity;
  for (const k of keys) {
    const x = sampleArm(b, k, priorOf(k), rand);
    if (x > top) {
      top = x;
      best = k;
    }
  }
  return best;
}

/** A bandit read from a save: well-formed arms only, at most MAX_ARMS of them. */
export function normalizeBandit(v: unknown): Bandit {
  const out: Bandit = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  let count = 0;
  for (const [k, a] of Object.entries(v as Record<string, unknown>)) {
    if (count >= MAX_ARMS || k.length > 120 || typeof a !== "object" || a === null) continue;
    const { n, mean, m2 } = a as Record<string, unknown>;
    if (!Number.isSafeInteger(n) || (n as number) < 0) continue;
    if (typeof mean !== "number" || !Number.isFinite(mean) || typeof m2 !== "number" || !Number.isFinite(m2) || m2 < 0)
      continue;
    out[k] = { n: n as number, mean, m2 };
    count++;
  }
  return out;
}
