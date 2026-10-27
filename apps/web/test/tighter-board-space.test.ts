import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mountSpaceBoard, spaceScoreBox, spaceScoreWord } from "../src/tighter/board-space";
import { dealSpaceProblem, openDimension } from "../src/tighter/cheats";
import { newGame } from "../src/tighter/game";

// The board of a space problem: its score box, how it is mounted, and that the page does not carry it.

describe("Tighter space board", () => {
  it("words the score box of a sphere and a polyhedra problem, and leaves density out", () => {
    const sphere = { family: "sphere", id: "sphere/4/10", bound: 1.25 } as const;
    expect(spaceScoreWord(sphere)).toBe("Radius ρ");
    const box = spaceScoreBox(sphere, 1.5);
    expect(box.label).toBe("Radius ρ");
    expect(box.bound).toBe(1.25);
    expect(box.gap).toBeCloseTo(0.2, 12);
    expect(box).not.toHaveProperty("density");

    const poly = { family: "polyhedra", id: "polyhedra/a/12", bound: null } as const;
    expect(spaceScoreWord(poly)).toBe("Scale s");
    // no bound given: no gap either
    expect(spaceScoreBox(poly, 3)).toEqual({ label: "Scale s", bound: null, gap: null });
    expect(spaceScoreBox({ ...poly, bound: 2 }, null).gap).toBeNull();
  });

  it("tells a circle container from a polygon one on a curved problem", () => {
    expect(spaceScoreWord({ family: "curved", id: "curved/-1/3/0/5" })).toBe("Radius r");
    expect(spaceScoreWord({ family: "curved", id: "curved/-1/3/4/5" })).toBe("Side s");
  });

  it("mounts and destroys on a fake host, and a drawing destroyed before it loads is never mounted", async () => {
    const classes = new Set<string>();
    let replaced = 0;
    const host = {
      classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
      replaceChildren: () => void replaced++,
    } as unknown as HTMLElement;
    const board = mountSpaceBoard(host, { family: "sphere", id: "sphere/4/10", P: 10 });
    expect(classes.has("t-space-board")).toBe(true);
    expect(() => board.show(null)).not.toThrow();
    board.destroy();
    expect(classes.has("t-space-board")).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    // only destroy emptied the host: the late load did not draw into it
    expect(replaced).toBe(1);
  });

  it("is not imported by the page's own modules, except as types", () => {
    const dir = new URL("../src/tighter/", import.meta.url);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(new URL(f, dir), "utf8");
      for (const m of src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gms)) {
        expect(m[1], `${f} imports ${m[1]} eagerly`).not.toMatch(
          /(^|\/)space\/|^@polypack\/spaces|^@polypack\/view3d|three/,
        );
      }
    }
    // the drawing is reached by dynamic imports alone
    expect(readFileSync(new URL("board-space.ts", dir), "utf8")).toMatch(/import\("\.\.\/space\/view"\)/);
  });
});

describe("Tighter dev cheats for dimensions", () => {
  it("open a dimension and deal a space problem by its id", () => {
    const s = newGame(1_000_000, 1);
    expect(openDimension(s, "2-on-3")).toBe(true);
    expect(openDimension(s, "2-on-3")).toBe(false);
    expect(s.standing.dimensions).toContain("2-on-3");
    const p = dealSpaceProblem(s, "sphere/4/10", 1_000_000, { bound: 1.2, best: null });
    expect(typeof p).not.toBe("string");
    expect(s.focus).toBe("sphere/4/10");
    expect(s.queue.find((q) => q.key === "sphere/4/10")?.bound).toBe(1.2);
    expect(dealSpaceProblem(s, "24/30/40", 1_000_000, { bound: null, best: null })).toMatch(/not a space problem/);
  });
});
