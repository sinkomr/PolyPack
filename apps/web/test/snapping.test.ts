import { describe, expect, it } from "vitest";
import { MOVE_TOL, Pose, findOverlaps, pieceSeparation } from "@polypack/geometry";
import { Board } from "../src/board";
import { magneticCandidates } from "../src/snapping";

const square = (x: number, y: number, angle = 0): Pose => ({ x, y, theta: Math.PI / 4 + angle });
function boardWith(N: number, pieces: Pose[], ids = [1]): Board {
  const board = new Board();
  expect(board.load({ N, M: 4, P: pieces.length, pieces, container_phi: 0 }, false)).toBeNull();
  board.select(ids);
  return board;
}

describe("mouse magnetic snapping", () => {
  it("snaps corners and keeps the complete drag in one undo step", () => {
    const board = boardWith(4, [square(0, 0), square(1.4, 1.4)]);
    const before = board.toConfig();
    board.begin();
    board.translateSelection(-0.32, -0.34);
    expect(board.magnetSelection(0.2, "corners")?.kind).toBe("corner");
    expect(board.state.pieces[1].x).toBeCloseTo(1, 10);
    expect(board.state.pieces[1].y).toBeCloseTo(1, 10);
    board.commit();
    const after = board.toConfig();
    board.undo();
    expect(board.toConfig()).toEqual(before);
    expect(board.canUndo).toBe(false);
    board.redo();
    expect(board.toConfig()).toEqual(after);
  });

  it("aligns a nearby face, including a small angular correction", () => {
    const board = boardWith(4, [square(0, 0), square(1.08, 0, Math.PI / 60)]);
    board.begin();
    expect(board.magnetSelection(0.2, "edges")?.kind).toBe("edge");
    const p = board.state.pieces[1];
    expect(p.x).toBeCloseTo(1, 10);
    expect(p.y).toBeCloseTo(0, 10);
    expect(p.theta).toBeCloseTo(Math.PI / 4, 10);
    expect(findOverlaps(4, board.state.pieces, MOVE_TOL)).toEqual([]);
  });

  it("prefers face alignment over a bare corner snap in the default mode", () => {
    const board = boardWith(4, [square(0, 0), square(1.08, 0.03, 0.005)]);
    expect(board.magnetSelection(0.2, "both")?.kind).toBe("edge");
    const p = board.state.pieces[1];
    expect(p.x).toBeCloseTo(1, 10);
    expect(p.y).toBeCloseTo(0, 10);
    expect(p.theta).toBeCloseTo(Math.PI / 4, 10);
    expect(findOverlaps(4, board.state.pieces, MOVE_TOL)).toEqual([]);
    // Away from any capturable face, corners still snap.
    const corner = boardWith(4, [square(0, 0), square(1.08, 1.06)]);
    expect(corner.magnetSelection(0.2, "both")?.kind).toBe("corner");
  });

  it("snaps a corner to the interior of a finite edge without changing its angle", () => {
    const board = boardWith(4, [square(0, 0), square(1.08, 0.32)]);
    expect(board.magnetSelection(0.2, "edges")?.kind).toBe("corner-edge");
    expect(board.state.pieces[1].x).toBeCloseTo(1, 10);
    expect(board.state.pieces[1].y).toBeCloseTo(0.32, 10);
    expect(Math.abs(pieceSeparation(4, board.state.pieces[0], board.state.pieces[1]).sep)).toBeLessThan(1e-9);
    const far = magneticCandidates(4, [square(0, 0), square(1.08, 1.3)], [1], 0.2, "edges");
    expect(far).toEqual([]);
  });

  it("preserves group rigidity and avoids selected-to-selected targets", () => {
    const board = boardWith(4, [square(0, 0), square(1.08, 0.08), square(2.08, 0.08)], [1, 2]);
    const [a, b] = board.state.pieces.slice(1);
    expect(board.magnetSelection(0.2, "both")).not.toBeNull();
    const [c, d] = board.state.pieces.slice(1);
    expect(d.x - c.x).toBeCloseTo(b.x - a.x, 12);
    expect(d.y - c.y).toBeCloseTo(b.y - a.y, 12);
    expect(c.theta).toBe(a.theta);
    expect(d.theta).toBe(b.theta);
    expect(findOverlaps(4, board.state.pieces, MOVE_TOL)).toEqual([]);
    board.select([0, 1, 2]);
    expect(board.magnetSelection(0.2, "both")).toBeNull();
  });

  it("never applies a corner snap that overlaps interiors", () => {
    // Coincident adjacent corners can put both polygons on the same side of a contact.
    const board = boardWith(3, [
      { x: 0, y: 0, theta: 0 },
      { x: 1.04, y: 0, theta: 0 },
    ]);
    board.magnetSelection(0.2, "corners");
    expect(findOverlaps(3, board.state.pieces, MOVE_TOL)).toEqual([]);
  });

  it("rejects face alignment blocked by a third piece, preserving the ordinary drag", () => {
    const board = boardWith(4, [square(0, 0), square(1.08, 0.08, Math.PI / 60), square(1.08, -0.96)]);
    expect(
      magneticCandidates(4, board.state.pieces, [1], 0.2, "edges").some(
        (c) => c.kind === "edge" && Math.abs(c.angle) > 0.01,
      ),
    ).toBe(true);
    board.magnetSelection(0.2, "edges");
    expect(findOverlaps(4, board.state.pieces, MOVE_TOL)).toEqual([]);
    expect(Math.hypot(board.state.pieces[1].x - 1, board.state.pieces[1].y)).toBeGreaterThan(0.01);
  });

  it("leaves circles, disabled snapping and distant targets unchanged", () => {
    for (const N of [0, 4]) {
      const ps = [
        { x: 0, y: 0, theta: 0 },
        { x: 4, y: 0, theta: 0 },
      ];
      const board = boardWith(N, ps);
      const before = board.toConfig();
      expect(board.magnetSelection(0.2, "off")).toBeNull();
      expect(board.magnetSelection(0.2, "both")).toBeNull();
      expect(board.toConfig()).toEqual(before);
    }
  });

  it("handles odd polygons and angles across the wrap without exceeding the capture radius", () => {
    for (const N of [3, 5, 7, 12, 100]) {
      const a = { x: 0, y: 0, theta: Math.PI - 0.01 };
      const r = 1 / (2 * Math.tan(Math.PI / N));
      const normal = a.theta + Math.PI / 2 + Math.PI / N;
      const b = {
        x: (2 * r + 0.08) * Math.cos(normal),
        y: (2 * r + 0.08) * Math.sin(normal),
        theta: a.theta + Math.PI + 0.002,
      };
      const board = boardWith(N, [a, b]);
      const snap = board.magnetSelection(0.2, "edges");
      expect(snap).not.toBeNull();
      expect(Math.hypot(snap!.dx, snap!.dy)).toBeLessThanOrEqual(0.2);
      expect(findOverlaps(N, board.state.pieces, MOVE_TOL)).toEqual([]);
    }
  });
});
