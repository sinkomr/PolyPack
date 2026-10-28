import { AUTO_CLICK_EVALS, DEAL_CLICKS } from "./dealer";
import { HELP, METHOD_MATCH, PIPELINE, TRANSFERS } from "./help";
import { How, renderMechanic, sym } from "./how";
import { AUTO_STEPS, CLICK, QUEUE, RING, ROWS, UPGRADES, autoLevelPrice, levelOfRate, rateOfLevel, upgrade } from "./upgrades";
import type { UpgradeId } from "./upgrades";

/**
 * The Mechanics page: every mechanic of the game in exact detail, built from the same data as the
 * cards and panels (each upgrade's How, help.ts's sections), so it cannot drift from them. The cards
 * and panels show short text with "More detail"; the formulas, variables and notes are only here.
 */

/** A compact table of the steps of a family of upgrades. */
export interface MechanicTable {
  head: readonly string[];
  rows: readonly (readonly string[])[];
}
export interface MechanicEntry {
  id: string;
  name: string;
  /** The short line the card shows (empty for a help section). */
  effect: string;
  hows: readonly How[];
  /** The upgrades this entry explains (one, or a whole family of rungs). */
  covers: readonly string[];
  /** For a family: its steps and prices. */
  table?: MechanicTable;
}
export interface MechanicGroup {
  id: string;
  title: string;
  entries: MechanicEntry[];
}

/** Names of help.ts's sections on this page. */
const HELP_TITLES: Record<string, string> = {
  points: "How record points are paid",
  counts: "Clicks, evaluations and runs",
  standing: "Standing and resets",
  rules: "Cycle rules",
  records: "Rent and collections",
  auto: "Auto-eval and lanes",
  running: "Auto-eval settings",
  sending: "What is sent, and when",
  pipeline: "Pipeline",
  match: "Method match and Auto-tune",
  transfers: "Transfers",
};

const int = (n: number) => n.toLocaleString("en-US");
const num = (x: number) => (Math.abs(x - Math.round(x)) < 1e-9 ? int(Math.round(x)) : x.toFixed(1));

/**
 * A family of rungs (2 to 10 evaluations per click, the size rings, the dealer's best of 2, 4 and 8,
 * Your pick, the queue sizes) is one entry: one rule, and a table of its steps and prices built
 * from the upgrades themselves.
 */
interface Family {
  id: string;
  name: string;
  effect: string;
  ids: UpgradeId[];
  how: How;
  head: string[];
  /** The columns before the price, for one rung. */
  cells: (id: UpgradeId) => string[];
}

const ids = (...x: UpgradeId[]) => x;
const rungIds = (table: Partial<Record<UpgradeId, number>>, skip: UpgradeId[] = []) =>
  (Object.keys(table) as UpgradeId[]).filter((i) => !skip.includes(i));

function families(): Family[] {
  const click = upgrade("click2").how;
  const queue = upgrade("queue3").how;
  const ring = upgrade("ring200").how;
  const rank = upgrade("rank2").how;
  const pick = upgrade("pick3").how;
  const text = (h: How) => (typeof h.text === "string" ? [h.text] : [...h.text]);
  const n = (id: UpgradeId, table: Partial<Record<UpgradeId, number>>) => table[id]!;
  return [
    {
      id: "family:click",
      name: "Evaluations per click",
      effect: "Each rung makes an Evolve click run one more evaluation, from 2 up to 10.",
      ids: rungIds(CLICK),
      how: {
        text: [
          "An Evolve click asks the open run on the problem for more evaluations. Each rung in the table makes a click run one more evaluation of the same run, one after another.",
          "Auto-eval keeps its own rate in evaluations a second, which these upgrades do not change.",
        ],
        math: [`${sym("k")} = ${sym("n")} + ${sym("a")} + ${sym("r")}`],
        vars: [
          [sym("k"), "evaluations per click"],
          [sym("n"), "the evaluations per click of the highest rung you own (1 without one)"],
          ...(click.vars ?? []).slice(1),
        ],
        note: click.note,
      },
      head: ["Evaluations per click"],
      cells: (id) => [String(n(id, CLICK))],
    },
    {
      id: "family:queue",
      name: "Problem queue",
      effect: "Each size holds more problems, and the dealer earns a new one sooner.",
      ids: rungIds(QUEUE),
      how: {
        ...queue,
        vars: (queue.vars ?? []).map((v) =>
          v[0] === sym("q") ? [sym("q"), "the slots in the queue (1 at the start)"] : v,
        ),
        note: "The table gives, for each size, the clicks that earn one deal and the evaluations of auto-eval that do the same.",
      },
      head: ["Slots", "Clicks a deal", "Auto-eval evaluations a deal"],
      cells: (id) => {
        const q = n(id, QUEUE);
        return [String(q), num(DEAL_CLICKS / q), int(Math.round((DEAL_CLICKS / q) * AUTO_CLICK_EVALS))];
      },
    },
    {
      id: "family:ring",
      name: "Problem sets",
      effect: "Each rung lowers the size bound, so smaller site records and published values can be dealt.",
      ids: rungIds(RING, ["reach2"]),
      how: {
        text: [
          text(ring)[0],
          `Each rung lowers the bound to the value in the table, and the last one removes it. ${text(ring)[1].replace(/^[^.]*\.\s*/, "")}`,
        ],
        math: [`${sym("N")} + ${sym("M")} + ${sym("P")} ≥ ${sym("B")}`],
        vars: [...(ring.vars ?? []), [sym("B"), "your size ring's bound, from the table (0 removes it)"]],
      },
      head: ["Bound B"],
      cells: (id) => [String(n(id, RING))],
    },
    {
      id: "family:rank",
      name: "Dealer: best of 2, 4 or 8",
      effect: "The dealer draws more candidate problems and deals the one expected to pay most.",
      ids: ids("rank2", "rank4", "rank8"),
      how: {
        ...rank,
        text: [
          "When a deal is due, the dealer draws the number of candidate problems in the table, checks each with the server, and ranks them by the value V below. It deals the best one, or the next if that one's packing cannot be read. A lost record waiting for Retake and Collector's pick come before the ranked candidates.",
          ...text(rank).slice(1),
        ],
      },
      head: ["Candidates"],
      cells: (id) => [id.slice(4)],
    },
    {
      id: "family:pick",
      name: "Your pick: 3 or 5",
      effect: "The dealer offers you more problems at a time, and you choose.",
      ids: ids("pick3", "pick5"),
      how: {
        ...pick,
        text: [
          "When a slot is free and a deal is saved, the dealer draws problems one at a time and shows up to the number in the table as offers, best first by the value it expects them to pay (see Dealer: best of 2). Nothing more is dealt until you take one. The game checks an offer with the server as you take it, and removes offers that your tree, your filters or the cycle's rule no longer allow.",
          ...text(pick).slice(1),
        ],
      },
      head: ["Offers"],
      cells: (id) => [id.slice(4)],
    },
  ];
}

