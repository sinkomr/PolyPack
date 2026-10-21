import { describe, expect, it } from "vitest";
import { MYSTERY, shopView } from "../src/tighter/shop";
import { UPGRADES, UpgradeId, laneCount, lanesMaxed, owning } from "../src/tighter/upgrades";

const broke = { rp: 0, standing: 0 };
const card = (v: ReturnType<typeof shopView>, id: UpgradeId) => v.rows.flatMap((r) => r.cards).find((c) => c.id === id);
const row = (v: ReturnType<typeof shopView>, id: string) => v.rows.find((r) => r.id === id)!;

describe("Tighter shop", () => {
  it("shows the whole tree from the start, row by row, the Standing row aside", () => {
    const v = shopView(owning([]), broke, 8);
    expect(v.rows.map((r) => r.id)).toEqual([
      "clicks",
      "auto",
      "seeds",
      "queue",
      "methods",
      "runs",
      "problems",
      "dealer",
      "records",
    ]);
    const shown = v.rows.flatMap((r) => r.cards.map((c) => c.id));
    expect(new Set(shown)).toEqual(new Set(UPGRADES.filter((u) => u.row !== "standing").map((u) => u.id)));
    expect(shown.length).toBe(UPGRADES.filter((u) => u.row !== "standing").length);
    expect(v.owned).toBe(0);
    expect(v.total).toBe(UPGRADES.filter((u) => u.row !== "standing").length);
    // the first card can be worked toward; the rest are locked or mysteries
    expect(card(v, "trace")).toMatchObject({ state: "dear", price: "5 RP", needs: [] });
    expect(card(v, "click2")).toMatchObject({ state: "locked", needs: ["Trace detail"], price: "150 RP" });
    expect(card(v, "click2")!.label).toBe("2 evaluations per click: needs Trace detail");
    expect(row(v, "clicks").cards[0].id).toBe("trace");
  });

  it("hides a mystery's name, effect and price until its prerequisites are owned", () => {
    const v = shopView(owning([]), broke, 8);
    const harden = card(v, "harden")!;
    expect(harden).toMatchObject({
      state: "mystery",
      name: MYSTERY,
      effect: MYSTERY,
      cost: null,
      price: null,
      real: null,
    });
    expect(harden.needs).toEqual(["Method: seed"]);
    // a prerequisite that is itself an unrevealed mystery reads ?????? too
    expect(card(v, "morph")!.needs).toEqual([MYSTERY]);
    expect(card(v, "transfer")!.needs).toEqual(["Method: seed", "Wider frontier"]);
    expect(harden.label).not.toMatch(/harden/i);
    expect(v.mysteries).toBe(UPGRADES.filter((u) => u.mystery && u.row !== "standing").length);
    // owning the prerequisite reveals it
    const w = shopView(owning(["lattice"]), { rp: 30000, standing: 0 }, 8);
    expect(card(w, "harden")).toMatchObject({
      state: "buyable",
      name: "Method: harden",
      price: "30,000 RP",
      needs: [],
    });
    expect(card(w, "morph")!.needs).toEqual(["Method: harden"]);
    // mysteries sort after what can be worked toward
    const methods = row(w, "methods").cards.map((c) => c.state);
    expect(methods.indexOf("mystery")).toBeGreaterThan(methods.lastIndexOf("locked"));
  });

  it("folds owned upgrades into one line, and a row with nothing left into that line alone", () => {
    const clicks: UpgradeId[] = ["trace", "click2", "click3"];
    const v = shopView(owning(clicks), { rp: 400, standing: 0 }, 8);
    // a ladder folds to where it stands
    expect(row(v, "clicks").owned).toEqual(["Trace detail", "2 to 3 evaluations per click"]);
    expect(row(v, "clicks")).toMatchObject({ ownedCount: 3, total: 11 });
    expect(card(v, "click3")).toBeUndefined();
    expect(card(v, "click4")).toMatchObject({ state: "dear" });
    const seeds: UpgradeId[] = ["seeds", "seeds2", "seeds4", "seeds8", "seeds16", "seeds32"];
    const w = shopView(owning(seeds), broke, 8);
    expect(row(w, "seeds").cards).toEqual([]);
    expect(row(w, "seeds").owned).toEqual(["Seed counter", "Seeds: up to 32 per problem"]);
    expect(w.owned).toBe(6);
  });

  it("shows a levelled upgrade's level and the next level's price", () => {
    const o = owning(["click10", "clickx"], { clickx: 2 });
    const v = shopView(o, { rp: 3125, standing: 0 }, 8);
    expect(card(v, "clickx")).toMatchObject({
      state: "buyable",
      level: 2,
      price: "next level 3,125 RP",
      levelText: "Level 2",
    });
    expect(card(v, "clickx")!.label).toBe("Buy One more evaluation per click level 3 for 3125 record points");
    expect(row(v, "clicks").owned).toContain("One more evaluation per click (level 2)");
    const t = shopView(owning(["sweeps10", "basin", "tuneMc"], { tuneMc: 1 }), broke, 8);
    expect(card(t, "tuneMc")).toMatchObject({ level: 1, levelText: "Level 1 of 3", price: "next level 24,000 RP" });
    const full = shopView(owning(["sweeps10", "basin", "tuneMc"], { tuneMc: 3 }), broke, 8);
    expect(card(full, "tuneMc")).toBeUndefined();
    expect(row(full, "runs").owned).toContain("mc_compress tuning (level 3, the last)");
  });

  it("stops offering lanes once every core but one has one", () => {
    const o = (l: number) => owning(["lanes2", "continuous", "lanesx"], { lanesx: l });
    expect(laneCount(o(2), 6)).toBe(4);
    expect(lanesMaxed(o(2), 6)).toBe(false);
    expect(card(shopView(o(2), broke, 6), "lanesx")).toMatchObject({
      level: 2,
      levelText: "Level 2 · 4 lanes; this CPU runs at most 5",
    });
    expect(lanesMaxed(o(3), 6)).toBe(true);
    const v = shopView(o(3), broke, 6);
    expect(card(v, "lanesx")).toBeUndefined();
    expect(row(v, "queue").owned).toContain("Another lane (level 3, every core)");
    // a CPU with two cores runs two lanes at most: Another lane would add nothing
    const two = shopView(owning(["lanes2", "continuous"]), broke, 2);
    expect(card(two, "lanesx")).toBeUndefined();
    expect(row(two, "queue").owned).toContain("Another lane: no core left for one on this CPU");
  });

  it("shows an upgrade kept through a reset as owned, though its prerequisites are not", () => {
    const v = shopView(owning(["standing"]), broke, 8);
    expect(card(v, "standing")).toBeUndefined();
    expect(row(v, "records").owned).toEqual(["Standing"]);
  });

  it("shows the Standing row, priced in standing, once Standing is owned", () => {
    const v = shopView(owning(["standing"]), { rp: 1e9, standing: 2 }, 8);
    const r = row(v, "standing");
    expect(r.cards.find((c) => c.id === "head1")).toMatchObject({ state: "buyable", price: "1 standing" });
    expect(r.cards.find((c) => c.id === "head1")!.label).toBe("Buy Head start I for 1 standing");
    expect(r.cards.find((c) => c.id === "head3")).toMatchObject({ state: "mystery", needs: [MYSTERY] });
    expect(r.cards.find((c) => c.id === "rules")).toMatchObject({ state: "dear", price: "3 standing" });
  });
});

