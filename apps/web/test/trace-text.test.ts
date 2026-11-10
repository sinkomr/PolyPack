import { describe, expect, it } from "vitest";
import { FIRST_RESULT, MAX_DECIMALS, MIN_DECIMALS, decimalsFor, relativeText, traceText } from "../src/trace-text";

describe("progress graph text", () => {
  it("keeps six decimals while they show the difference", () => {
    expect(decimalsFor(4.837434, 4.813493)).toBe(MIN_DECIMALS);
    expect(decimalsFor(2.5)).toBe(MIN_DECIMALS);
    expect(decimalsFor(2.5, 2.5)).toBe(MIN_DECIMALS);
  });

  it("adds decimals for a change too small for six, up to a limit", () => {
    // a difference of 3.2e-8 needs nine decimals to show two significant digits
    expect(decimalsFor(122.15767664, 122.157676608)).toBe(9);
    expect(decimalsFor(1, 1 + 1e-15)).toBe(MAX_DECIMALS);
    // the smallest nonzero difference among all the scores decides
    expect(decimalsFor(3, 2, 2 + 5e-9)).toBe(10);
  });

  it("writes a change as %, ‰ or ppm, whichever reads best", () => {
    expect(relativeText(0.1127)).toBe("11.3%");
    expect(relativeText(0.01127)).toBe("1.13%");
    expect(relativeText(-0.00495)).toBe("4.95‰");
    expect(relativeText(0.000123)).toBe("123 ppm");
    expect(relativeText(4.2e-6)).toBe("4.2 ppm");
    expect(relativeText(2.6e-10)).toBe("0.00026 ppm");
    expect(relativeText(1e-13)).toBe("under 0.000001 ppm");
  });

  it("compares the run's best with the reference", () => {
    const trace: [number, number][] = [
      [0.4, 4.84],
      [3, 4.82],
      [12.34, 4.813493],
    ];
    const t = traceText(trace, 4.837434, "the board");
    expect(t.scores).toBe("4.840000 → 4.813493 · 12.3 s");
    expect(t.change).toBe("4.95‰ better than the board (4.837434)");
    expect(t.aria).toBe(
      "Best result from 4.840000 to 4.813493 over 12.3 seconds. 4.95‰ better than the board (4.837434).",
    );
  });

  it("says when the run is behind or level with the reference", () => {
    expect(traceText([[1, 5]], 4.8, "the board").change).toBe("4.17% worse than the board (4.800000)");
    expect(traceText([[1, 4.8]], 4.8, "the board").change).toBe("Same as the board (4.800000)");
  });

  it("shows enough decimals for a tiny gain on the reference", () => {
    const t = traceText([[5, 122.157676608]], 122.15767664, "the shown packing");
    expect(t.scores).toBe("122.157676608 → 122.157676608 · 5.0 s");
    expect(t.change).toBe("0.000262 ppm better than the shown packing (122.157676640)");
  });

  it("compares with the run's own first result without a reference", () => {
    const trace: [number, number][] = [
      [0.2, 3.545393],
      [1, 3.1],
      [7.9, 3.022125],
    ];
    const t = traceText(trace, null, "the board");
    expect(t.scores).toBe("3.545393 → 3.022125 · 7.9 s");
    expect(t.change).toBe(`14.8% better than ${FIRST_RESULT} (3.545393)`);
    // an unusable reference is treated as none
    expect(traceText(trace, Number.NaN, "the board").change).toBe(t.change);
  });

  it("has no comparison with a single point and no reference", () => {
    const t = traceText([[2, 3.5]], null, "the board");
    expect(t.change).toBeNull();
    expect(t.aria).toBe("Best result from 3.500000 to 3.500000 over 2.0 seconds");
  });
});
