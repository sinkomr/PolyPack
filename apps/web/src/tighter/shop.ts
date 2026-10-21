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
 * show as cards, buyable or not yet. A mystery upgrade shows as ?????? (its name, its effect and its
 * price) until every prerequisite is owned; its card still says what it needs, a prerequisite that
 * is itself an unrevealed mystery reading ?????? too. The Standing row (paid in standing) shows only
 * once Standing is owned.
 *
 * `shopView` is pure (the tests read it); `ShopRenderer` puts it on the page and rebuilds the DOM
 * only when the view's shape changes, so it can run every second and on every click.
 */

export const MYSTERY = "??????";

export interface CardView {
  id: UpgradeId;
  /** Never "owned": owned upgrades fold into the row's line (a levelled one with levels left stays a card). */
  state: Exclude<CardState, "owned">;
  name: string;
  /** What it does and the real feature behind it; ?????? for a mystery. */
  effect: string;
  real: string | null;
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
 * "Seeds: up to 8 per problem", the fastest auto-eval and the longest away owned.
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
    else if (/^Away: /.test(n)) put("away", n);
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

function card(o: Owned, u: Upgrade, state: CardView["state"], coreCount: number): CardView {
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
      real: null,
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
    real: u.real,
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

// ---------- on the page ----------

/** A card whose prerequisites are owned: shown in full, with its progress and Buy button. */
const reachable = (c: CardView) => c.state === "buyable" || c.state === "dear";

/** The DOM shape of the view: rebuilt only when it changes (prices reached or not only enable buttons). */
function signature(v: ShopView, selected: ReadonlyMap<Row, UpgradeId>): string {
  return v.rows
    .map(
      (r) =>
        `${r.id}:${selected.get(r.id) ?? ""}:${r.owned.join(",")}|${r.cards
          .map((c) => `${c.id}.${c.state === "buyable" ? "dear" : c.state}.${c.cost}.${c.level}.${c.levelText}`)
          .join(",")}`,
    )
    .join(";");
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, textContent?: string) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (textContent !== undefined) e.textContent = textContent;
  return e;
};

const sentence = (t: string) => `${t[0].toUpperCase()}${t.slice(1)}.`;

/** A short label for a chip ("2 evaluations per click" → "2 a click"); the full name is in its details. */
export function chipName(name: string): string {
  return name
    .replace(/^(\d+) evaluations per click$/, "$1 a click")
    .replace(/^Auto-eval: every (\d+) s$/, "Auto: $1 s")
    .replace(/^Auto-eval: (\d+) a second$/, "Auto: $1/s")
    .replace(/^Seeds: (\d+) per problem$/, "Seeds: $1")
    .replace(/^Problem queue: /, "Queue: ")
    .replace(/^Problem sets: N\+M\+P ≥ /, "Size ≥ ")
    .replace(/^Problem sets: every size$/, "Every size")
    .replace(/^Method: /, "")
    .replace(/^Dealer: /, "")
    .replace(/^Reach: /, "");
}

/** A price as a chip shows it: the number, its unit in the details. */
const chipPrice = (c: CardView) => (c.cost === null ? null : fmtInt(c.cost));

/**
 * The shop on the page. Per row: the owned line, the cards that can be worked toward in full, and the
 * rest of the row (locked upgrades and mysteries) as compact chips; a chip pressed shows its details
 * under the row, so the whole tree stays in view without burying the other panels.
 */
export class ShopRenderer {
  private sig = "";
  /** Rows the player folded or unfolded (kept while the page is open). */
  private open = new Map<Row, boolean>();
  /** The chip whose details are shown, per row. */
  private selected = new Map<Row, UpgradeId>();
  private view: ShopView | null = null;
  private funds: Funds = { rp: 0, standing: 0 };

  constructor(
    private readonly box: HTMLElement,
    private readonly summary: HTMLElement,
    private readonly onBuy: (id: UpgradeId) => void,
  ) {}

  render(view: ShopView, funds: Funds): void {
    this.view = view;
    this.funds = funds;
    const summary =
      `${fmtInt(view.owned)} of ${fmtInt(view.total)} upgrades owned` +
      (view.mysteries ? ` · ${fmtInt(view.mysteries)} still ${MYSTERY}` : "");
    if (this.summary.textContent !== summary) this.summary.textContent = summary;
    // a chip whose upgrade became reachable (or was bought) no longer has details to show
    for (const [row, id] of this.selected) {
      const c = view.rows.find((r) => r.id === row)?.cards.find((x) => x.id === id);
      if (!c || reachable(c)) this.selected.delete(row);
    }
    const sig = signature(view, this.selected);
    if (sig !== this.sig) {
      this.sig = sig;
      this.box.replaceChildren(...view.rows.map((r) => this.row(r)));
    }
    // every render: how far the points go toward each price, and which can be bought now
    const byId = new Map(view.rows.flatMap((r) => r.cards.map((c) => [c.id, c] as const)));
    for (const node of Array.from(this.box.querySelectorAll<HTMLElement>(".t-card[data-id]"))) {
      const c = byId.get(node.dataset.id as UpgradeId);
      if (!c || c.cost === null) continue;
      const have = c.currency === "rp" ? funds.rp : funds.standing;
      const bar = node.querySelector("progress");
      if (bar) bar.value = Math.min(have, c.cost);
      const btn = node.querySelector("button");
      if (btn) btn.disabled = c.state !== "buyable";
      node.dataset.state = c.state;
    }
  }

