/**
 * The default polygon queue, run the same way against any version of the client's main(): K runs
 * with --once --dry-run on one state directory, a seeded random source shared by the runs, and an
 * engine that searches nothing. test/draws.test.ts compares its picks with a snapshot taken from
 * the client before the spaces option, so that no later change alters the default draws unnoticed.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeProblem } from "./fake-server";

/** Twelve open problems without leaders, with distinct priorities (and two equal ones). */
export const DRAW_PROBLEMS: FakeProblem[] = [
  [3, 3, 5, 9],
  [4, 4, 7, 7],
  [0, 0, 11, 5],
  [5, 0, 6, 5],
  [6, 6, 8, 4.5],
  [0, 4, 9, 4],
  [3, 6, 10, 3.5],
  [7, 5, 4, 3],
  [8, 8, 3, 2.5],
  [4, 0, 12, 2],
  [5, 5, 13, 1.5],
  [0, 3, 6, 1],
].map(([N, M, P, priority]) => ({ N, M, P, priority, leader: null }));

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Main = (argv: readonly string[], deps: Record<string, unknown>) => Promise<number>;

export async function defaultDraws(
  main: Main,
  base: string,
  runs: number,
): Promise<{ picks: string[]; draws: number; keys: string[] }> {
  const random = mulberry32(42);
  let draws = 0;
  const counted = () => {
    draws++;
    return random();
  };
  const nothing = async (input: { memory?: unknown }) => ({
    best: null,
    jobs: 0,
    stopped: "time",
    memory: input.memory ?? null,
  });
  const state = mkdtempSync(join(tmpdir(), "pv-draws-"));
  const picks: string[] = [];
  try {
    for (let i = 0; i < runs; i++) {
      const lines: string[] = [];
      const code = await main(
        [
          "--base",
          base,
          "--state",
          state,
          "--cores",
          "1",
          "--minutes-per-problem",
          "0.05",
          "--no-battery-pause",
          "--once",
          "--dry-run",
        ],
        {
          out: (l: string) => lines.push(l),
          err: (l: string) => lines.push(l),
          signals: false,
          searchProblem: nothing,
          random: counted,
        },
      );
      const s = lines.find((l) => l.includes("] Searching "));
      picks.push(`${code} ${s ? s.replace(/^\[[^\]]*\] Searching /, "").replace(/ \(.*$/, "") : "none"}`);
    }
    const history = readFileSync(join(state, "history.jsonl"), "utf8").trim().split("\n");
    const keys = [...new Set(history.map((l) => Object.keys(JSON.parse(l)).join(",")))];
    return { picks, draws, keys };
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}
