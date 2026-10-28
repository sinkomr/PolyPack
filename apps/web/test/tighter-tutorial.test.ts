import { describe, expect, it } from "vitest";
import { evaluate, findOverlaps } from "@polypack/geometry";
import { strictTolerance } from "@polypack/solver";
import { newGame } from "../src/tighter/game";
import { OpenRun } from "../src/tighter/open-run";
import { fromJson, toJson } from "../src/tighter/save";
import { HANDS_ON, handsOnRequest, looseStart, nineSquares, sideOf, SHOWN, STEPS, TEASER } from "../src/tighter/tutorial";

// The tutorial's boards are fixed: nine squares in 3 by 3, and 12 hexagons in a pentagon that each
// click shrinks. These check properties, never the exact values a seeded search finds.

describe("Tighter tutorial", () => {
  it("shows nine squares in a square of side 3", () => {
    const c = nineSquares();
    expect(findOverlaps(c.N, c.pieces, strictTolerance(c))).toEqual([]);
    expect(sideOf(c)).toBeCloseTo(3, 9);
  });

  it("shows squares for 9, 10, 11 and 17, and a teaser of two drawings", () => {
    expect(SHOWN.counts).toEqual([9, 10, 11, 17]);
    expect(TEASER).toHaveLength(2);
    expect(TEASER.map((t) => t.caption)).toEqual(["12 circles on a sphere", "6 octahedra in a cube"]);
  });

  it("tells the player that records update the public tables and pay points over time", () => {
    const game = STEPS.find((s) => s.title === "Now the game")!;
    expect(game.text).toContain(
      "Whenever your packing beats the best one known, PolyPack's public record tables are updated, and you earn points both right away and over time, for as long as your record holds the top spot.",
    );
    expect(game.text).toContain("In the game you'll do this on many different problems.");
    expect(game.text).toContain("Points buy upgrades that make your solver faster and smarter.");
    expect(game.text).not.toContain("under your name");
    expect(STEPS[STEPS.length - 1].teaser).toBe(true);
  });

  it("starts the hexagons loose and valid", () => {
    const c = looseStart();
    expect(c.pieces).toHaveLength(HANDS_ON.P);
    expect(findOverlaps(c.N, c.pieces, strictTolerance(c))).toEqual([]);
    expect(evaluate(c, { autoOrient: true }).valid).toBe(true);
  });

  it("shrinks the side with every one of the clicks", async () => {
    const run = new OpenRun(handsOnRequest());
    let s = await run.step(0);
    let side = s.score!;
    const start = side;
    for (let click = 0; click < HANDS_ON.clicks; click++) {
      s = await run.step(HANDS_ON.evals);
      expect(s.ended).toBe(false);
      // each click is a visible improvement: well above rounding, and a valid packing
      expect(s.score!).toBeLessThan(side - 1e-4);
      side = s.score!;
    }
    expect(side).toBeLessThan(start);
    expect(findOverlaps(s.best!.N, s.best!.pieces, strictTolerance(s.best!))).toEqual([]);
    await run.close();
  });

  it("counts a save from before the tutorial as done, and keeps a new game's flag", () => {
    expect(newGame(0, 1).tutorialDone).toBe(false);
    const old = JSON.parse(toJson(newGame(0, 1)));
    delete old.tutorialDone;
    const r = fromJson(JSON.stringify(old), 0);
    expect(r.ok && r.state.tutorialDone).toBe(true);
    const fresh = fromJson(toJson(newGame(0, 1)), 0);
    expect(fresh.ok && fresh.state.tutorialDone).toBe(false);
  });
});
