import { GameState, reveal } from "./game";

/**
 * Cheats for playtesting: points from nowhere, to move through the game faster. Only a development
 * build has them. main.ts imports this module behind `import.meta.env.DEV`, so a production build
 * leaves it out. What they add stays in this browser: no problem carries it, so nothing is sent for
 * it, and no answer of the server confirms it or takes it back.
 */

export interface Grant {
  /** Record points to spend. */
  rp?: number;
  /** Count those record points as earned in this cycle too (Earned, standing milestones, a reset). */
  earned?: boolean;
  /** Standing to spend, in whole points. */
  standing?: number;
}

/** A finite amount above zero, else nothing. */
const amount = (x: number | undefined): number => (x !== undefined && Number.isFinite(x) && x > 0 ? x : 0);

/** Adds a grant to the game and returns what was added. */
export function grant(s: GameState, g: Grant): { rp: number; standing: number } {
  const rp = amount(g.rp);
  const standing = Math.floor(amount(g.standing));
  s.rp += rp;
  if (g.earned) {
    s.rpEarned += rp;
    s.standing.cycleEarned += rp;
  }
  s.standing.points += standing;
  // the panels where they are spent
  if (rp > 0) reveal(s, "points", "upgrades");
  return { rp, standing };
}

export interface CheatHost {
  state(): GameState;
  /** This tab runs the game: in another tab's, a grant would be lost or overwrite its save. */
  canChange(): boolean;
  /** Saves and redraws after a grant. */
  changed(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });

/** A form of one amount: its label, a number field and the button that adds it. */
function amountForm(
  id: string,
  label: string,
  value: number,
  step: string,
  button: string,
  onAdd: (n: number) => void,
) {
  const form = el("form", undefined, "row wrap");
  const l = el("label", label);
  l.htmlFor = id;
  const input = el("input");
  input.id = id;
  input.type = "number";
  input.min = "0";
  input.step = step;
  input.value = String(value);
  input.inputMode = step === "1" ? "numeric" : "decimal";
  const b = el("button", button);
  b.type = "submit";
  form.append(l, input, b);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    onAdd(Number(input.value));
  });
  return form;
}

/** The "Cheats (local only)" section, placed in the Settings dialog after its Save section. */
export function mountCheats(dialogBody: HTMLElement, host: CheatHost): HTMLElement {
  const section = el("section", undefined, "t-cheats");
  section.setAttribute("aria-labelledby", "t-cheats-heading");
  const heading = el("h3", "Cheats (local only)");
  heading.id = "t-cheats-heading";
  const intro = el(
    "p",
    "Only a local development build has this section. Points added here stay in this browser. Nothing is sent for them, and the server never confirms them or takes them back.",
    "note",
  );
  const earned = el("input");
  earned.id = "t-cheat-earned";
  earned.type = "checkbox";
  const earnedLabel = el("label", undefined, "t-check");
  earnedLabel.append(earned, " Count added record points as earned this cycle, toward standing milestones and a reset");
  const note = el("p", undefined, "note");
  note.id = "t-cheat-note";
  note.setAttribute("role", "status");
  const apply = (g: Grant) => {
    if (!host.canChange()) {
      note.textContent = "This tab does not run the game, so nothing was added.";
      return;
    }
    const s = host.state();
    const added = grant(s, g);
    note.textContent =
      added.rp > 0
        ? `Added ${fmt(added.rp)} RP${g.earned ? ", counted as earned this cycle" : ""}. You have ${fmt(s.rp)} RP to spend.`
        : added.standing > 0
          ? `Added ${fmt(added.standing)} standing. You have ${fmt(s.standing.points)} standing to spend.`
          : "Enter an amount above zero.";
    host.changed();
  };
  section.append(
    heading,
    intro,
    amountForm("t-cheat-rp", "Record points", 100_000, "any", "Add RP", (n) =>
      apply({ rp: n, earned: earned.checked }),
    ),
    earnedLabel,
    amountForm("t-cheat-standing", "Standing", 10, "1", "Add standing", (n) => apply({ standing: n })),
    note,
  );
  const save = dialogBody.querySelector("section.t-save");
  if (save) save.after(section);
  else dialogBody.append(section);
  return section;
}
