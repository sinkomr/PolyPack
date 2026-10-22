import { How, howDisclosure, renderHow } from "./how";
import {
  CardState,
  Currency,
  Funds,
  Owned,
  ROWS,
  Row,
  UPGRADES,
  Upgrade,
  UpgradeId,
  cardState,
  cores,
  costOf,
  currencyOf,
  isRevealed,
  laneCount,
  lanesMaxed,
  level,
  upgrade,
} from "./upgrades";

/**
 * The shop: the whole tech tree, row by row. Owned upgrades fold into one line per row; the rest
 * show as cards, buyable or not yet. A mystery upgrade shows as ?????? (its name, its effect, its
 * explanation and its price) until every prerequisite is owned; its card still says what it needs,
 * a prerequisite that is itself an unrevealed mystery reading ?????? too. The Standing row (paid in
 * standing) shows only once Standing is owned.
 *
 * `shopView` and `treeView` are pure (the tests read them); `TreeRenderer` draws the tree in its
 * own pane, as columns of upgrades with lines from each prerequisite (the tech-tree concept,
 * PolyPack-ideas/idle-games/tighter/techtree.html), building the DOM once per layout and updating
 * states, prices and progress in place, so it can run every second and on every click.
 */

export const MYSTERY = "??????";

export interface CardView {
  id: UpgradeId;
  /** Never "owned": owned upgrades fold into the row's line (a levelled one with levels left stays a card). */
  state: Exclude<CardState, "owned">;
  name: string;
  /** What it does, in a sentence; ?????? for a mystery. */
  effect: string;
  /** What exactly happens (How it works); null for a mystery. */
  how: How | null;
  /** The price of the upgrade or of its next level; null for a mystery. */
  cost: number | null;
  currency: Currency;
  /** "1,000 RP", "3 standing", "next level 2,500 RP"; null for a mystery. */
  price: string | null;
  /** Prerequisites not owned yet, by name (?????? for an unrevealed mystery). */
  needs: string[];
  /** Levels owned of a levelled upgrade, and its last level (null: not levelled). */
  level: number;
  max: number | null;
  /** A line on levels, for a levelled upgrade ("Level 2 of 3"). */
  levelText: string | null;
  /** The Buy button's accessible name. */
  label: string;
}

export interface RowView {
  id: Row;
  title: string;
  /** Owned upgrades of the row, by name (with their level where they have one). */
  owned: string[];
  cards: CardView[];
  /** Upgrades in the row, and those owned (a levelled one counts once it has a level). */
  total: number;
  ownedCount: number;
}

export interface ShopView {
  rows: RowView[];
  total: number;
  owned: number;
  /** Cards still shown as ??????. */
  mysteries: number;
}

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

export function priceText(cost: number, currency: Currency): string {
  return currency === "rp" ? `${fmtInt(cost)} RP` : `${fmtInt(cost)} standing`;
}

/**
 * The owned line, with each ladder folded to where it stands: "2 to 10 evaluations per click",
 * "Seeds: up to 8 per problem", the fastest auto-eval owned.
 */
export function foldOwned(names: readonly string[]): string[] {
  const out: string[] = [];
  const slot = new Map<string, number>();
  const put = (key: string, text: string) => {
    const i = slot.get(key);
    if (i === undefined) {
      slot.set(key, out.length);
      out.push(text);
    } else out[i] = text;
  };
  let clickLow = Infinity;
  for (const n of names) {
    let m: RegExpExecArray | null;
    if ((m = /^(\d+) evaluations per click$/.exec(n))) {
      const k = Number(m[1]);
      clickLow = Math.min(clickLow, k);
      put("click", clickLow === k ? n : `${clickLow} to ${k} evaluations per click`);
    } else if ((m = /^Seeds: (\d+) per problem$/.exec(n)))
      put("seeds", m[1] === "2" ? n : `Seeds: up to ${m[1]} per problem`);
    else if (/^Auto-eval: /.test(n)) put("auto", n);
    else if (/^Problem queue: /.test(n)) put("queue", n);
    else out.push(n);
  }
  return out;
}

/** How a card sorts in its row: what can be worked toward first, then the locked, then the mysteries. */
const ORDER: Record<CardView["state"], number> = { buyable: 0, dear: 0, locked: 1, mystery: 2 };

