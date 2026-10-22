/** Formatting for the client's output: durations, timestamps, scores and problem labels. */
import type { Problem } from "./types";

/** "1h02m", "4m05s", "12s". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "?";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

/** Local time as "2026-10-21 21:43:06". */
export function timestamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
  );
}

export const problemKey = (p: Problem) => `${p.N}-${p.M}-${p.P}`;
export const problemLabel = (p: Problem) => `N=${p.N} M=${p.M} P=${p.P}`;

/** Scores are shown with six decimals; storage keeps full precision. */
export const formatScore = (score: number) => score.toFixed(6);

/**
 * How far `score` is from `reference`, in percent: negative when it is smaller (better). Tiny
 * differences, which matter near a record, are shown in exponent form rather than as 0.000%.
 */
export function relativePercent(score: number, reference: number): string {
  const pct = (score / reference - 1) * 100;
  if (pct === 0) return "0%";
  const text = Math.abs(pct) >= 0.001 ? pct.toFixed(3) : pct.toExponential(2);
  return `${pct > 0 ? "+" : ""}${text}%`;
}
