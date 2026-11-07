/**
 * EngineMemory: what the engine carries from one problem to the next. Per family of problems (see
 * familyKey) it keeps:
 *
 *  - for each arm, the discounted number of problems it ran on and the discounted sum of its
 *    credit, its share of all the reward of that problem's jobs. A share, rather than the arm's
 *    reward per job, because late jobs rarely improve anything: the arms a search favours run
 *    most of the late jobs, and their reward per job would make them look worse than arms that
 *    only ran early;
 *  - for each method, its evaluation rate (evaluations per second times P), which sizes the first
 *    jobs' evaluation caps and the base budget on the family's next problem.
 *
 * The credit sets the arm's prior on the family's next problem (armPrior) and the order of its
 * exploration round.
 *
 * The host stores memory as JSON and hands it back unchanged, so parseMemory accepts anything:
 * malformed parts are dropped, and anything without the current version gives empty memory. The
 * size is bounded: at most MAX_FAMILIES families (least recently used dropped first), MAX_ARMS arms
 * and MAX_RATES rates each; [CALC] about 40 kB of JSON when full.
 */
import type { EngineMemory } from "../types";

export const MEMORY_VERSION = 1;
export const MAX_FAMILIES = 48;
export const MAX_ARMS = 32;
export const MAX_RATES = 16;
/** Problems an arm's record holds at most: older problems fade beyond this. */
const MAX_PROBLEMS = 20;
/** Weight of the family's earlier problems when one is added. */
const FAMILY_DECAY = 0.9;
/** Largest prior weight in pseudo-jobs, reached after four remembered problems. */
const MAX_PRIOR_WEIGHT = 4;

export interface ArmRecord {
  /** Discounted number of problems the arm ran on. */
  n: number;
  /** Discounted sum of its credit on them, at most n. */
  r: number;
}

export interface FamilyRecord {
  /** Value of Memory.used when the family was last updated. */
  used: number;
  arms: Record<string, ArmRecord>;
  /** Evaluations per second times P, by method. */
  rates: Record<string, number>;
}

export interface Memory {
  version: typeof MEMORY_VERSION;
  /** Problems searched with this memory. */
  used: number;
  families: Record<string, FamilyRecord>;
}

const FAMILY_KEY = /^(c|[3-8]|9\+)\/(c|[3-8]|9\+)\/(1|10|20|50|100|200|500)$/;
const ARM_KEY = /^(fresh|warm|iterate):[a-z][a-z_-]{0,31}$/;
const METHOD_KEY = /^[a-z][a-z_]{0,31}$/;

export function emptyMemory(): Memory {
  return { version: MEMORY_VERSION, used: 0, families: {} };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const round = (x: number) => Math.round(x * 1000) / 1000;

/** Own enumerable entries, at most `limit` of them. */
function entries(value: Record<string, unknown>, limit: number): [string, unknown][] {
  return Object.keys(value)
    .slice(0, limit)
    .map((key) => [key, value[key]]);
}

function parseFamily(value: unknown): FamilyRecord | undefined {
  if (!isRecord(value) || !isCount(value.used) || !isRecord(value.arms) || !isRecord(value.rates)) return undefined;
  const arms: [string, ArmRecord][] = [];
  for (const [key, arm] of entries(value.arms, 4 * MAX_ARMS)) {
    if (arms.length >= MAX_ARMS) break;
    if (!ARM_KEY.test(key) || !isRecord(arm) || !isCount(arm.n) || !isCount(arm.r)) continue;
    const n = Math.min(arm.n, MAX_PROBLEMS);
    arms.push([key, { n, r: Math.min(arm.n > 0 ? (arm.r * n) / arm.n : 0, n) }]);
  }
  const rates: [string, number][] = [];
  for (const [key, rate] of entries(value.rates, 4 * MAX_RATES)) {
    if (rates.length >= MAX_RATES) break;
    if (METHOD_KEY.test(key) && isCount(rate) && rate > 0) rates.push([key, rate]);
  }
  return { used: value.used, arms: Object.fromEntries(arms), rates: Object.fromEntries(rates) };
}

/** Memory from whatever the host stored: anything unusable gives empty memory or is dropped. */
export function parseMemory(value: EngineMemory): Memory {
  try {
    if (!isRecord(value) || value.version !== MEMORY_VERSION || !isCount(value.used) || !isRecord(value.families))
      return emptyMemory();
    const families: [string, FamilyRecord][] = [];
    for (const [key, family] of entries(value.families, 4 * MAX_FAMILIES)) {
      const parsed = FAMILY_KEY.test(key) ? parseFamily(family) : undefined;
      if (parsed) families.push([key, parsed]);
    }
    return { version: MEMORY_VERSION, used: value.used, families: Object.fromEntries(newest(families)) };
  } catch {
    // A hostile object (a throwing getter, a revoked proxy) is not memory either
    return emptyMemory();
  }
}

/** The MAX_FAMILIES most recently used families, ties in their given order. */
function newest(families: [string, FamilyRecord][]): [string, FamilyRecord][] {
  return families
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry[1].used - a.entry[1].used || a.index - b.index)
    .slice(0, MAX_FAMILIES)
    .map(({ entry }) => entry);
}