function shownName(o: Owned, id: UpgradeId): string {
  return isRevealed(o, id) ? upgrade(id).name : MYSTERY;
}

function ownedName(o: Owned, u: Upgrade, coreCount: number): string {
  if (!u.levels) return u.name;
  const l = level(o, u.id);
  if (u.id === "lanesx" && lanesMaxed(o, coreCount)) return `${u.name} (level ${l}, every core)`;
  return `${u.name} (level ${l}${l >= u.levels.max ? ", the last" : ""})`;
}

function levelLine(o: Owned, u: Upgrade, coreCount: number): string | null {
  if (!u.levels) return null;
  const l = level(o, u.id);
  if (u.id === "lanesx") {
    const lanes = laneCount(o, coreCount);
    return `Level ${l} · ${lanes} lanes; this CPU runs at most ${Math.max(2, coreCount - 1)}`;
  }
  return u.levels.max >= 100 ? `Level ${l}` : `Level ${l} of ${u.levels.max}`;
}

export function card(o: Owned, u: Upgrade, state: CardView["state"], coreCount: number): CardView {
  const needs = u.requires.filter((r) => !o.has(r)).map((r) => shownName(o, r));
  const currency = currencyOf(u);
  const l = level(o, u.id);
  const max = u.levels?.max ?? null;
  if (state === "mystery") {
    return {
      id: u.id,
      state,
      name: MYSTERY,
      effect: MYSTERY,
      how: null,
      cost: null,
      currency,
      price: null,
      needs,
      level: 0,
      max: null,
      levelText: null,
      label: `A mystery upgrade: needs ${needs.join(", ")}`,
    };
  }
  const cost = costOf(o, u.id)!;
  const price = priceText(cost, currency);
  const unit = currency === "rp" ? "record points" : "standing";
  const what = u.levels && l > 0 ? `${u.name} level ${l + 1}` : u.name;
  return {
    id: u.id,
    state,
    name: u.name,
    effect: u.effect,
    how: u.how,
    cost,
    currency,
    price: u.levels && l > 0 ? `next level ${price}` : price,
    needs,
    level: l,
    max,
    levelText: u.levels && l > 0 ? levelLine(o, u, coreCount) : null,
    label: state === "locked" ? `${what}: needs ${needs.join(", ")}` : `Buy ${what} for ${cost} ${unit}`,
  };
}

/** The shop as rows of owned names and cards. */
export function shopView(o: Owned, funds: Funds, coreCount = cores()): ShopView {
  const rows: RowView[] = [];
  let total = 0;
  let ownedTotal = 0;
  let mysteries = 0;
  for (const { id: row, title } of ROWS) {
    // standing is paid in standing: its row shows once Standing is owned
    if (row === "standing" && !o.has("standing")) continue;
    const list = UPGRADES.filter((u) => u.row === row);
    const owned: string[] = [];
    const cards: CardView[] = [];
    let ownedCount = 0;
    for (const u of list) {
      const has = o.has(u.id);
      if (has) ownedCount++;
      // Another lane stops paying once every core has a lane
      const done = u.id === "lanesx" ? lanesMaxed(o, coreCount) : false;
      if (done && !has) {
        owned.push(`${u.name}: no core left for one on this CPU`);
        continue;
      }
      const state = done ? "owned" : cardState(o, funds, u.id);
      if (state === "owned") {
        owned.push(ownedName(o, u, coreCount));
        continue;
      }
      if (has) owned.push(ownedName(o, u, coreCount));
      if (state === "mystery") mysteries++;
      cards.push(card(o, u, state, coreCount));
    }
    cards.sort((a, b) => ORDER[a.state] - ORDER[b.state]);
    // a levelled upgrade with levels left is both owned (it has levels) and a card (the next one)
    rows.push({
      id: row,
      title,
      owned: foldOwned(owned.filter((n, i) => owned.indexOf(n) === i)),
      cards,
      total: list.length,
      ownedCount,
    });
    total += list.length;
    ownedTotal += ownedCount;
  }
  return { rows, total, owned: ownedTotal, mysteries };
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, textContent?: string) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (textContent !== undefined) e.textContent = textContent;
  return e;
};