/** Faster auto-eval's steps: the levels, the rates they reach and the price of the first level of each step. */
function autoStepTable(): MechanicTable {
  let from = 1;
  const rows = AUTO_STEPS.map(({ below, step }) => {
    const last = Number.isFinite(below) ? levelOfRate(below) : null;
    const first = levelOfRate(from) + 1;
    const levels = last === null ? `${int(first)} on` : `${int(first)} to ${int(last)}`;
    const rates = last === null ? `${int(rateOfLevel(first))}, ${int(rateOfLevel(first + 1))}, ...` : `${int(rateOfLevel(first))} to ${int(below)}`;
    const row = [levels, `+${int(step)}`, rates, int(Math.round(autoLevelPrice(first - 1)))];
    from = below;
    return row;
  });
  return { head: ["Levels", "Adds a second", "Rates", "Price of the first (RP)"], rows };
}

/** The data of the page: one group per shop row, then the help sections. */
export function mechanicsModel(): MechanicGroup[] {
  const fams = families();
  const groups: MechanicGroup[] = ROWS.map((r) => {
    const entries: MechanicEntry[] = [];
    for (const u of UPGRADES.filter((x) => x.row === r.id)) {
      const f = fams.find((x) => x.ids.includes(u.id));
      if (!f) {
        entries.push({
          id: u.id,
          name: u.name,
          effect: u.effect,
          hows: [u.how],
          covers: [u.id],
          ...(u.id === "autox" ? { table: autoStepTable() } : {}),
        });
      } else if (u.id === f.ids[0]) {
        entries.push({
          id: f.id,
          name: f.name,
          effect: f.effect,
          hows: [f.how],
          covers: f.ids,
          table: { head: [...f.head, "Price (RP)"], rows: f.ids.map((i) => [...f.cells(i), int(upgrade(i).cost)]) },
        });
      }
    }
    return { id: r.id, title: r.title, entries };
  }).filter((g) => g.entries.length);
  const sections: [string, How | readonly How[]][] = [
    ...Object.entries(HELP),
    ["pipeline", PIPELINE],
    ["match", METHOD_MATCH],
    ["transfers", TRANSFERS],
  ];
  groups.push({
    id: "help",
    title: "Panels and settings",
    entries: sections.map(([id, h]) => ({
      id: `help:${id}`,
      name: HELP_TITLES[id] ?? id,
      effect: "",
      hows: Array.isArray(h) ? (h as readonly How[]) : [h as How],
      covers: [],
    })),
  });
  return groups;
}

/** A family's steps as a small table. */
function renderTable(t: MechanicTable): HTMLElement {
  const table = document.createElement("table");
  table.className = "t-mech-table";
  const head = document.createElement("tr");
  for (const h of t.head) {
    const th = document.createElement("th");
    th.textContent = h;
    head.append(th);
  }
  table.append(head);
  for (const row of t.rows) {
    const tr = document.createElement("tr");
    for (const c of row) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.append(td);
    }
    table.append(tr);
  }
  return table;
}

/** The page's content as DOM: a heading per group, an article per mechanic. */
export function renderMechanics(into: HTMLElement): void {
  const parts: HTMLElement[] = [];
  for (const g of mechanicsModel()) {
    const sec = document.createElement("section");
    sec.dataset.group = g.id;
    const h = document.createElement("h3");
    h.textContent = g.title;
    sec.append(h);
    for (const e of g.entries) {
      const art = document.createElement("article");
      art.className = "t-mech";
      art.dataset.id = e.id;
      const h4 = document.createElement("h4");
      h4.textContent = e.name;
      art.append(h4);
      if (e.effect) {
        const p = document.createElement("p");
        p.className = "t-mech-effect";
        p.textContent = e.effect;
        art.append(p);
      }
      for (const how of e.hows) art.append(renderMechanic(how));
      if (e.table) art.append(renderTable(e.table));
      sec.append(art);
    }
    parts.push(sec);
  }
  into.replaceChildren(...parts);
}
