/**
 * The open problems Tighter deals: the curated frontier of design.md §6. Swap this module to change
 * the list; nothing else in the game names a problem.
 *
 * N, M ∈ FRONTIER_SIDES (neighbours differ by at most 14 %) and P ∈ FRONTIER_P: 17 · 17 · 9 = 2,601
 * problems. All have N or M above 20, so the site's nightly free-improvements job (N, M <= 20) never
 * touches them, and none has a published value.
 */
export const FRONTIER_SIDES = [21, 24, 27, 30, 33, 36, 40, 44, 47, 50, 55, 60, 66, 72, 80, 90, 100] as const;
export const FRONTIER_P = [40, 60, 80, 100, 120, 150, 200, 250, 300] as const;

export interface ProblemKey {
  N: number;
  M: number;
  P: number;
}

export const keyOf = (p: ProblemKey): string => `${p.N}/${p.M}/${p.P}`;

export function parseKey(key: string): ProblemKey | null {
  const m = /^(\d+)\/(\d+)\/(\d+)$/.exec(key);
  return m ? { N: Number(m[1]), M: Number(m[2]), P: Number(m[3]) } : null;
}

function product(sides: readonly number[], ps: readonly number[]): ProblemKey[] {
  const out: ProblemKey[] = [];
  for (const N of sides) for (const M of sides) for (const P of ps) out.push({ N, M, P });
  return out;
}

/** All 2,601 frontier problems, in a fixed order (N, then M, then P). */
export const FRONTIER: readonly ProblemKey[] = product(FRONTIER_SIDES, FRONTIER_P);

/**
 * The first problem of a new game comes from a smaller corner of the frontier [SPEC]: few sides and
 * few pieces, so that Compact takes about a second and the shape weight w = (20/N)(20/M) is at least
 * 0.31, which makes the first record pay for the first upgrade (5 RP). 6 · 6 · 3 = 108 problems.
 */
export const STARTER: readonly ProblemKey[] = product([21, 24, 27, 30, 33, 36], [40, 60, 80]);

/** Shape names as the site writes them: "60-gons in a 47-gon". */
export function shapeName(n: number, plural: boolean): string {
  if (n === 0) return plural ? "circles" : "circle";
  const names: Record<number, string> = {
    3: "triangle",
    4: "square",
    5: "pentagon",
    6: "hexagon",
    7: "heptagon",
    8: "octagon",
    9: "nonagon",
    10: "decagon",
    12: "dodecagon",
  };
  const base = names[n] ?? `${n}-gon`;
  return plural ? `${base}s` : base;
}

export function problemTitle(p: ProblemKey): string {
  const container = shapeName(p.M, false);
  const article = /^[aeiou8]|^1[18]-/.test(container) ? "an" : "a";
  return `${shapeName(p.N, true)} in ${article} ${container}, ${p.P} pieces`;
}