describe("Tighter shop owned line", () => {
  it("folds each ladder to where it stands", async () => {
    const { foldOwned } = await import("../src/tighter/shop");
    expect(
      foldOwned([
        "Auto-eval",
        "Auto-eval: every 4 s",
        "Away: 4 hours",
        "Auto-eval: 1 a second",
        "Away: 12 hours",
        "Faster auto-eval (level 2)",
      ]),
    ).toEqual(["Auto-eval", "Auto-eval: 1 a second", "Away: 12 hours", "Faster auto-eval (level 2)"]);
    expect(foldOwned(["2 evaluations per click"])).toEqual(["2 evaluations per click"]);
    expect(foldOwned(["Problem queue: 3", "Auto-advance", "Problem queue: 4"])).toEqual([
      "Problem queue: 4",
      "Auto-advance",
    ]);
  });
});

describe("Tighter shop chips", () => {
  it("shorten the long names, the full name staying in the details", async () => {
    const { chipName } = await import("../src/tighter/shop");
    expect(chipName("7 evaluations per click")).toBe("7 a click");
    expect(chipName("Auto-eval: every 4 s")).toBe("Auto: 4 s");
    expect(chipName("Auto-eval: 10 a second")).toBe("Auto: 10/s");
    expect(chipName("Seeds: 16 per problem")).toBe("Seeds: 16");
    expect(chipName("Problem sets: N+M+P ≥ 120")).toBe("Size ≥ 120");
    expect(chipName("Method: basin_hopping")).toBe("basin_hopping");
    expect(chipName("Dealer: best of 4")).toBe("best of 4");
    expect(chipName("Auto-advance")).toBe("Auto-advance");
  });
});