/** A short label for a chip ("2 evaluations per click" → "2 a click"); the full name is in its details. */
export function chipName(name: string): string {
  return name
    .replace(/^(\d+) evaluations per click$/, "$1 a click")
    .replace(/^Auto-eval: ([\d,.]+) evaluations? a second$/, "Auto: $1/s")
    .replace(/^Seeds: (\d+) per problem$/, "Seeds: $1")
    .replace(/^Problem queue: /, "Queue: ")
    .replace(/^Problem sets: N\+M\+P ≥ /, "Size ≥ ")
    .replace(/^Problem sets: every size$/, "Every size")
    .replace(/^Method: /, "")
    .replace(/^Dealer: /, "")
    .replace(/^Reach: /, "");
}

// ---------- the tree ----------

/** One upgrade in the tree: a card's view, or an owned upgrade. */
export interface NodeView extends Omit<CardView, "state"> {
  state: CardState;
  row: Row;
  /** Its column: the longest chain of prerequisites before it. */
  depth: number;
}

export interface TreeView {
  rows: { id: Row; title: string }[];
  nodes: NodeView[];
  total: number;
  owned: number;
  mysteries: number;
  /** Upgrades that can be bought now. */
  buyable: number;
  /** The cheapest upgrade in record points whose prerequisites are owned but that is not affordable yet. */
  next: NodeView | null;
}

const DEPTH = new Map<UpgradeId, number>();
for (const u of UPGRADES)
  DEPTH.set(u.id, u.requires.length ? 1 + Math.max(...u.requires.map((r) => DEPTH.get(r) ?? 0)) : 0);

/** The tree's view: every upgrade, owned ones included, with its state; the Standing row once Standing is owned. */
export function treeView(o: Owned, funds: Funds, coreCount = cores()): TreeView {
  const nodes: NodeView[] = [];
  let owned = 0;
  let mysteries = 0;
  const rows = ROWS.filter((r) => r.id !== "standing" || o.has("standing"));
  for (const { id: row } of rows)
    for (const u of UPGRADES.filter((x) => x.row === row)) {
      const done = u.id === "lanesx" && lanesMaxed(o, coreCount);
      const state: CardState = done ? "owned" : cardState(o, funds, u.id);
      const depth = DEPTH.get(u.id) ?? 0;
      if (o.has(u.id)) owned++;
      if (state === "mystery") mysteries++;
      if (state === "owned") {
        const name = done && !o.has(u.id) ? `${u.name}: no core left on this CPU` : ownedName(o, u, coreCount);
        nodes.push({
          ...card(o, u, "locked", coreCount),
          state,
          row,
          depth,
          name: u.name,
          price: null,
          cost: null,
          needs: [],
          levelText: u.levels ? levelLine(o, u, coreCount) : null,
          label: `${name}: owned`,
        });
        continue;
      }
      nodes.push({ ...card(o, u, state, coreCount), state, row, depth });
    }
  const buyable = nodes.filter((n) => n.state === "buyable").length;
  const dear = nodes.filter((n) => n.state === "dear" && n.currency === "rp" && n.cost !== null);
  dear.sort((a, b) => a.cost! - b.cost!);
  return {
    rows,
    nodes,
    total: nodes.length,
    owned,
    mysteries,
    buyable,
    next: dear[0] ?? null,
  };
}

/** Sizes of the tree's layout, in CSS pixels. */
export const TREE = { nodeW: 136, nodeH: 62, colGap: 26, subGap: 8, label: 22, pad: 10, left: 12 };

/**
 * The phone layout (tighter.css, "phones"): there the tree is a list, row after row, in the order of
 * the columns, instead of a canvas some 3,300 px wide.
 */
export const PHONE_QUERY =
  "(max-width: 759px), (max-height: 500px) and (orientation: landscape) and (max-width: 1023px)";

/**
 * The nodes of one row in reading order: what is not owned yet first, by column (prerequisites
 * first) then by price, and the owned ones after. The order changes only when something is bought,
 * never as points come in, so a node does not move under a tapping finger.
 */
