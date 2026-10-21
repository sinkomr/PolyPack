import { describe, expect, it } from "vitest";
import { Unreadable, readSquares } from "../read-ellsworth-svg/lib";

/** A drawing in the style of Ellsworth's files: entities in a DTD, a white container, <use> of #one. */
const drawing = (entities: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
    <!ENTITY s "4">
${entities}
]>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 &s; &s;" style="fill:#B2B2B2">
    <defs>
        <rect width="&s;" height="&s;" id="outer"/>
        <rect width="1" height="1" id="one"/>
    </defs>
    <use xlink:href="#outer" style="fill:white; stroke:none"/>
${body}
    <use xlink:href="#outer" style="fill:none"/>
</svg>`;

const centres = (source: string) =>
  readSquares(source)
    .squares.map((p) => [p.x, p.y])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

describe("readSquares", () => {
  it("expands an entity used inside another, as drawings 293 and 300 do", () => {
    const source = drawing(
      `    <!ENTITY u2 ".25">\n    <!ENTITY tr "translate(-&u2; 1)">`,
      `    <use xlink:href="#one"/>\n    <use xlink:href="#one" transform="translate(2 0) &tr;&tr;"/>`,
    );
    // the second square moves by (-0.25, 1) twice; read once, "&u2;" became the 2 of its name
    const got = centres(source);
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual([0.5, 0.5]);
    expect(got[1][0]).toBeCloseTo(2.5 - 0.5, 12);
    expect(got[1][1]).toBeCloseTo(0.5 + 2, 12);
  });

  it("refuses text that is not a number rather than reading digits out of it", () => {
    for (const transform of ["translate(-u2 1)", "translate(1 -&amp;)", "rotate(30deg)", "translate()"]) {
      const source = drawing("", `    <use xlink:href="#one" transform="${transform}"/>`);
      expect(() => readSquares(source), transform).toThrow(Unreadable);
    }
    expect(() => readSquares(drawing("", `    <rect x="1px" width="1" height="1"/>`))).toThrow(Unreadable);
  });

  it("refuses entities that refer to themselves or are not defined", () => {
    expect(() => readSquares(drawing(`    <!ENTITY a "&b;">\n    <!ENTITY b "&a;">`, ""))).toThrow(Unreadable);
    expect(() => readSquares(drawing("", `    <use xlink:href="#one" transform="translate(&u9; 0)"/>`))).toThrow(
      Unreadable,
    );
  });

  it("takes a repeated id to mean its first element, as browsers do (drawings 107 and 267)", () => {
    const source = drawing(
      "",
      `    <defs><g id="two"><rect width="2" height="1" id="one"/></g></defs>
    <use xlink:href="#one"/>
    <use xlink:href="#two" transform="translate(0 2)"/>`,
    );
    expect(centres(source)).toEqual([
      [0.5, 0.5],
      [0.5, 2.5],
      [1.5, 2.5],
    ]);
  });
});
