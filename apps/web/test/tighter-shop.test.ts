import { describe, expect, it } from "vitest";
import { AUTO_CLICK_EVALS, DEAL_CLICKS, WIDE } from "../src/tighter/dealer";
import {
  PAIR_BONUS,
  RENT_GROWTH,
  RENT_RECHECK_MS,
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
import { HELD_PER_STANDING, RESET_MIN, standingMultiplier } from "../src/tighter/standing";
import { GREEDY_BUDGET, MAX_NEIGHBOUR_LOOKUPS, TRANSFER_MARGIN } from "../src/tighter/transfer";
import { MYSTERY, shopView } from "../src/tighter/shop";
import {
  AUTO_SLACK_SECONDS,
  COMPACT_EVALS,
  RUN_BUDGET,
  TUNED_DEFAULTS,
  UPGRADES,
  EvolveMethod,
  UpgradeId,
  laneCount,
  lanesMaxed,
  owning,
  rpCostFactor,
} from "../src/tighter/upgrades";

const broke = { rp: 0, standing: 0 };
const card = (v: ReturnType<typeof shopView>, id: UpgradeId) => v.rows.flatMap((r) => r.cards).find((c) => c.id === id);
const row = (v: ReturnType<typeof shopView>, id: string) => v.rows.find((r) => r.id === id)!;

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
    expect(harden.needs).toEqual(["Method: seed"]);
    // a prerequisite that is itself an unrevealed mystery reads ?????? too
    expect(card(v, "morph")!.needs).toEqual([MYSTERY]);
    expect(card(v, "transfer")!.needs).toEqual(["Method: seed", "More open problems"]);
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
    expect(card(w, "harden")!.how).toBe(UPGRADES.find((u) => u.id === "harden")!.how);
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
    const auto: UpgradeId[] = [
      "auto1",
      "auto2",
      "auto3",
      "auto4",
      "auto5",
      "auto6",
      "auto7",
      "auto8",
      "auto9",
      "auto10",
    ];
    const w = shopView(owning([...auto, "autox"], { autox: 10 }), broke, 8);
    expect(row(w, "auto").cards).toEqual([]);
    expect(row(w, "auto").owned).toEqual([
      "Auto-eval",
      "Auto-eval: 150 evaluations a second",
      "Faster auto-eval (level 10, the last)",
    ]);
    expect(w.owned).toBe(11);
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
    expect(u("click3").how.math).toEqual(["<var>k</var> = 3 + <var>a</var> + <var>r</var>"]);
    expect(u("auto1").effect).toBe("Auto-eval runs 1 evaluation a second for you while it is switched on.");
    expect(u("auto3").how.math).toEqual([
      "<var>r</var> = 3",
      "<var>r</var><sub>lane</sub> = <var>r</var> / <var>L</var>",
    ]);
    expect(u("auto2").effect).toBe("Auto-eval runs 2 evaluations a second in all instead of 1.");
    expect(u("auto6").effect).toBe("Auto-eval runs 20 evaluations a second in all instead of 10.");
    expect(u("auto9").name).toBe("Auto-eval: 100 evaluations a second");
    expect(u("auto10").name).toBe("Auto-eval: 150 evaluations a second");
    expect(u("autox").effect).toBe("Each level adds 10 evaluations a second to auto-eval, up to 250 in all.");
    expect(u("autox").how.math).toEqual([
      "<var>r</var> = min(250, 150 + 10 × <var>a</var>)",
      "<var>r</var><sub>lane</sub> = <var>r</var> / <var>L</var>",
    ]);
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
    for (const id of ["auto1", "auto5"] as UpgradeId[])
      expect(text(id)).toContain("whatever your evaluations per click");
    expect(text("click5")).toContain("Auto-eval keeps its own rate in evaluations a second");
    expect(text("clickx")).toContain("Auto-eval keeps its own rate in evaluations a second");
    // the limit, from the measured cost of an evaluation at N+M+P = 85 (1.77 ms), and where 250 a
    // second need more than a core (4 ms an evaluation)
    expect(text("autox")).toContain("so 250 evaluations a second keep about 44.3 % of one core busy there");
    expect(text("autox")).toContain("From about N + M + P = 130 up an evaluation takes 4 ms or more");
    expect(text("autox")).toContain("more lanes spread the work over more cores");
    expect(text("autox")).toContain("so level 10 reaches the limit of 250 a second");
    expect(text("head1")).toContain("Auto-eval at 1 evaluation a second");
    expect(text("head2")).toContain("the Auto-eval upgrades up to 10 evaluations a second");
  });

  it("say that the lanes share auto-eval's rate, and never that each lane runs it", () => {
    for (const u of UPGRADES) expect(all(u).join(" "), u.id).not.toMatch(/in each lane|in every lane|per lane/);
    const text = (id: UpgradeId) => all(UPGRADES.find((u) => u.id === id)!).join(" ");
    for (const id of ["auto1", "auto5", "auto10", "lanes2", "lanesx"] as UpgradeId[])
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
    expect(text("collector")).toContain("A collection here is a shape pair");
  });

  // The texts are written in numbers; these are the game's constants they quote.
  it("quote the game's own constants", () => {
    const text = (id: UpgradeId) => all(UPGRADES.find((u) => u.id === id)!).join(" ");
    expect([DEAL_CLICKS, AUTO_CLICK_EVALS]).toEqual([300, 10]);
    expect(text("queue3")).toContain("<var>q</var> × <var>c</var> / 300");
    expect([COMPACT_EVALS, RUN_BUDGET, AUTO_SLACK_SECONDS]).toEqual([100, 100_000, 60]);
    expect(text("advance")).toContain("100 evaluations of mc_compress");
    expect(text("shrink")).toContain("A run ends by itself after 1,000 evaluations without progress.");
    expect(text("auto2")).toContain("60 s");
    expect([RENT_SHARE, RENT_GROWTH, RENT_WINDOW_MS / 3_600_000, RENT_RECHECK_MS / 60_000]).toEqual([
      0.01, 1.5, 168, 10,
    ]);
    expect(text("rent")).toContain("0.01 × <var>B</var> × 1.5<sup>");
    expect(text("rent")).toContain("10 minutes");
    expect(CONTEST).toEqual({ open: 1, loose: 3, batch: 10, published: 100 });
    expect([room("open", null), room("loose", 1), room("batch", null), room("published", null)]).toEqual([
      1, 1, 0.1, 0.004,
    ]);
    expect(room("loose", 0.01)).toBeCloseTo(0.3 + 25 * 0.01, 12);
    expect([RP_PER_EVAL, LOOSE_WEAKNESS, NEIGHBOURS, msPerEval(85)]).toEqual([0.5, 0.005, 3, 1.77]);
    expect(text("rank2")).toContain("× 0.5 ×");
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
    expect([RESET_MIN, HELD_PER_STANDING]).toEqual([250_000, 50]);
    expect(standingMultiplier({ total: 1 } as Parameters<typeof standingMultiplier>[0])).toBeCloseTo(1.1, 12);
    expect(text("standing")).toContain("250,000");
    expect(rpCostFactor(owning(["study"], { study: 2 }))).toBeCloseTo(0.81, 12);
  });
});