describe("Tighter tech tree", () => {
  it("shows every upgrade as a node with its state, owned ones included, the Standing row once Standing is owned", async () => {
    const { treeView, MYSTERY: M } = await import("../src/tighter/shop");
    const funds = { rp: 200, standing: 0 };
    const v = treeView(owning(["trace"]), funds, 8);
    const node = (id: UpgradeId) => v.nodes.find((n) => n.id === id)!;
    expect(v.nodes.length).toBe(UPGRADES.filter((u) => u.row !== "standing").length);
    expect(node("trace").state).toBe("owned");
    expect(node("click2")).toMatchObject({ state: "buyable", price: "150 RP" });
    expect(node("click3").state).toBe("locked");
    expect(node("harden")).toMatchObject({ state: "mystery", name: M });
    expect(v.buyable).toBe(1);
    // nothing affordable: the next upgrade to save for is the cheapest one whose prerequisites are owned
    const poor = treeView(owning(["trace"]), { rp: 10, standing: 0 }, 8);
    expect(poor.buyable).toBe(0);
    expect(poor.next?.id).toBe("click2");
    const st = treeView(owning(["standing"]), funds, 8);
    expect(st.rows.map((r) => r.id)).toContain("standing");
    expect(st.nodes.find((n) => n.id === "head1")!.state).toBe("dear");
  });

  it("lays every node out to the right of its prerequisites, without two nodes in one place", async () => {
    const { treeView, treeLayout, TREE } = await import("../src/tighter/shop");
    const v = treeView(owning(["standing"]), { rp: 0, standing: 0 }, 8);
    const l = treeLayout(v.rows, v.nodes);
    expect(l.at.size).toBe(v.nodes.length);
    const seen = new Set<string>();
    for (const n of v.nodes) {
      const a = l.at.get(n.id)!;
      expect(seen.has(`${a.x},${a.y}`)).toBe(false);
      seen.add(`${a.x},${a.y}`);
      for (const r of UPGRADES.find((u) => u.id === n.id)!.requires) {
        const b = l.at.get(r);
        if (b) expect(b.x + TREE.nodeW).toBeLessThan(a.x);
      }
      expect(a.x + TREE.nodeW).toBeLessThanOrEqual(l.width);
      expect(a.y + TREE.nodeH).toBeLessThanOrEqual(l.height);
    }
    // a band per row, one after another
    expect(l.bands.map((b) => b.id)).toEqual(v.rows.map((r) => r.id));
    l.bands.slice(1).forEach((b, i) => expect(b.y).toBe(l.bands[i].y + l.bands[i].h));
  });

  it("list a row on a phone with what is not owned first, prerequisites before what they open, owned last", async () => {
    const { treeView, listOrder, PHONE_QUERY } = await import("../src/tighter/shop");
    const o = owning(["trace", "click2", "click3", "auto1"]);
    const v = treeView(o, { rp: 0, standing: 0 });
    const clicks = listOrder(v.nodes.filter((n) => n.row === "clicks"));
    const firstOwned = clicks.findIndex((n) => n.state === "owned");
    expect(firstOwned).toBeGreaterThan(0);
    expect(clicks.slice(firstOwned).every((n) => n.state === "owned")).toBe(true);
    const open = clicks.slice(0, firstOwned);
    open.slice(1).forEach((n, i) => expect(n.depth).toBeGreaterThanOrEqual(open[i].depth));
    expect(open[0].id).toBe("click4");
    // the order does not depend on the points: affording something does not move it
    const rich = treeView(o, { rp: 1e9, standing: 0 });
    expect(listOrder(rich.nodes.filter((n) => n.row === "clicks")).map((n) => n.id)).toEqual(clicks.map((n) => n.id));
    // the same breakpoint as the stylesheet's phone layout
    expect(PHONE_QUERY).toBe(
      "(max-width: 759px), (max-height: 500px) and (orientation: landscape) and (max-width: 1023px)",
    );
  });
});