export function listOrder(nodes: readonly NodeView[]): NodeView[] {
  const owned = (n: NodeView) => (n.state === "owned" ? 1 : 0);
  return [...nodes].sort((a, b) => owned(a) - owned(b) || a.depth - b.depth || upgrade(a.id).cost - upgrade(b.id).cost);
}

export interface TreeLayout {
  width: number;
  height: number;
  /** Each node's top-left corner. */
  at: Map<UpgradeId, { x: number; y: number }>;
  /** Each row's band. */
  bands: { id: Row; title: string; y: number; h: number }[];
}

/**
 * Where each node goes: its column by depth (every prerequisite is to its left), its band by row,
 * nodes of one row and column stacked in the order of their price.
 */
export function treeLayout(rows: readonly { id: Row; title: string }[], nodes: readonly NodeView[]): TreeLayout {
  const at = new Map<UpgradeId, { x: number; y: number }>();
  const bands: TreeLayout["bands"] = [];
  let y = 0;
  let maxDepth = 0;
  for (const r of rows) {
    const list = nodes.filter((n) => n.row === r.id);
    const byDepth = new Map<number, NodeView[]>();
    for (const n of list) byDepth.set(n.depth, [...(byDepth.get(n.depth) ?? []), n]);
    let stack = 1;
    for (const [d, group] of byDepth) {
      maxDepth = Math.max(maxDepth, d);
      stack = Math.max(stack, group.length);
      group
        .sort((a, b) => upgrade(a.id).cost - upgrade(b.id).cost)
        .forEach((n, k) =>
          at.set(n.id, {
            x: TREE.left + d * (TREE.nodeW + TREE.colGap),
            y: y + TREE.label + k * (TREE.nodeH + TREE.subGap),
          }),
        );
    }
    const h = TREE.label + stack * (TREE.nodeH + TREE.subGap) + TREE.pad;
    bands.push({ id: r.id, title: r.title, y, h });
    y += h;
  }
  return { width: TREE.left * 2 + (maxDepth + 1) * (TREE.nodeW + TREE.colGap) - TREE.colGap, height: y, at, bands };
}

/** The line a node's state draws: what the bar under it shows, and its button's word. */
function nodeAct(n: NodeView, touch: boolean): string {
  if (n.state === "buyable") return touch ? "Details" : "Buy";
  return "Details";
}

/** A node's price or standing, as its details say it: "1,000 RP · needs Trace detail." */
function statusText(n: NodeView): string {
  if (n.state === "owned") return `Owned${n.levelText ? ` · ${n.levelText}` : ""}.`;
  if (n.state === "mystery") return `Needs ${n.needs.join(", ")}.`;
  if (n.state === "locked") return `${n.price} · needs ${n.needs.join(", ")}.`;
  return `${n.price}${n.levelText ? ` · ${n.levelText}` : ""}${n.state === "dear" ? " · saving up" : ""}.`;
}

/** The id of the floating explanation, which the node it explains names as its description. */
const TIP_ID = "t-tree-tip";

