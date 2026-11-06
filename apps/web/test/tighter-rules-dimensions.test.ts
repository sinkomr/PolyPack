import { describe, expect, it } from "vitest";
import { drawSliceProblem, sliceHasCircles } from "../src/tighter/catalogue";
import { SourceReach, drawWide, filterSources, newDealer, nextRandom, pickSource, ruleWideLeft, sourceOdds } from "../src/tighter/dealer";
import { SMALL_PIECES, SMALL_TOTAL, keyOf, parseKey, poly } from "../src/tighter/frontier";
import { Archive } from "../src/tighter/archive";
import { newGame } from "../src/tighter/game";
import { fromJson, toJson } from "../src/tighter/save";
import { SLICES } from "../src/tighter/slices";
import {
  RENT_CLASSES,
  hasCircles,
  isSmall,
  rentClass,
  rentClassFactor,
  ruleAllowsProblem,
  ruleOpenProblems,
  ruleOpenWide,
  ruleRewardFactor,
} from "../src/tighter/standing";
import { spaceFields } from "../src/tighter/families";

const T0 = 1_000_000;
const fam = (id: string) => parseKey(id)!;
const standingWith = (rule: "circles" | "small" | null, done: string[] = []) => {
  const s = newGame(T0, 1).standing;
  return { ...s, rule, rulesDone: done };
};

describe("Tighter rules in every Dimension", () => {
  it("deal other families by pieces (small) and by disks or balls (circles)", () => {
    const small = standingWith("small");
    const circles = standingWith("circles");
    const cases: [string, boolean, boolean][] = [
      // id, small, circles
      ["surface/cube/fold/5/30", true, false],
      ["surface/cube/fold/0/31", false, true],
      ["curved/-1/0/5/20", true, true],
      ["curved/-1/6/0/20", true, true],
      ["curved/-1/6/5/20", true, false],
      ["sphere/0/12", true, true],
      ["sphere/7/40", false, false],
      ["torus/sq/0/200", false, true],
      ["torus/hex/4/30", true, false],
      ["polyhedra/cubincub/12", true, false],
      ["polyhedra/cubincub/300", false, false],
      ["balls/ballinball/31", false, true],
      ["balls/ballincub/10", true, true],
      ["balls/cubinball/10", true, true],
    ];
    for (const [id, s, c] of cases) {
      expect(spaceFields(id), id).not.toBeNull();
      expect(ruleAllowsProblem(small, fam(id)), `small ${id}`).toBe(s);
      expect(ruleAllowsProblem(circles, fam(id)), `circles ${id}`).toBe(c);
    }
    expect(ruleAllowsProblem(small, poly(40, 40, 41))).toBe(false);
    expect(ruleAllowsProblem(small, poly(21, 21, 40))).toBe(true);
  });

  it("pay each finished rule's 1.5 times on the problems it deals, in every family", () => {
    const done = standingWith(null, ["circles", "small"]);
    expect(ruleRewardFactor(done, fam("sphere/0/12"), null)).toBe(2.25);
    expect(ruleRewardFactor(done, fam("sphere/5/12"), null)).toBe(1.5);
    expect(ruleRewardFactor(done, fam("sphere/0/90"), null)).toBe(1.5);
    expect(ruleRewardFactor(done, fam("sphere/5/90"), null)).toBe(1);
    expect(ruleRewardFactor(done, fam("polyhedra/cubincub/12"), null)).toBe(1.5);
    expect(ruleRewardFactor(standingWith(null, ["small"]), fam("balls/ballinball/50"), null)).toBe(1);
  });

  it("extend the rent classes after the old ones, so a saved game pays the same rent", () => {
    expect(RENT_CLASSES).toBe(8);
    // classes 0 to 3 are polygons by the bits (circles 1, small 2); the family class 4 held every other family
    expect(rentClass(poly(40, 40, 100))).toBe(0);
    expect(rentClass(poly(0, 40, 100))).toBe(1);
    expect(rentClass(poly(21, 21, 40))).toBe(2);
    expect(rentClass(poly(0, 21, 40))).toBe(3);
    expect(rentClass(fam("sphere/5/90"))).toBe(4);
    expect(rentClass(fam("sphere/0/90"))).toBe(5);
    expect(rentClass(fam("sphere/5/12"))).toBe(6);
    expect(rentClass(fam("sphere/0/12"))).toBe(7);
    // what an old save's rules paid: polygons 1, 1.5, 1.5, 2.25 and a family 1
    const old = standingWith(null, ["circles", "small"]);
    expect([0, 1, 2, 3, 4].map((c) => rentClassFactor(old, c))).toEqual([1, 1.5, 1.5, 2.25, 1]);
    expect([5, 6, 7].map((c) => rentClassFactor(old, c))).toEqual([1.5, 1.5, 2.25]);
    // a class always pays what the problem would
    for (const p of [poly(0, 4, 5), poly(5, 6, 7), fam("balls/ballinball/9"), fam("torus/sq/5/400"), fam("curved/-1/0/3/50")])
      expect(rentClassFactor(old, rentClass(p))).toBe(ruleRewardFactor(old, p, null));
    // the sums are rebuilt from the rows on load, so a save with rules done and old rows loads and sums per class
    const g = newGame(T0, 1);
    g.standing.rulesDone = ["small"];
    const back = fromJson(toJson(g), T0);
    expect(back.ok && back.state.standing.rulesDone).toEqual(["small"]);
    const a = new Archive();
    const row = (key: string, base: number) => ({ ...parseKey(key)!, key, rp: base, base }) as never;
    a.put(row("21/21/40", 10));
    a.put(row("sphere/5/12", 5));
    a.put(row("sphere/5/90", 7));
    expect([a.baseSum(2), a.baseSum(6), a.baseSum(4), a.baseSum(0)]).toEqual([10, 5, 7, 0]);
  });
});

