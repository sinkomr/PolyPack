import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PHONE_QUERY } from "../src/tighter/shop";

// The game's stylesheet is appended to block by block (shop, dealer, economy, runs). A merge that
// drops a closing brace leaves every later rule nested inside an unclosed one, which browsers ignore
// silently: the offers lost their layout that way once.
describe("Tighter stylesheet", () => {
  const css = readFileSync(new URL("../src/tighter/tighter.css", import.meta.url), "utf8");

  it("closes every block it opens, and each appended section starts at the top level", () => {
    let depth = 0;
    for (const [i, line] of css.split("\n").entries()) {
      const code = line.replace(/\/\*.*?\*\//g, "");
      if (/^\/\* ---- \w+ ---- \*\//.test(line)) expect(depth, `section at line ${i + 1}`).toBe(0);
      for (const ch of code) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
        expect(depth, `line ${i + 1}`).toBeGreaterThanOrEqual(0);
      }
    }
    expect(depth).toBe(0);
  });

  it("lays out phones under the same media query the tech tree uses to become a list", () => {
    expect(css).toContain(`@media ${PHONE_QUERY} {`);
  });

  it("styles the queue's working mark, and the page holds the sentence on what each kind of work does", () => {
    expect(css).toContain(".t-queue .t-q-live");
    const html = readFileSync(new URL("../tighter.html", import.meta.url), "utf8");
    expect(html).toContain('id="t-queue-work"');
  });

  // A banner or notice in the landscape column pushed the toolbar down by 49 px mid-burst, and a tap
  // at the old spot of Evolve landed on the dock's Tree tab (a lost click). They lie over the board.
  it("keeps the landscape banner and notice out of the layout, so Evolve never moves under a finger", () => {
    const start = css.indexOf("@media (max-height: 500px) and (orientation: landscape) and (max-width: 1023px) {");
    expect(start).toBeGreaterThan(0);
    const block = css.slice(start);
    const rule = /\.tighter \.t-banner,\s*\.tighter \.t-notice \{([^}]*)\}/.exec(block);
    expect(rule, "a shared banner and notice rule").not.toBeNull();
    expect(rule![1]).toContain("position: absolute");
    expect(rule![1]).toContain("pointer-events: none");
  });
});