/** Mean credit of an arm on a family, or undefined without a record. */
export function armCredit(family: FamilyRecord | undefined, key: string): number | undefined {
  const arm = family && Object.hasOwn(family.arms, key) ? family.arms[key] : undefined;
  return arm && arm.n > 0 ? arm.r / arm.n : undefined;
}

/**
 * Beta prior of an arm on a problem of a family. Without a record, Beta(1, 1). With one, the
 * arm's mean credit relative to the family's best arm, p in [0, 1], gives
 * Beta(1 + w p / 2, 1 + w (1 - p / 2)): the family's best arm starts like an unknown one
 * (mean 1/2) and the others lower, down to Beta(1, 1 + w); w grows with the remembered problems
 * up to MAX_PRIOR_WEIGHT, so a problem's own jobs overturn its family within a few results.
 */
export function armPrior(family: FamilyRecord | undefined, key: string): { alpha: number; beta: number } {
  const credit = armCredit(family, key);
  if (credit === undefined || !family) return { alpha: 1, beta: 1 };
  let top = 0;
  for (const other of Object.keys(family.arms)) top = Math.max(top, armCredit(family, other) ?? 0);
  const p = top > 0 ? credit / top : 1;
  const weight = Math.min(MAX_PRIOR_WEIGHT, family.arms[key].n);
  return { alpha: 1 + (weight * p) / 2, beta: 1 + weight * (1 - p / 2) };
}

/** What one problem adds to its family. */
export interface ProblemRecord {
  /** Each arm that ran, with its share of the problem's reward (0 to 1; all 0 without any). */
  arms: { key: string; credit: number }[];
  /** Evaluations per second times P, by method, measured on this problem. */
  rates: { method: string; rate: number }[];
}

/** A new memory with the problem's record added to its family; `memory` is not changed. */
export function remember(memory: Memory, family: string, record: ProblemRecord): Memory {
  const used = memory.used + 1;
  const old = Object.hasOwn(memory.families, family) ? memory.families[family] : undefined;
  const arms = new Map<string, ArmRecord>(Object.entries(old?.arms ?? {}));
  for (const { key, credit } of record.arms) {
    if (!ARM_KEY.test(key) || !Number.isFinite(credit)) continue;
    const before = arms.get(key) ?? { n: 0, r: 0 };
    let n = FAMILY_DECAY * before.n + 1;
    let r = FAMILY_DECAY * before.r + Math.min(Math.max(credit, 0), 1);
    if (n > MAX_PROBLEMS) {
      r *= MAX_PROBLEMS / n;
      n = MAX_PROBLEMS;
    }
    arms.delete(key);
    arms.set(key, { n: round(n), r: Math.min(round(r), round(n)) });
  }
  const rates = new Map<string, number>(Object.entries(old?.rates ?? {}));
  for (const { method, rate } of record.rates) {
    if (!METHOD_KEY.test(method) || !(rate > 0) || !Number.isFinite(rate)) continue;
    // Geometric mean of the old and new rate: machines and their load vary, neither wins outright
    const before = rates.get(method);
    rates.delete(method);
    rates.set(method, round(before ? Math.sqrt(before * rate) : rate));
  }
  // Most recently updated entries last, so trimming keeps them
  const updated: FamilyRecord = {
    used,
    arms: Object.fromEntries([...arms].slice(-MAX_ARMS)),
    rates: Object.fromEntries([...rates].slice(-MAX_RATES)),
  };
  const families = Object.entries(memory.families).filter(([key]) => key !== family);
  families.push([family, updated]);
  return { version: MEMORY_VERSION, used, families: Object.fromEntries(newest(families)) };
}
