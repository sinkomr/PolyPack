import { describe, expect, it } from "vitest";
import { boardFromOldUnits, readStoredBoard, taggedBoard } from "../src/board-units";
import { decodeShare, encodeShare } from "../src/share";

const disks = {
  N: 0,
  M: 0,
  P: 2,
  container_phi: 0,
  pieces: [
    { x: -1, y: 0, theta: 0 },
    { x: 1, y: 2, theta: 0 },
  ],
};
const squares = { N: 4, M: 0, P: 1, container_phi: 0.5, pieces: [{ x: 0.25, y: 0.5, theta: 0.1 }] };
const link = (o: object) => "#c=" + Buffer.from(JSON.stringify(o)).toString("base64url");

describe("boards saved or shared before the unit change", () => {
  it("halves the centres of an untagged saved board of disks, once", () => {
    const r = readStoredBoard(JSON.parse(JSON.stringify(disks)));
    expect(r.ok && r.config.pieces).toEqual([
      { x: -0.5, y: 0, theta: 0 },
      { x: 0.5, y: 1, theta: 0 },
    ]);
    // a tagged save is read as it is, so a second load does not convert again
    const again = readStoredBoard(JSON.parse(JSON.stringify(taggedBoard(r.ok ? r.config : disks))));
    expect(again.ok && again.config.pieces[1]).toEqual({ x: 0.5, y: 1, theta: 0 });
  });

  it("leaves polygon pieces alone, in a circle or not", () => {
    const r = readStoredBoard(JSON.parse(JSON.stringify(squares)));
    expect(r.ok && r.config).toEqual(squares);
    expect(boardFromOldUnits(squares)).toBe(squares);
  });

  it("converts an old share link and keeps a new one", () => {
    const old = decodeShare(link({ N: 0, M: 5, P: 1, phi: 0, p: [2, 4, 0.3] }));
    expect(old?.pieces).toEqual([{ x: 1, y: 2, theta: 0.3 }]);
    const sq = decodeShare(link({ N: 4, M: 0, P: 1, phi: 0, p: [2, 4, 0.3] }));
    expect(sq?.pieces).toEqual([{ x: 2, y: 4, theta: 0.3 }]);
    expect(decodeShare("#" + encodeShare(disks))?.pieces).toEqual(disks.pieces);
  });
});
