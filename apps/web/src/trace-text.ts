/**
 * The text under the optimizer's progress graph, on the Flat board and in the other Dimensions.
 *
 * The graph is scaled to the run's own best scores, so on its own it doesn't say how much the run
 * improved on the packing it started from. Each label gives that change as a percentage, per mille
 * or parts per million, whichever reads best, and shows the scores with enough decimals for small
 * changes to be seen.
 */

/** Six decimals as before; more only when two scores would otherwise look the same. */
export const MIN_DECIMALS = 6;
/** Beyond about twelve decimals a score of order 100 has no more meaningful digits in a double. */
export const MAX_DECIMALS = 12;

/**
 * Decimals that show the smallest nonzero difference between the given scores with at least two
 * significant digits, from MIN_DECIMALS to MAX_DECIMALS.
 */
export function decimalsFor(...scores: number[]): number {
  let smallest = Infinity;
  for (let i = 0; i < scores.length; i++)
    for (let j = i + 1; j < scores.length; j++) {
      const d = Math.abs(scores[i] - scores[j]);
      if (d > 0 && d < smallest) smallest = d;
    }
  if (!Number.isFinite(smallest)) return MIN_DECIMALS;
  return Math.min(MAX_DECIMALS, Math.max(MIN_DECIMALS, Math.ceil(-Math.log10(smallest)) + 1));
}

/**
 * A relative change, unsigned: a percentage from 1%, per mille from 0.1%, parts per million below
 * that. Two decimals for % and ‰, three significant digits for ppm.
 */
export function relativeText(fraction: number): string {
  const a = Math.abs(fraction);
  if (a >= 0.1) return `${(100 * a).toFixed(1)}%`;
  if (a >= 0.01) return `${(100 * a).toFixed(2)}%`;
  if (a >= 0.001) return `${(1000 * a).toFixed(2)}‰`;
  const ppm = 1e6 * a;
  if (ppm >= 100) return `${ppm.toFixed(0)} ppm`;
  // below 1e-6 ppm, a relative change of 1e-12, the scores no longer show the difference
  if (ppm >= 1e-6) return `${Number(ppm.toPrecision(3))} ppm`;
  return "under 0.000001 ppm";
}

export interface TraceText {
  /** The run's first and best scores and its length: "4.837434 → 4.813493 · 12.3 s". */
  scores: string;
  /** How the best compares with the reference, or null without one. */
  change: string | null;
  /** The whole label, for screen readers. */
  aria: string;
}

/** What the run is compared with when there is no packing to compare with, such as an incomplete board. */
export const FIRST_RESULT = "the run's first result";

/**
 * The label for a trace of [seconds, best score] points, smallest score best. `reference` is the
 * score of the packing the run is compared with (the board when it started, on the Flat board),
 * and `name` says what it is, as in "the board". Without one, a run with more than one point is
 * compared with its own first result.
 */
export function traceText(trace: [number, number][], reference: number | null, name: string): TraceText {
  const end = trace.length ? trace[trace.length - 1][0] : 0;
  const scores = trace.map((p) => p[1]);
  const high = Math.max(...scores),
    low = Math.min(...scores);
  const given = reference !== null && Number.isFinite(reference) && reference > 0 ? reference : null;
  const ref = given ?? (trace.length > 1 ? trace[0][1] : null);
  const refName = given !== null ? name : FIRST_RESULT;
  const decimals = ref !== null ? decimalsFor(high, low, ref) : decimalsFor(high, low);
  const f = (x: number) => x.toFixed(decimals);
  const text = `${f(high)} → ${f(low)} · ${end.toFixed(1)} s`;
  let change: string | null = null;
  if (ref !== null) {
    const fraction = (ref - low) / ref;
    change =
      fraction === 0
        ? `Same as ${refName} (${f(ref)})`
        : `${relativeText(fraction)} ${fraction > 0 ? "better" : "worse"} than ${refName} (${f(ref)})`;
  }
  return {
    scores: text,
    change,
    aria: `Best result from ${f(high)} to ${f(low)} over ${end.toFixed(1)} seconds${change ? `. ${change}.` : ""}`,
  };
}

/** Draws the trace into the progress graph's svg, with the label below it. */
export function drawTraceSvg(
  svg: SVGSVGElement,
  trace: [number, number][],
  reference: number | null,
  name: string,
): void {
  svg.replaceChildren();
  svg.toggleAttribute("hidden", !trace.length);
  if (!trace.length) return;
  const NS = "http://www.w3.org/2000/svg";
  const end = Math.max(0.01, trace[trace.length - 1][0]);
  const low = Math.min(...trace.map((p) => p[1]));
  const high = Math.max(...trace.map((p) => p[1]));
  const range = high - low || Math.max(1e-6, high * 1e-6);
  const label = traceText(trace, reference, name);
  // a second line of text when there is a reference to compare with
  svg.setAttribute("viewBox", `0 0 300 ${label.change ? 112 : 100}`);
  const line = document.createElementNS(NS, "polyline");
  line.setAttribute(
    "points",
    trace
      .map(([t, s]) => `${(10 + (280 * t) / end).toFixed(2)},${(10 + (65 * (high - s)) / range).toFixed(2)}`)
      .join(" "),
  );
  svg.append(line);
  const lines = label.change ? [label.scores, label.change] : [label.scores];
  lines.forEach((content, i) => {
    const text = document.createElementNS(NS, "text");
    text.setAttribute("x", "10");
    text.setAttribute("y", String(92 + 13 * i));
    text.textContent = content;
    svg.append(text);
  });
  svg.setAttribute("aria-label", label.aria);
}
