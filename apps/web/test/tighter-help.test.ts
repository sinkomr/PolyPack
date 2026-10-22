import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HELP, METHOD_MATCH, MIN_STEP, PIPELINE, TRANSFERS, andList, superscript } from "../src/tighter/help";
import type { How } from "../src/tighter/how";
import { plain } from "../src/tighter/how";
import { MARKS, RULES } from "../src/tighter/standing";

const all: [string, How[]][] = [
  ...Object.entries(HELP).map(([id, h]): [string, How[]] => [id, Array.isArray(h) ? h : [h]]),
  ["pipeline", [PIPELINE]],
  ["match", [METHOD_MATCH]],
  ["transfers", [TRANSFERS]],
];

/** The symbols of markup: each <var> with the <sub> right after it, as "s_prev". */
const symbols = (markup: string) =>
  [...markup.matchAll(/<var>(.*?)<\/var>(?:<sub>(.*?)<\/sub>)?/g)].map(([, v, sub]) => (sub ? `${v}_${sub}` : v));

const prose = (h: How) => [
  ...(typeof h.text === "string" ? [h.text] : h.text),
  ...(h.vars ?? []).map(([, meaning]) => meaning),
  ...(h.note ? [h.note] : []),
];

describe("Tighter's explanations", () => {
  it("define every symbol their formulas use", () => {
    for (const [id, hows] of all) {
      const defined = new Set(hows.flatMap((h) => (h.vars ?? []).flatMap(([sym]) => symbols(sym))));
      for (const h of hows)
        for (const line of h.math ?? [])
          for (const s of symbols(line)) expect(defined.has(s), `${id}: ${s} in ${plain(line)}`).toBe(true);
    }
  });

  it("write plain sentences: no em dashes, no semicolons, no floor or decades", () => {
    const texts = [
      ...all.flatMap(([, hows]) => hows.flatMap(prose)),
      ...RULES.flatMap((r) => [r.limit, r.reward]),
      ...MARKS.map((m) => m.label),
    ];
    for (const t of texts) {
      expect(t, t).not.toMatch(/—|;/);
      expect(t, t).not.toMatch(/\bfloor\b|decade/i);
    }
    // the rules read as sentences, and their rewards read after "Once finished, "
    for (const r of RULES) {
      expect(r.limit).toMatch(/^[A-Z].*\.$/);
      expect(r.reward).toMatch(/^[A-Z].*\.$/);
    }
  });

  it("are all placed on the page, and the page names none that is missing", () => {
    const html = readFileSync(new URL("../tighter.html", import.meta.url), "utf8");
    const placed = [...html.matchAll(/data-how="([^"]+)"/g)].map((m) => m[1]);
    expect([...placed].sort()).toEqual(Object.keys(HELP).sort());
  });

  it("work the points example out: the step term is 1, 4, 7 and 8 for steps of 10⁻⁹ to 10⁻²", () => {
    const example = (HELP.points as How[])[1];
    const steps = (example.math ?? []).map((line) => /t<\/var><sub>step<\/sub> = (\d+)/.exec(line)?.[1]);
    expect(steps).toEqual(["1", "4", "7", "8"]);
  });

  it("give auto-eval's rate as a target in evaluations a second, which evaluations per click do not change", () => {
    const auto = HELP.auto as How;
    const text = [...prose(auto), ...(auto.math ?? []).map(plain)].join(" ");
    expect(text).toContain("Its rate is in evaluations a second");
    expect(text).toContain("do not speed auto-eval up");
    expect(text).toContain("The rate is a target.");
    expect(text).toContain("r = min(250, a × 1.3x)");
    expect(text).toContain("e = r × L");
    expect(text).not.toMatch(/clicks Evolve for you|its clicks|speeds it up too|clicks a second/);
  });

  it("format the numbers they share", () => {
    expect(MIN_STEP).toBe("10⁻⁹");
    expect(superscript(-12)).toBe("⁻¹²");
    expect(andList(["a"])).toBe("a");
    expect(andList(["a", "b", "c"])).toBe("a, b and c");
  });
});