/** Whether the element's focus shows as the keyboard's (false where the browser cannot tell). */
function focusVisible(e: Element): boolean {
  try {
    return e.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * The tech tree on the page. A node is a card with one button: on a device with a pointer that
 * hovers, pressing a node you can afford buys it, and hovering or focusing any node shows a card
 * beside it with its details and explanation (a mystery's card says only what it needs). On a touch
 * screen, and in the phone's list, a tap shows the details below the tree instead, which hold the
 * Buy button and the explanation behind "How it works"; the list's upgrades also show their effect
 * and "How it works" themselves. A mystery shows no explanation.
 *
 * Nothing that shows on hover moves a node: the card is fixed to the window, placed clear of the
 * node and transparent to the pointer, so it takes no click, and the details below the tree (where
 * they show) have a fixed height.
 */
export class TreeRenderer {
  private layoutSig = "";
  private nodes = new Map<UpgradeId, HTMLElement>();
  private edges: { from: UpgradeId; to: UpgradeId; path: SVGPathElement }[] = [];
  private view: TreeView | null = null;
  private funds: Funds = { rp: 0, standing: 0 };
  /** The node whose details are shown (pressed, or under the pointer or focus). */
  private selected: UpgradeId | null = null;
  private pointed: UpgradeId | null = null;
  private focused: UpgradeId | null = null;
  /** The focus came from the keyboard (a click focuses a button too, and then the card follows the pointer). */
  private keyboardFocus = false;
  private detailSig = "";
  private detailId: UpgradeId | null = null;
  /** The explanation beside the node under the pointer or focus (the canvas, with a pointer that hovers). */
  private readonly tip: HTMLElement;
  private tipSig = "";
  private tipFor: UpgradeId | null = null;
  private readonly touch: boolean;
  /** A list instead of the canvas: the phone layout. */
  private list: boolean;

  constructor(
    private readonly box: HTMLElement,
    private readonly summary: HTMLElement,
    private readonly detail: HTMLElement,
    private readonly onBuy: (id: UpgradeId) => void,
    /** Whether the upgrade can be bought this moment (the view may be a second old). */
    private readonly canBuyNow: (id: UpgradeId) => boolean,
  ) {
    this.touch = typeof matchMedia === "function" && matchMedia("(hover: none)").matches;
    const phone = typeof matchMedia === "function" ? matchMedia(PHONE_QUERY) : null;
    this.list = !!phone?.matches;
    this.showDetail();
    phone?.addEventListener("change", () => {
      this.list = phone.matches;
      this.showDetail();
      this.layoutSig = "";
      if (this.view) this.render(this.view, this.funds);
    });
    // in the tree's pane, so it hides with it
    this.tip = el("div", "t-tree-tip");
    this.tip.id = TIP_ID;
    this.tip.setAttribute("role", "tooltip");
    this.tip.hidden = true;
    (box.parentElement ?? box).append(this.tip);
    box.addEventListener("scroll", () => this.placeTip(), { passive: true });
    addEventListener("resize", () => this.placeTip());
  }

  render(view: TreeView, funds: Funds): void {
    this.view = view;
    this.funds = funds;
    const summary =
      `${fmtInt(view.owned)} of ${fmtInt(view.total)} upgrades owned` +
      (view.mysteries ? ` · ${fmtInt(view.mysteries)} still ${MYSTERY}` : "") +
      (view.buyable ? ` · ${fmtInt(view.buyable)} to buy now` : "");
    if (this.summary.textContent !== summary) this.summary.textContent = summary;
    // the list's order depends on what is owned (the canvas's does not)
    const owned = this.list ? view.nodes.filter((n) => n.state === "owned").map((n) => n.id) : [];
    const sig = `${this.list ? "list" : "tree"}|${view.nodes.map((n) => n.id).join(",")}|${owned.join(",")}`;
    if (sig !== this.layoutSig) {
      this.layoutSig = sig;
      // new buttons: the tip names itself on the new one
      this.tipSig = "";
      if (this.list) this.buildList(view);
      else this.build(view);
    }
    for (const n of view.nodes) this.update(n);
    const byId = new Map(view.nodes.map((n) => [n.id, n] as const));
    for (const e of this.edges) {
      const to = byId.get(e.to);
      const from = byId.get(e.from);
      const cls = `t-edge${from?.state === "owned" ? " on" : ""}${to?.state === "mystery" ? " mystery" : ""}`;
      if (e.path.getAttribute("class") !== cls) e.path.setAttribute("class", cls);
    }
    this.renderDetail();
  }

  /** The first column worth looking at: the leftmost node that can be bought or saved toward. */
  scrollToFrontier(): void {
    const v = this.view;
    if (!v) return;
    const open = v.nodes.filter((n) => n.state === "buyable" || n.state === "dear");
    if (this.list) {
      // the first row with something to buy or save for, from its top
      const row = v.rows.find((r) => open.some((n) => n.row === r.id));
      const band = row ? this.box.querySelector<HTMLElement>(`.t-list-row[data-row="${row.id}"]`) : null;
      this.box.scrollTop = band ? Math.max(0, band.offsetTop - this.box.offsetTop - 4) : 0;
      return;
    }
    const first = open.length ? Math.min(...open.map((n) => n.depth)) : 0;
    this.box.scrollLeft = Math.max(0, (first - 1) * (TREE.nodeW + TREE.colGap));
  }

  /** The phone's tree: each row's upgrades as a list of the same nodes, without the lines. */
  private buildList(view: TreeView): void {
    // explanations left open stay open when the list is built again (after a purchase)
    const open = new Set(
      Array.from(this.box.querySelectorAll(".t-list-how[open]"), (d) => d.closest<HTMLElement>(".t-node")?.dataset.id),
    );
    const list = el("div", "t-tree-list");
    this.edges = [];
    this.nodes.clear();
    for (const r of view.rows) {
      const nodes = listOrder(view.nodes.filter((n) => n.row === r.id));
      if (!nodes.length) continue;
      const row = el("section", "t-list-row");
      row.dataset.row = r.id;
      row.setAttribute("aria-label", r.title);
      const grid = el("div", "t-list-nodes");
      for (const n of nodes) {
        const node = this.node(n);
        const how = node.querySelector<HTMLDetailsElement>(".t-list-how");
        if (how && open.has(n.id)) how.open = true;
        grid.append(node);
      }
      row.append(el("h3", "t-list-title", r.title), grid);
      list.append(row);
    }
    const focused = document.activeElement?.closest<HTMLElement>(".t-node")?.dataset.id;
    this.box.replaceChildren(list);
    if (focused)
      this.nodes
        .get(focused as UpgradeId)
        ?.querySelector("button")
        ?.focus();
  }

  /** One node: a card with one button over it (placed by the caller). */
  private node(n: NodeView): HTMLElement {
    const node = el("div", "t-node t-card");
    node.dataset.id = n.id;
    const name = el("h3", "t-node-name");
    const foot = el("p", "t-node-foot");
    foot.append(el("span", "t-node-price"), el("span", "t-level"));
    const bar = el("span", "t-node-bar");
    const btn = el("button", "t-node-act");
    btn.type = "button";
    btn.addEventListener("click", () => this.press(n.id));
    btn.addEventListener("focus", () => {
      this.keyboardFocus = focusVisible(btn);
      this.hover("focused", n.id);
    });
    btn.addEventListener("blur", () => this.hover("focused", null));
    // On a touch screen a tap selects, and hovering is left out: iOS takes a first tap on an element
    // whose mouseenter changes the page for a hover and sends no click, and the emulated mouseleave
    // of the next tap (on Buy, below) would take the details away under the finger.
    if (!this.touch) {
      node.addEventListener("mouseenter", () => this.hover("pointed", n.id));
      node.addEventListener("mouseleave", () => this.hover("pointed", null));
    }
    node.append(name, foot, bar, btn);
    this.nodes.set(n.id, node);
    this.explain(node, n);
    return node;
  }

  /**
   * In the phone's list: the upgrade's effect under its name, the button's description, and its
   * explanation behind "How it works" (none for a mystery, and none on the canvas).
   */
  private explain(node: HTMLElement, n: NodeView): void {
    const want = this.list && n.state !== "mystery" && !!n.how;
    if (want === (node.dataset.how === "1")) return;
    node.querySelectorAll(".t-list-effect, .t-list-how").forEach((e) => e.remove());
    const btn = node.querySelector("button")!;
    btn.removeAttribute("aria-describedby");
    delete node.dataset.how;
    if (!want) return;
    const effect = el("p", "t-list-effect", n.effect);
    effect.id = `t-effect-${n.id}`;
    const how = howDisclosure(n.how!);
    how.classList.add("t-list-how");
    node.append(effect, how);
    btn.setAttribute("aria-describedby", effect.id);
    node.dataset.how = "1";
  }

  private build(view: TreeView): void {
    const layout = treeLayout(view.rows, view.nodes);
    const canvas = el("div", "t-tree-canvas");
    canvas.style.width = `${layout.width}px`;
    canvas.style.height = `${layout.height}px`;
    for (const b of layout.bands) {
      const band = el("div", "t-band");
      band.dataset.row = b.id;
      band.style.top = `${b.y}px`;
      band.style.height = `${b.h}px`;
      band.append(el("span", "t-band-title", b.title));
      canvas.append(band);
    }
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "t-edges");
    svg.setAttribute("width", String(layout.width));
    svg.setAttribute("height", String(layout.height));
    svg.setAttribute("aria-hidden", "true");
    this.edges = [];
    for (const n of view.nodes) {
      const to = layout.at.get(n.id)!;
      for (const r of upgrade(n.id).requires) {
        const from = layout.at.get(r);
        if (!from) continue;
        const x1 = from.x + TREE.nodeW,
          y1 = from.y + TREE.nodeH / 2,
          x2 = to.x,
          y2 = to.y + TREE.nodeH / 2;
        const dx = Math.max(10, (x2 - x1) / 2);
        const path = document.createElementNS(NS, "path");
        path.setAttribute("d", `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
        path.setAttribute("class", "t-edge");
        svg.append(path);
        this.edges.push({ from: r, to: n.id, path });
      }
    }
    canvas.append(svg);
    this.nodes.clear();
    for (const n of view.nodes) {
      const pos = layout.at.get(n.id)!;
      const node = this.node(n);
      node.style.left = `${pos.x}px`;
      node.style.top = `${pos.y}px`;
      canvas.append(node);
    }
    const focused = document.activeElement?.closest<HTMLElement>(".t-node")?.dataset.id;
    this.box.replaceChildren(canvas);
    if (focused)
      this.nodes
        .get(focused as UpgradeId)
        ?.querySelector("button")
        ?.focus();
  }

  private update(n: NodeView): void {
    const node = this.nodes.get(n.id);
    if (!node) return;
    if (node.dataset.state !== n.state) node.dataset.state = n.state;
    const set = (sel: string, value: string) => {
      const e = node.querySelector(sel)!;
      if (e.textContent !== value) e.textContent = value;
    };
    set(".t-node-name", n.state === "mystery" ? MYSTERY : n.state === "owned" ? n.name : chipName(n.name));
    set(
      ".t-node-price",
      n.state === "owned" ? "✓ owned" : n.state === "mystery" ? MYSTERY : n.price!.replace(/^next level /, "next "),
    );
    set(".t-level", n.levelText ? (n.max && n.max < 100 ? `${n.level}/${n.max}` : `L${n.level}`) : "");
    const have = n.currency === "rp" ? this.funds.rp : this.funds.standing;
    const p = n.cost ? Math.max(0, Math.min(1, have / n.cost)) : n.state === "owned" ? 1 : 0;
    const bar = node.querySelector<HTMLElement>(".t-node-bar")!;
    const width = `${(p * 100).toFixed(1)}%`;
    if (bar.style.width !== width) bar.style.width = width;
    const btn = node.querySelector("button")!;
    const word = nodeAct(n, this.touch);
    if (btn.textContent !== word) btn.textContent = word;
    const label = n.state === "buyable" && !this.touch ? n.label : `${n.label}; details`;
    if (btn.getAttribute("aria-label") !== label) btn.setAttribute("aria-label", label);
    const sel = this.selected === n.id ? "true" : "false";
    if (btn.getAttribute("aria-expanded") !== sel) btn.setAttribute("aria-expanded", sel);
    // a mystery revealed without a new layout
    this.explain(node, n);
  }

  private press(id: UpgradeId): void {
    const n = this.view?.nodes.find((x) => x.id === id);
    if (!n) return;
    if (!this.touch && this.canBuyNow(id)) {
      this.onBuy(id);
      return;
    }
    this.selected = this.selected === id ? null : id;
    if (this.view) this.render(this.view, this.funds);
  }

  private hover(by: "pointed" | "focused", id: UpgradeId | null): void {
    if (this[by] === id) return;
    this[by] = id;
    this.renderDetail();
  }

  /** The details below the tree are for taps: with a pointer that hovers, the card beside the node holds them. */
  private showDetail(): void {
    this.detail.hidden = !this.touch && !this.list;
  }

  /** The details of the node under the pointer or focus, or else of the one pressed. */
  private renderDetail(): void {
    this.renderTip();
    const id = this.pointed ?? this.focused ?? this.selected;
    const n = id ? this.view?.nodes.find((x) => x.id === id) : undefined;
    const sig = n ? `${n.id}|${n.state}|${n.price}|${n.levelText}|${n.name}|${this.selected}` : "";
    if (sig === this.detailSig) {
      const buy = this.detail.querySelector<HTMLButtonElement>(".t-detail-buy");
      if (buy && n) buy.disabled = n.state !== "buyable";
      return;
    }
    this.detailSig = sig;
    // an explanation opened on a touch screen stays open while the same upgrade's details change
    const wasOpen = !!this.detail.querySelector<HTMLDetailsElement>(".t-detail-how")?.open && this.detailId === id;
    this.detailId = n ? n.id : null;
    if (!n) {
      this.detail.replaceChildren(
        el(
          "p",
          "note",
          this.touch
            ? "Tap an upgrade for its details."
            : "Point at an upgrade to see what it does. Press one you can afford to buy it.",
        ),
      );
      return;
    }
    const parts: HTMLElement[] = [
      el("h3", undefined, n.state === "mystery" ? MYSTERY : n.name),
      el("p", "t-detail-status", statusText(n)),
    ];
    if (n.state !== "mystery") parts.push(el("p", "t-detail-effect", n.effect));
    if (n.state === "buyable" || n.state === "dear") {
      const buy = el("button", "t-detail-buy primary", `Buy for ${n.price!.replace(/^next level /, "")}`);
      buy.type = "button";
      buy.disabled = n.state !== "buyable";
      buy.setAttribute("aria-label", n.label);
      buy.addEventListener("click", () => this.onBuy(n.id));
      parts.push(buy);
    }
    // with no hover there is no card beside the node: the explanation is here (the list has its own)
    if (this.touch && !this.list && n.state !== "mystery" && n.how) {
      const how = howDisclosure(n.how);
      how.classList.add("t-detail-how");
      how.open = wasOpen;
      parts.push(how);
    }
    this.detail.replaceChildren(...parts);
  }

  /**
   * The card beside the node under the pointer or focus, on the canvas with a pointer that hovers:
   * its name, price or standing, effect and explanation, or for a mystery only what it needs. The
   * node's button names it as its description while it shows.
   */
  private renderTip(): void {
    const id = this.touch || this.list ? null : (this.pointed ?? (this.keyboardFocus ? this.focused : null));
    const n = id ? this.view?.nodes.find((x) => x.id === id) : undefined;
    const sig = n ? `${n.id}|${n.state}|${n.price}|${n.levelText}|${n.needs.join()}` : "";
    if (sig !== this.tipSig) {
      this.tipSig = sig;
      this.box.querySelectorAll(`[aria-describedby="${TIP_ID}"]`).forEach((b) => b.removeAttribute("aria-describedby"));
      this.tipFor = n ? n.id : null;
      if (!n) {
        this.tip.hidden = true;
        this.tip.replaceChildren();
        return;
      }
      const mystery = n.state === "mystery";
      this.tip.replaceChildren(
        el("p", "t-tree-tip-name", mystery ? MYSTERY : n.name),
        el("p", "t-detail-status", statusText(n)),
        ...(mystery ? [] : [el("p", "t-tree-tip-effect", n.effect)]),
        ...(!mystery && n.how ? [renderHow(n.how)] : []),
      );
      this.tip.hidden = false;
      this.nodes.get(n.id)?.querySelector("button")?.setAttribute("aria-describedby", TIP_ID);
    }
    this.placeTip();
  }

  /**
   * The card to the right of its node, or to the left where the window has more room there; never
   * over it. As narrow as reads well, and wider where a long explanation would not fit the window's
   * height.
   */
  private placeTip(): void {
    const node = this.tipFor ? this.nodes.get(this.tipFor) : undefined;
    if (!node || this.tip.hidden) return;
    const r = node.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const gap = 10;
    const margin = 8;
    const right = vw - r.right - gap - margin;
    const left = r.left - gap - margin;
    const room = Math.max(0, right, left);
    const fit = (w: number) => {
      const px = `${Math.round(w)}px`;
      if (this.tip.style.width !== px) this.tip.style.width = px;
      return Math.round(w);
    };
    let width = fit(Math.min(420, room));
    if (this.tip.scrollHeight > this.tip.clientHeight + 1 && room > width) width = fit(Math.min(640, room));
    const x = right >= width ? r.right + gap : r.left - gap - width;
    const y = Math.max(margin, Math.min(r.top, vh - margin - this.tip.offsetHeight));
    this.tip.style.left = `${Math.round(x)}px`;
    this.tip.style.top = `${Math.round(y)}px`;
  }
}