describe("Tighter draws under the rules", () => {
  const open = SLICES.map((s) => s.id);
  it("keep every slice's draws within 30 pieces, and the slices that can, within disks or balls", () => {
    const d = newDealer(11);
    for (const s of SLICES) {
      for (let i = 0; i < 120; i++) {
        const k = drawSliceProblem(d, s.id, { listings: {}, exclude: new Set(), open, maxP: SMALL_PIECES });
        expect(k, s.id).not.toBeNull();
        expect(k!.P).toBeLessThanOrEqual(SMALL_PIECES);
        expect(isSmall(k!)).toBe(true);
        const c = drawSliceProblem(d, s.id, { listings: {}, exclude: new Set(), open, circles: true });
        if (sliceHasCircles(s.id)) {
          expect(c, s.id).not.toBeNull();
          expect(hasCircles(c!), c!.id).toBe(true);
        } else expect(c, s.id).toBeNull();
      }
    }
    // the polyhedra slices are the ones without circles
    expect(SLICES.filter((s) => !sliceHasCircles(s.id)).every((s) => s.id.startsWith("poly-"))).toBe(true);
  });

  it("draw starters inside the rules too", () => {
    const d = newDealer(5);
    for (const s of SLICES.filter((x) => x.free)) {
      for (let i = 0; i < 20; i++) {
        const k = drawSliceProblem(d, s.id, { listings: {}, exclude: new Set(), open, starter: true, maxP: SMALL_PIECES });
        if (k) expect(k.P).toBeLessThanOrEqual(SMALL_PIECES);
        const c = drawSliceProblem(d, s.id, { listings: {}, exclude: new Set(), open, starter: true, circles: true });
        if (c) expect(hasCircles(c)).toBe(true);
      }
    }
  });
});

