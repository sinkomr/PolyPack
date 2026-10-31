import { describe, expect, it } from "vitest";
import { plain } from "../src/tighter/how";
import { AUTO_CLICK_EVALS, DEAL_CLICKS, WIDE } from "../src/tighter/dealer";
import {
  PAIR_BONUS,
  RENT_GROWTH,
  RENT_PAYDAY_MS,
  RENT_SHARE,
  RENT_WINDOW_MS,
  SHAPE_BONUS,
  SHAPE_MILESTONES,
  TIER_BONUS,
} from "../src/tighter/economy";
import { resolvedParams } from "../src/tighter/open-run";
import { CONTEST } from "../src/tighter/points";
import {
  LEARN_MIN_EVALS,
  LOOSE_WEAKNESS,
  MAX_RATIO,
  NEIGHBOURS,
  RP_PER_EVAL,
  msPerEval,
  room,
} from "../src/tighter/rank";
import { MAX_STAGES, MIN_OBSERVED_EVALS } from "../src/tighter/runplan";
import { RESET_MIN, resetThreshold, standingMultiplier } from "../src/tighter/standing";
import { GREEDY_BUDGET, MAX_NEIGHBOUR_LOOKUPS, TRANSFER_MARGIN } from "../src/tighter/transfer";
import { MYSTERY, shopView } from "../src/tighter/shop";
import { SLICES } from "../src/tighter/slices";
import {
  AUTO_SLACK_SECONDS,
  COMPACT_EVALS,
  RUN_BUDGET,
  TUNED_DEFAULTS,
  UPGRADES,
  EvolveMethod,
  canBuy,
  UpgradeId,
  costOf,
  exists,
  laneCount,
  slicePrice,
  lanesMaxed,
  owning,
  rpCostFactor,
} from "../src/tighter/upgrades";

const broke = { rp: 0, standing: 0 };
const card = (v: ReturnType<typeof shopView>, id: UpgradeId) => v.rows.flatMap((r) => r.cards).find((c) => c.id === id);
const row = (v: ReturnType<typeof shopView>, id: string) => v.rows.find((r) => r.id === id)!;

/** What the shop shows with only the first dimension open: the tree, the Standing row aside. */
const inTheFirstDimension = () => UPGRADES.filter((u) => u.row !== "standing" && exists(owning([]), u.id));

