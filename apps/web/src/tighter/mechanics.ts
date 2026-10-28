import { HELP, METHOD_MATCH, PIPELINE, TRANSFERS } from "./help";
import { How, renderMechanic } from "./how";
import { ROWS, UPGRADES } from "./upgrades";

/**
 * The Mechanics page: every mechanic of the game in exact detail, built from the same data as the
 * cards and panels (each upgrade's How, help.ts's sections), so it cannot drift from them. The cards
 * and panels show short text with "More detail"; the formulas, variables and notes are only here.
 */

export interface MechanicEntry {
  id: string;
  name: string;
  /** The short line the card shows (empty for a help section). */
  effect: string;
  hows: readonly How[];
}
export interface MechanicGroup {
  id: string;
  title: string;
  entries: MechanicEntry[];
}

/** Names of help.ts's sections on this page. */
const HELP_TITLES: Record<string, string> = {
  points: "How points are paid",
  counts: "How clicks, evaluations and runs work",
  standing: "How standing and resets work",
  rules: "How cycle rules work",
  records: "How rent and collections work",
  auto: "How auto-eval and lanes work",
  running: "How a run works",
  sending: "What is sent, and how often",
  pipeline: "Pipeline",
  match: "Method match and Auto-tune",
  transfers: "Transfers",
};

/** The data of the page: one group per shop row, then the help sections. */
export function mechanicsModel(): MechanicGroup[] {
  const groups: MechanicGroup[] = ROWS.map((r) => ({
    id: r.id,
    title: r.title,
    entries: UPGRADES.filter((u) => u.row === r.id).map((u) => ({
      id: u.id,
      name: u.name,
      effect: u.effect,
      hows: [u.how],
    })),
  })).filter((g) => g.entries.length);
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
    })),
  });
  return groups;
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
      sec.append(art);
    }
    parts.push(sec);
  }
  into.replaceChildren(...parts);
}