describe("Tighter wide pools under the rules", () => {
  it("count about 10,660 small problems and 73,760 with circles, and draw only what the rule allows", () => {
    let small = 0;
    for (let n = 21; n <= 100; n++)
      for (let m = 21; m <= 100; m++) small += Math.max(0, Math.min(500, SMALL_TOTAL - n - m) - 40 + 1);
    expect(ruleWideLeft("small")).toBe(small);
    expect(small).toBeGreaterThan(10_000);
    expect(small).toBeLessThan(11_000);
    expect(ruleWideLeft("circles")).toBe(2 * 80 * 461);
    for (const rule of ["small", "circles"] as const) {
      const s = standingWith(rule);
      const d = newDealer(3);
      for (let i = 0; i < 500; i++) {
        const k = drawWide(d, new Set(), () => true, 1, 2.5, null, rule);
        expect(k).not.toBeNull();
        expect(ruleAllowsProblem(s, k!)).toBe(true);
      }
    }
    expect(ruleOpenWide(standingWith("small"))).toBe("small");
    expect(ruleOpenWide(standingWith(null))).toBeNull();
  });

  it("respect the player's filters and report what is left of them", () => {
    const f = { pieces: [21], containers: [21, 22], minP: 40, maxP: 78, tiers: null };
    // (21, 21): P 40 to 78; (21, 22): P 40 to 77
    expect(ruleWideLeft("small", f)).toBe(39 + 38);
    const d = newDealer(2);
    for (let i = 0; i < 100; i++) {
      const k = drawWide(d, new Set(), () => true, 1, 1, f, "small")!;
      expect(k.family === "polygon" && k.N === 21 && [21, 22].includes(k.M) && k.P <= 78).toBe(true);
    }
    // pieces limited to side 21 and no circle among them: only circle containers with side-21 pieces, P 40 to 78
    expect(ruleWideLeft("circles", { ...f, containers: [0] })).toBe(0 + 39 * 1);
    expect(ruleWideLeft("circles", { ...f, pieces: [21], containers: [21] })).toBe(0);
  });

  it("do not offer an open pool that is used up", () => {
    const small = standingWith("small");
    const list = ruleOpenProblems(small)!;
    const base: SourceReach = { contested: new Set(), ringMin: Infinity, wide: false, space: true, ruled: list };
    // the rule's list alone: open while any is left, not once all are used
    expect(filterSources(null, base).open).toBe(true);
    expect(filterSources(null, { ...base, used: new Set(list.map(keyOf)) }).open).toBe(false);
    // with the wide set it stays possible, until that is used up too
    const f = { pieces: [21], containers: [21], minP: 40, maxP: 78, tiers: null };
    const wide = { ...base, ruledWide: "small" as const };
    expect(filterSources(f, { ...wide, used: new Set(list.map(keyOf)) }).open).toBe(true);
    const all = new Set(list.map(keyOf));
    for (let P = 40; P <= 78; P++) all.add(keyOf(poly(21, 21, P)));
    expect(filterSources(f, { ...wide, used: all }).open).toBe(false);
    expect(ruleWideLeft("small", f, all)).toBe(0);
    // so the odds go to the other sources
    expect(sourceOdds(filterSources(f, { ...wide, used: all }), 0.3).map(([s]) => s)).toEqual(["space"]);
  });

  it("keep 2D in 2D a substantial share of deals under Small problems only with 3D in 3D open", () => {
    const small = standingWith("small");
    for (const seed of [1, 2, 3, 4, 5]) {
      const d = newDealer(seed);
      const used = new Set<string>();
      const list = ruleOpenProblems(small)!;
      let polygon = 0;
      let space = 0;
      let dry = 0;
      for (let deal = 0; deal < 400; deal++) {
        const reach: SourceReach = {
          contested: new Set(["loose" as const]),
          ringMin: 0,
          wide: false,
          space: true,
          ruled: list,
          ruledWide: "small",
          used,
        };
        const src = pickSource(sourceOdds(filterSources(null, reach), 0.3), nextRandom(d));
        if (src === "space") {
          space++;
          continue;
        }
        if (src === "contested") {
          // a site record of a small pair: the rule's own list does not limit it, the player's filters are open
          polygon++;
          continue;
        }
        // the frontier first, then the wide set
        const k =
          list.find((p) => !used.has(keyOf(p))) ?? drawWide(d, used, (p) => !used.has(keyOf(p)), 24, 2.5, null, "small");
        if (!k) {
          dry++;
          continue;
        }
        used.add(keyOf(k));
        polygon++;
      }
      expect(dry).toBe(0);
      expect(polygon / (polygon + space)).toBeGreaterThan(0.5);
      expect(space / (polygon + space)).toBeLessThan(0.45);
    }
  });
});