describe("Tighter shop", () => {
  it("shows the whole tree from the start, row by row, the Standing row aside", () => {
    const v = shopView(owning([]), broke, 8);
    expect(v.rows.map((r) => r.id)).toEqual([
      "clicks",
      "auto",
      "queue",
      "methods",
      "runs",
      "problems",
      "dimensions",
      "dealer",
      "records",
    ]);
    const shown = v.rows.flatMap((r) => r.cards.map((c) => c.id));
    expect(new Set(shown)).toEqual(new Set(inTheFirstDimension().map((u) => u.id)));
    expect(shown.length).toBe(inTheFirstDimension().length);
    // only Curved has a card before a reset opens a dimension
    expect(row(v, "dimensions").cards.map((c) => c.id)).toEqual(["curved"]);
    expect(v.owned).toBe(0);
    expect(v.total).toBe(inTheFirstDimension().length);
    // the first card can be worked toward; the rest are locked or mysteries
    expect(card(v, "trace")).toMatchObject({ state: "dear", price: "100 RP", needs: [] });
    expect(card(v, "click2")).toMatchObject({ state: "locked", needs: ["Trace detail"], price: "150 RP" });
    expect(card(v, "click2")!.label).toBe("2 evaluations per click: needs Trace detail");
    expect(row(v, "clicks").cards[0].id).toBe("trace");
  });

  it("hides a mystery's name, effect, explanation and price until its prerequisites are owned", () => {
    const v = shopView(owning([]), broke, 8);
    const harden = card(v, "harden")!;
    expect(harden).toMatchObject({
      state: "mystery",
      name: MYSTERY,
      effect: MYSTERY,
      cost: null,
      price: null,
      how: null,
    });
    expect(harden.needs).toEqual(["Lattice"]);
    // a prerequisite that is itself an unrevealed mystery reads ?????? too
    expect(card(v, "morph")!.needs).toEqual([MYSTERY]);
    expect(card(v, "transfer")!.needs).toEqual(["Lattice", "More open problems"]);
    expect(harden.label).not.toMatch(/harden/i);
    expect(v.mysteries).toBe(inTheFirstDimension().filter((u) => u.mystery).length);
    // owning the prerequisite reveals it
    const w = shopView(owning(["lattice"]), { rp: 240000, standing: 0 }, 8);
    expect(card(w, "harden")).toMatchObject({
      state: "buyable",
      name: "Method: harden",
      price: "240,000 RP",
      needs: [],
    });
    expect(card(w, "harden")!.how).toBe(UPGRADES.find((u) => u.id === "harden")!.how);
    expect(card(w, "morph")!.needs).toEqual(["Method: harden"]);
    // mysteries sort after what can be worked toward
    const methods = row(w, "methods").cards.map((c) => c.state);
    expect(methods.indexOf("mystery")).toBeGreaterThan(methods.lastIndexOf("locked"));
  });

  it("folds owned upgrades into one line, and a row with nothing left into that line alone", () => {
    const clicks: UpgradeId[] = ["trace", "click2", "click3"];
    const v = shopView(owning(clicks), { rp: 200, standing: 0 }, 8);
    // a ladder folds to where it stands
    expect(row(v, "clicks").owned).toEqual(["Trace detail", "2 to 3 evaluations per click"]);
    expect(row(v, "clicks")).toMatchObject({ ownedCount: 3, total: 10 });
    expect(card(v, "click3")).toBeUndefined();
    expect(card(v, "click4")).toMatchObject({ state: "dear" });
    const w = shopView(owning(["auto1", "autox"], { autox: 150 }), broke, 8);
    // Faster auto-eval has no last level: it stays a card to buy, however far it is owned
    expect(row(w, "auto").cards.map((c) => c.id)).toEqual(["autox"]);
    expect(card(w, "autox")).toMatchObject({ level: 150, levelText: "Level 150" });
    expect(row(w, "auto").owned).toEqual(["Auto-eval", "Faster auto-eval (level 150)"]);
    expect(w.owned).toBe(2);
  });

  it("shows a levelled upgrade's level and the next level's price", () => {
    const o = owning(["auto1", "autox"], { autox: 2 });
    const price = costOf(o, "autox");
    const v = shopView(o, { rp: price, standing: 0 }, 8);
    expect(card(v, "autox")).toMatchObject({
      state: "buyable",
      level: 2,
      price: `next level ${price.toLocaleString("en-US")} RP`,
      levelText: "Level 2",
    });
    expect(card(v, "autox")!.label).toBe(`Buy Faster auto-eval level 3 for ${price} record points`);
    expect(row(v, "auto").owned).toContain("Faster auto-eval (level 2)");
    const t = shopView(owning(["sweeps10", "basin", "tuneMc"], { tuneMc: 1 }), broke, 8);
    expect(card(t, "tuneMc")).toMatchObject({ level: 1, levelText: "Level 1 of 3", price: "next level 192,000 RP" });
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
        "Auto-eval: 2 evaluations a second",
        "Auto-eval: 5 evaluations a second",
        "Faster auto-eval (level 2)",
      ]),
    ).toEqual(["Auto-eval", "Auto-eval: 5 evaluations a second", "Faster auto-eval (level 2)"]);
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
    expect(chipName("Auto-eval: 1 evaluation a second")).toBe("Auto: 1/s");
    expect(chipName("Auto-eval: 10 evaluations a second")).toBe("Auto: 10/s");
    expect(chipName("Problem sets: N+M+P ≥ 120")).toBe("Size ≥ 120");
    expect(chipName("Method: basin_hopping")).toBe("basin_hopping");
    expect(chipName("Dealer: best of 4")).toBe("best of 4");
    expect(chipName("Auto-advance")).toBe("Auto-advance");
  });
});

