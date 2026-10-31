import { describe, expect, it } from "vitest";
import { RECORD_MARK, addRecordPair, markedLabel, recordShapes } from "../src/record-marks";

describe("the records page's shape marks", () => {
  it("mark a piece with any pair and the containers of that piece's pairs", () => {
    const shapes = recordShapes([
      { N: 4, M: 4, published: 3, site: true },
      { N: 4, M: 0, published: 0, site: true },
      { N: 84, M: 31, published: 0, site: true },
    ]);
    expect([...shapes.pieces].sort((a, b) => a - b)).toEqual([4, 84]);
    expect([...shapes.containers.get(4)!].sort((a, b) => a - b)).toEqual([0, 4]);
    expect(shapes.containers.get(31)).toBeUndefined();
    addRecordPair(shapes, 31, 5);
    expect(shapes.pieces.has(31) && shapes.containers.get(31)!.has(5)).toBe(true);
  });

  it("add the mark to a label, or leave it plain", () => {
    expect(markedLabel("4 (square)", true)).toBe(`4 (square) ${RECORD_MARK}`);
    expect(markedLabel("31", false)).toBe("31");
  });
});