  private row(r: RowView): HTMLElement {
    const head = (into: HTMLElement) => {
      into.append(el("span", "t-row-title", r.title), el("span", "t-row-count", `${r.ownedCount} of ${r.total}`));
    };
    const ownedLine = () => {
      const p = el("p", "t-owned");
      p.append(el("span", "t-owned-label", "Owned: "), r.owned.join(" · "));
      return p;
    };
    if (!r.cards.length) {
      // nothing left to buy: one line
      const div = el("div", "t-row t-row-done");
      div.dataset.row = r.id;
      const h = el("div", "t-row-head");
      head(h);
      div.append(h, ownedLine());
      return div;
    }
    const d = el("details", "t-row");
    d.dataset.row = r.id;
    d.open = this.open.get(r.id) ?? true;
    d.addEventListener("toggle", () => this.open.set(r.id, d.open));
    const s = el("summary");
    head(s);
    d.append(s);
    if (r.owned.length) d.append(ownedLine());
    const full = r.cards.filter(reachable);
    if (full.length) {
      const list = el("div", "t-row-cards");
      list.append(...full.map((c) => this.card(c)));
      d.append(list);
    }
    const later = r.cards.filter((c) => !reachable(c));
    if (later.length) {
      const chips = el("div", "t-chips");
      chips.setAttribute("aria-label", `${r.title}: later upgrades`);
      chips.append(...later.map((c) => this.chip(r.id, c)));
      d.append(chips);
      const sel = later.find((c) => c.id === this.selected.get(r.id));
      if (sel) d.append(this.detail(sel));
    }
    return d;
  }

  private chip(row: Row, c: CardView): HTMLElement {
    const b = el("button", "t-chip");
    b.type = "button";
    b.dataset.id = c.id;
    b.dataset.state = c.state;
    const open = this.selected.get(row) === c.id;
    b.setAttribute("aria-expanded", String(open));
    b.setAttribute(
      "aria-label",
      c.state === "mystery" ? c.label : `${c.name}, ${c.price}: needs ${c.needs.join(", ")}; press for details`,
    );
    b.append(el("span", "t-chip-name", c.state === "mystery" ? c.name : chipName(c.name)));
    const price = chipPrice(c);
    if (price) b.append(el("span", "t-chip-price", price));
    b.addEventListener("click", () => {
      if (this.selected.get(row) === c.id) this.selected.delete(row);
      else this.selected.set(row, c.id);
      if (this.view) this.render(this.view, this.funds);
    });
    return b;
  }

  private detail(c: CardView): HTMLElement {
    const p = el("p", "t-chip-detail");
    p.setAttribute("role", "note");
    if (c.state === "mystery") {
      p.append(el("strong", undefined, MYSTERY), ` · needs ${c.needs.join(", ")}.`);
      return p;
    }
    p.append(el("strong", undefined, c.name), ` · ${c.price}. ${sentence(c.effect)} `);
    if (c.real) p.append(el("span", "t-real", `Real: ${c.real}. `));
    if (c.levelText) p.append(`${c.levelText}. `);
    p.append(el("em", undefined, `Needs ${c.needs.join(", ")}.`));
    return p;
  }

  private card(c: CardView): HTMLElement {
    const node = el("div", "t-card");
    node.dataset.id = c.id;
    node.dataset.state = c.state;
    const top = el("div", "t-card-head");
    top.append(el("h3", undefined, c.name));
    if (c.price) top.append(el("span", "t-price", c.price));
    node.append(top);
    const p = el("p", undefined, sentence(c.effect));
    if (c.real) p.append(" ", el("span", "t-real", `Real: ${c.real}.`));
    node.append(p);
    if (c.levelText) node.append(el("p", "t-level", c.levelText));
    const row = el("div", "t-card-row");
    const bar = el("progress");
    bar.max = c.cost!;
    bar.setAttribute("aria-label", `${c.name}: ${c.currency === "rp" ? "points" : "standing"} toward its price`);
    const btn = el("button", undefined, "Buy");
    btn.setAttribute("aria-label", c.label);
    btn.disabled = c.state !== "buyable";
    btn.addEventListener("click", () => this.onBuy(c.id));
    row.append(bar, btn);
    node.append(row);
    return node;
  }
}