describe("Tighter tech tree", () => {
  it("shows every upgrade as a node with its state, owned ones included, the Standing row once Standing is owned", async () => {
    const { treeView, MYSTERY: M } = await import("../src/tighter/shop");
    const funds = { rp: 2000, standing: 0 };
    const v = treeView(owning(["trace"]), funds, 8);
    const node = (id: UpgradeId) => v.nodes.find((n) => n.id === id)!;
    expect(v.nodes.length).toBe(inTheFirstDimension().length);
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

  it("gives an owned dealer upgrade a switch, on or off, and no other node one", async () => {
    const { treeView } = await import("../src/tighter/shop");
    const o = owning(["trace", "queue3", "rank2", "rank4", "filters"], {}, null, [], ["rank2"]);
    const v = treeView(o, { rp: 1e9, standing: 0 }, 8);
    const on = (id: UpgradeId) => v.nodes.find((n) => n.id === id)!.on;
    // a ladder's rungs share its switch
    expect(on("rank2")).toBe(false);
    expect(on("rank4")).toBe(false);
    expect(on("filters")).toBe(true);
    // not owned, or not a dealer upgrade: no switch
    expect(on("rank8")).toBeNull();
    expect(on("retake")).toBeNull();
    expect(on("queue3")).toBeNull();
    expect(on("trace")).toBeNull();
    expect(v.nodes.find((n) => n.id === "rank4")!.state).toBe("owned");
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

describe("Tighter tech tree summary", () => {
  const dims = ["2-in-2", "2-on-3", "3-in-3"] as Parameters<typeof owning>[6];
  /** Every upgrade owned except those in `except`, levels part-way: a heavy save. */
  const heavy = (except: UpgradeId[], standing: boolean) => {
    const ids = UPGRADES.filter((u) => !except.includes(u.id) && (standing || u.row !== "standing")).map((u) => u.id);
    const levels: Record<string, number> = {};
    for (const u of UPGRADES) if (u.levels) levels[u.id] = Math.ceil(u.levels.max / 2);
    return owning(ids, levels, null, [], [], 2, dims);
  };
  const states: [string, ReturnType<typeof owning>][] = [
    ["fresh", owning([])],
    ["early", owning(["trace"])],
    ["mid", owning(["trace", "click2", "click3", "auto1", "queue3"])],
    ["standing owned", owning(["standing", "trace"])],
    ["a dimension open", owning(["trace", "curved"], {}, null, [], [], 1, ["2-in-2", "2-on-3"])],
    ["three dimensions", owning(["trace", "click2"], {}, null, [], [], 2, dims)],
    ["heavy", heavy(["rank8", "harden", "retake"], false)],
    ["heavy with standing", heavy(["head1", "head2"], true)],
  ];
  const funds = [
    { rp: 0, standing: 0 },
    { rp: 10, standing: 0 },
    { rp: 150, standing: 0 },
    { rp: 5000, standing: 3 },
    { rp: 1e9, standing: 0 },
    { rp: 0, standing: 1e6 },
    { rp: 1e12, standing: 1e12 },
  ];

  it("gives the same buyable count and next target as the whole tree's view", async () => {
    const { treeView, treeSummary } = await import("../src/tighter/shop");
    let withNext = 0;
    let withBuyable = 0;
    for (const [name, o] of states)
      for (const f of funds) {
        const full = treeView(o, f, 8);
        const light = treeSummary(o, f, 8);
        expect(light.buyable, `${name} ${JSON.stringify(f)}`).toBe(full.buyable);
        expect(light.next, `${name} ${JSON.stringify(f)}`).toEqual(full.next);
        if (full.next) withNext++;
        if (full.buyable) withBuyable++;
      }
    // the cases are not all empty ones
    expect(withNext).toBeGreaterThan(5);
    expect(withBuyable).toBeGreaterThan(5);
  });

  it("counts a standing-priced card as buyable but never as the next one to save record points for", async () => {
    const { treeView, treeSummary } = await import("../src/tighter/shop");
    const o = owning(["standing", "trace"]);
    const rich = { rp: 0, standing: 1e6 };
    const full = treeView(o, rich, 8);
    expect(full.nodes.some((n) => n.currency === "standing" && n.state === "buyable")).toBe(true);
    expect(treeSummary(o, rich, 8).buyable).toBe(full.buyable);
    expect(treeSummary(o, { rp: 0, standing: 0 }, 8).next?.currency).toBe("rp");
  });
});

describe("Tighter upgrade texts", () => {
  const vars = (markup: string) => [...markup.matchAll(/<var>(.*?)<\/var>/g)].map((m) => m[1]);
  const all = (u: (typeof UPGRADES)[number]) => [
    ...(typeof u.how.text === "string" ? [u.how.text] : u.how.text),
    ...(u.how.math ?? []),
    ...(u.how.vars ?? []).flat(),
    u.how.note ?? "",
  ];

  it("explain every upgrade, defining every variable their formulas use", () => {
    for (const u of UPGRADES) {
      const text = typeof u.how.text === "string" ? [u.how.text] : u.how.text;
      expect(text.length, u.id).toBeGreaterThan(0);
      for (const t of text) expect(t.trim().length, u.id).toBeGreaterThan(20);
      const defined = new Set((u.how.vars ?? []).flatMap(([sym]) => vars(sym)));
      for (const line of u.how.math ?? []) for (const v of vars(line)) expect(defined, `${u.id}: ${v}`).toContain(v);
      // the variables' meanings and the prose are plain text; formulas keep to how.ts's tags
      for (const [, meaning] of u.how.vars ?? []) expect(meaning, u.id).not.toMatch(/<[a-z]/);
      for (const t of text) expect(t, u.id).not.toMatch(/<[a-z]/);
      for (const line of [...(u.how.math ?? []), ...(u.how.vars ?? []).map(([sym]) => sym)])
        for (const tag of line.matchAll(/<\/?([a-z]+)/g)) expect(["var", "sub", "sup", "code"], u.id).toContain(tag[1]);
    }
  });

  it("say what each upgrade gives in one short sentence, without the old labels", () => {
    for (const u of UPGRADES) {
      expect(u.effect, u.id).toMatch(/^[A-Za-z].*\.$/);
      expect(u.effect.split(/\s+/).length, u.id).toBeLessThanOrEqual(20);
      expect(u.effect, u.id).not.toMatch(/[;—]|\. \S/);
      for (const t of all(u)) expect(t, u.id).not.toMatch(/Real:|—|free floor/);
    }
  });

  it("state each tuning level's parameters from the solver's own defaults", () => {
    for (const [m, params] of Object.entries(TUNED_DEFAULTS) as [EvolveMethod, Record<string, number>][]) {
      const defaults = resolvedParams(m, {});
      for (const [k, v] of Object.entries(params)) expect(defaults[k], `${m}.${k}`).toBe(v);
    }
    const tune = UPGRADES.find((u) => u.id === "tuneMc")!;
    expect(tune.how.math).toEqual([
      "<code>sweepsPerEvaluation</code> = 10, 15, 20, 30",
      "<code>stagnationEvals</code> = 500, 500, 1000, 2000",
      "<code>maxRestarts</code> = 0, 0, 0, 2",
    ]);
  });

  it("give each rung of a ladder its own numbers", () => {
    const u = (id: UpgradeId) => UPGRADES.find((x) => x.id === id)!;
    expect(u("click3").effect).toBe("Each Evolve click runs 3 evaluations instead of 2.");
    expect(u("click3").how.math).toEqual(["<var>k</var> = 3 + <var>r</var>"]);
    expect(u("auto1").effect).toBe("Auto-eval runs 1 evaluation a second for you while it is switched on.");
    expect(u("auto1").how.math).toEqual([
      "<var>r</var> = 1",
      "<var>r</var><sub>lane</sub> = <var>r</var> / <var>L</var>",
    ]);
    expect(UPGRADES.some((x) => /^auto([2-9]|10)$/.test(x.id))).toBe(false);
    expect(u("autox").effect).toBe(
      "Each level makes auto-eval faster, by 1 evaluation a second at first and more later, with no last level.",
    );
    const math = u("autox").how.math!.map(plain);
    expect(math[0]).toContain("r = 1 + a");
    expect(math).toContain("C(r) = 40 + Σ 120 × e0.0095 x, for x = 2 to r");
    expect(math).toContain("rlane = r / L");
    expect(u("lanes2").how.math).toContain("<var>r</var><sub>lane</sub> = <var>r</var> / <var>L</var>");
    expect(u("wide").name).toBe("More open problems");
    expect(u("queue4").effect).toBe("The queue holds 4 problems, and the dealer earns a new one every 75 clicks.");
    expect(u("ring80").how.math).toEqual(["<var>N</var> + <var>M</var> + <var>P</var> ≥ 80"]);
    expect(u("rank4").effect).toBe("The dealer draws 4 problems instead of 2 and deals the best one.");
  });

  it("give auto-eval's rate in evaluations a second, which evaluations per click do not change", () => {
    for (const u of UPGRADES) {
      const t = all(u).join(" ");
      expect(t, u.id).not.toMatch(/speeds? (it|auto-eval) up too|clicks are as large|clicks grow with yours/i);
      expect(t, u.id).not.toMatch(/auto-eval('s)? click|clicks? (Evolve )?for you|its clicks/i);
    }
    const text = (id: UpgradeId) => all(UPGRADES.find((u) => u.id === id)!).join(" ");
    expect(text("auto1")).toContain("whatever your evaluations per click");
    expect(text("click5")).toContain("Auto-eval keeps its own rate in evaluations a second");
    expect(UPGRADES.some((u) => u.id === ("clickx" as UpgradeId))).toBe(false);
    // Faster auto-eval has no last level, and says that the computer is the limit
    expect(text("autox")).toContain("You can buy as many levels as you like");
    expect(text("autox")).toContain("At some point your computer is the limit");
    expect(text("head1")).toContain("Auto-eval at 1 evaluation a second");
    expect(text("head2")).toContain("Faster auto-eval up to level 9 (10 evaluations a second)");
  });

  it("say that the lanes share auto-eval's rate, and never that each lane runs it", () => {
    for (const u of UPGRADES) expect(all(u).join(" "), u.id).not.toMatch(/in each lane|in every lane|per lane/);
    const text = (id: UpgradeId) => all(UPGRADES.find((u) => u.id === id)!).join(" ");
    for (const id of ["auto1", "lanes2", "lanesx"] as UpgradeId[])
      expect(text(id), id).toMatch(/The lanes share (it|auto-eval's rate)/);
    expect(text("lanesx")).toContain("adds no evaluations");
    expect(text("autox")).toContain("the lanes share it");
  });

  it("count the work that earns a new problem in clicks, auto-eval's evaluations 10 to the click", () => {
    const text = (id: UpgradeId) => all(UPGRADES.find((u) => u.id === id)!).join(" ");
    expect(text("queue3")).toContain(
      "With 3 slots that is one deal per 100 clicks, or per 1,000 evaluations of auto-eval.",
    );
    expect(text("queue3")).toContain(
      "<var>c</var> = <var>e</var><sub>you</sub> / <var>k</var> + <var>e</var><sub>auto</sub> / 10",
    );
    expect(text("click5")).toContain("Auto-eval's evaluations count 10 to the click.");
    expect(text("advance")).toContain("10 evaluations of auto-eval count as one click");
    for (const u of UPGRADES) expect(all(u).join(" "), u.id).not.toMatch(/clicks' worth|300 × /);
  });

  it("call no part of the game the frontier, and name each piece shape in a container shape a shape pair", () => {
    for (const u of UPGRADES) expect([u.name, u.effect, ...all(u)].join(" "), u.id).not.toMatch(/frontier/i);
    const text = (id: UpgradeId) => all(UPGRADES.find((u) => u.id === id)!).join(" ");
    expect(text("collections")).toContain("A shape pair is one piece shape in one container shape");
    expect(text("collector")).toContain("A collection is one piece shape in one container shape");
  });

  // The texts are written in numbers; these are the game's constants they quote.
  it("quote the game's own constants", () => {
    const text = (id: UpgradeId) => all(UPGRADES.find((u) => u.id === id)!).join(" ");
    expect([DEAL_CLICKS, AUTO_CLICK_EVALS]).toEqual([300, 10]);
    expect(text("queue3")).toContain("<var>q</var> × <var>c</var> / 300");
    expect([COMPACT_EVALS, RUN_BUDGET, AUTO_SLACK_SECONDS]).toEqual([100, 100_000, 60]);
    expect(text("advance")).toContain("100 evaluations of mc_compress");
    expect(text("shrink")).toContain("A run ends by itself after 1,000 evaluations without progress.");
    expect(text("auto1")).toContain("60 s");
    expect([RENT_SHARE, RENT_GROWTH, RENT_WINDOW_MS / 3_600_000, RENT_PAYDAY_MS / 3_600_000]).toEqual([
      0.01, 1.5, 168, 24,
    ]);
    expect(text("rent")).toContain("0.01 × <var>B</var> × 1.5<sup>");
    expect(text("rent")).toContain("On payday, the game checks all your records");
    expect(CONTEST).toEqual({ open: 1, loose: 3, batch: 10, published: 100 });
    expect([room("open", null), room("loose", 1), room("batch", null), room("published", null)]).toEqual([
      1, 1, 0.1, 0.004,
    ]);
    expect(room("loose", 0.01)).toBeCloseTo(0.3 + 25 * 0.01, 12);
    expect([RP_PER_EVAL, LOOSE_WEAKNESS, NEIGHBOURS, msPerEval(85)]).toEqual([4, 0.005, 3, 1.77]);
    expect(text("rank2")).toContain("× 4 ×");
    expect(text("learning")).toContain("(w × c × R × κ × 4");
    expect(text("reach2")).toContain("≥ 0.005");
    expect([LEARN_MIN_EVALS, MAX_RATIO, MIN_OBSERVED_EVALS, MAX_STAGES]).toEqual([200, 20, 20, 9]);
    expect(text("learning")).toContain("at least 200 evaluations");
    expect(text("methodMatch")).toContain("at least 20 evaluations");
    expect(text("pipeline")).toContain("up to 9 methods");
    expect([PAIR_BONUS, SHAPE_BONUS, TIER_BONUS, [...SHAPE_MILESTONES]]).toEqual([0.02, 0.01, 0.05, [10, 30, 100]]);
    expect(text("collections")).toContain("1 + 0.02 × <var>a</var> + 0.01 × <var>b</var> + 0.05 × <var>t</var>");
    expect([TRANSFER_MARGIN, MAX_NEIGHBOUR_LOOKUPS]).toEqual([0.98, 4]);
    // 6 missing pieces fit the greedy placement's budget (33 spots tried each), 7 do not
    expect([6 * 33 <= GREEDY_BUDGET, 7 * 33 <= GREEDY_BUDGET]).toEqual([true, false]);
    expect(text("transfer")).toContain("6 or fewer");
    expect(WIDE).toMatchObject({ minSide: 21, maxSide: 100, minP: 40, maxP: 500 });
    expect(RESET_MIN).toBe(1_000_000_000);
    expect(standingMultiplier({ total: 1 } as Parameters<typeof standingMultiplier>[0])).toBeCloseTo(1.1, 12);
    expect(text("standing")).toContain("earned 1,000,000,000 record points");
    expect(text("standing")).toContain("1,000,000,000 × 5<sup>");
    expect(text("standing")).toContain("⌊5 × √(");
    expect(rpCostFactor(owning(["study"], { study: 2 }))).toBeCloseTo(0.81, 12);
  });
});

describe("Tighter dimension cards", () => {
  const funds = { rp: 1e12, standing: 0 };
  const rest = (ids: UpgradeId[], resets: number, dims: Parameters<typeof owning>[6], levels = {}) =>
    owning(ids, levels, null, [], [], resets, dims);
  const cardIds = (o: ReturnType<typeof owning>) => row(shopView(o, funds, 8), "dimensions").cards.map((c) => c.id);

  it("exist only while their dimension is open, Curved from the first cycle on", () => {
    expect(cardIds(owning([]))).toEqual(["curved"]);
    const two = rest([], 1, ["2-in-2", "2-on-3"]);
    expect(cardIds(two).sort()).toEqual(
      [
        "curved",
        "surf-prisms",
        "surf-archimedean",
        "surf-johnson",
        "surf-catalan-a",
        "surf-catalan-b",
        "surf-catalan-c",
        "sphere",
        "torus",
        "surf-nofold-catalan",
      ].sort(),
    );
    const three = rest([], 2, ["2-in-2", "2-on-3", "3-in-3"]);
    expect(cardIds(three)).toEqual(expect.arrayContaining(["poly-catalan", "poly-platonic", "balls", "surf-prisms"]));
    expect(exists(owning([]), "balls")).toBe(false);
    expect(canBuy(owning([]), funds, "balls")).toEqual({ ok: false, reason: "locked" });
  });

  it("show the late cards as ?????? until their prerequisites are owned, and the ladder as it is", () => {
    const dims = ["2-in-2", "2-on-3"] as const;
    const v = shopView(rest([], 1, dims), funds, 8);
    expect(card(v, "surf-prisms")).toMatchObject({ state: "buyable", name: "Prism and antiprism surfaces" });
    expect(card(v, "surf-archimedean")).toMatchObject({ state: "locked", needs: ["Prism and antiprism surfaces"] });
    expect(card(v, "surf-johnson")).toMatchObject({
      state: "locked",
      needs: ["Archimedean surfaces"],
      name: "Johnson surfaces",
    });
    expect(card(v, "surf-catalan-a")).toMatchObject({ state: "locked", needs: ["Johnson surfaces"] });
    for (const id of ["sphere", "torus", "surf-nofold-catalan", "curved"] as const)
      expect(card(v, id)).toMatchObject({ state: "mystery", name: MYSTERY, price: null });
    const w = shopView(
      rest(["surf-prisms", "surf-archimedean", "surf-johnson", "surf-catalan-a", "surf-catalan-b"], 1, dims),
      funds,
      8,
    );
    for (const id of ["sphere", "torus", "surf-nofold-catalan"] as const)
      expect(card(w, id)).toMatchObject({ state: "buyable", needs: [] });
  });

  it("are priced from the cycle's threshold, Curved at 1,500,000,000 in the first cycle", () => {
    const o = (resets: number) => rest([], resets, ["2-in-2", "2-on-3", "3-in-3"]);
    expect(costOf(o(0), "curved")).toBe(1_500_000_000);
    expect(costOf(o(1), "curved")).toBe(0.3 * resetThreshold(1));
    expect(costOf(o(2), "curved")).toBe(0.3 * resetThreshold(2));
    const T1 = resetThreshold(1);
    expect(
      (
        [
          "surf-prisms",
          "surf-archimedean",
          "surf-johnson",
          "surf-catalan-a",
          "surf-catalan-b",
          "surf-catalan-c",
        ] as const
      ).map((id) => costOf(o(1), id)),
    ).toEqual([0.002 * T1, 0.005 * T1, 0.02 * T1, 0.03 * T1, 0.05 * T1, 0.15 * T1]);
    expect((["sphere", "torus", "surf-nofold-catalan"] as const).map((id) => costOf(o(1), id))).toEqual([
      0.3 * T1,
      0.4 * T1,
      0.5 * T1,
    ]);
    const T2 = resetThreshold(2);
    expect(
      (
        [
          "poly-catalan",
          "poly-platonic",
          "poly-prisms",
          "poly-antiprisms",
          "poly-elongated",
          "poly-johnson",
          "poly-duals",
          "balls",
        ] as const
      ).map((id) => costOf(o(2), id)),
    ).toEqual([0.01 * T2, 0.03 * T2, 0.1 * T2, 0.15 * T2, 0.25 * T2, 0.35 * T2, 0.4 * T2, 0.5 * T2]);
    // the card order is the price order, which laterSlice relies on
    const order = SLICES.filter((s) => s.family === "polyhedra" && s.late).map((s) => costOf(o(2), s.id as never));
    expect(order).toEqual([...order].sort((a, b) => a! - b!));
    // Quick study takes its 10 % a level off these prices as off any price in record points
    expect(costOf(o(1), "surf-prisms")).toBe(10_000_000);
    const studied = owning(["study"], { study: 2 }, null, [], [], 1, ["2-in-2", "2-on-3"]);
    expect(costOf(studied, "surf-prisms")).toBe(Math.round(slicePrice("surf-prisms", 1) * 0.81));
    // the card is owned until the reset takes it away
    expect(costOf(rest(["surf-prisms"], 1, ["2-in-2", "2-on-3"]), "surf-prisms")).toBeNull();
  });
});

describe("Tighter Higher rent", () => {
  it("has 5 levels", () => {
    const rentx = UPGRADES.find((u) => u.id === "rentx")!;
    expect(rentx.levels!.max).toBe(5);
    expect(costOf(owning(["rent", "rentx"], { rentx: 5 }), "rentx")).toBeNull();
    expect(costOf(owning(["rent", "rentx"], { rentx: 4 }), "rentx")).toBe(Math.round(480_000 * 1.6 ** 4));
  });
});
