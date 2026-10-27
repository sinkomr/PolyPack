import type { SpaceConfig } from "@polypack/spaces";
import { DimensionId, familyDimension, parseKey } from "./frontier";
import { GameState, ProblemState, addToQueue, newProblem, problem, reveal } from "./game";

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

/** Opens a dimension for good, as a reset would; false when it was open. */
export function openDimension(s: GameState, d: DimensionId): boolean {
  if (s.standing.dimensions.includes(d)) return false;
  s.standing.dimensions.push(d);
  return true;
}

/** What the server knows of a space problem that a dealt one starts from. */
export interface SpaceStart {
  bound: number | null;
  best: { config: SpaceConfig; score: number } | null;
}

/**
 * Deals a space problem by its id ("sphere/4/10") into the queue and focuses it, opening its
 * dimension: a board to look at without a reset. With the server's best it starts loaded, else bare.
 * Returns the problem, or why not.
 */
export function dealSpaceProblem(s: GameState, id: string, now: number, start: SpaceStart): ProblemState | string {
  const k = parseKey(id);
  if (!k || k.family === "polygon") return `${id} is not a space problem id.`;
  openDimension(s, familyDimension(k.family));
  let p = problem(s, k.id);
  if (!p) {
    p = newProblem(k, "open", now);
    p.bound = start.bound;
    if (start.best) {
      p.board = start.best.config as never;
      p.best = start.best.score;
      p.floor = start.best.score;
      p.phase = "loaded";
    }
    addToQueue(s, p);
  }
  s.focus = p.key;
  return p;
}

export interface CheatHost {
  state(): GameState;
  /** This tab runs the game: in another tab's, a grant would be lost or overwrite its save. */
  canChange(): boolean;
  /** Saves and redraws after a grant. */
  changed(): void;
  /** The server's side of a space problem (its bound and best), or why it could not be read. */
  spaceStart(id: string): Promise<SpaceStart | string>;
  /** The game's clock, in ms. */
  now(): number;
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
  const spaceForm = el("form", undefined, "row wrap");
  const spaceLabel = el("label", "Space problem id");
  spaceLabel.htmlFor = "t-cheat-space";
  const spaceInput = el("input");
  spaceInput.id = "t-cheat-space";
  spaceInput.value = "sphere/0/12";
  const spaceButton = el("button", "Deal it");
  spaceButton.type = "submit";
  const dimInput = el("select");
  dimInput.id = "t-cheat-dimension";
  dimInput.setAttribute("aria-label", "Dimension to open");
  for (const d of ["2-on-3", "3-in-3", "3-on-4"] as const) dimInput.append(new Option(d, d));
  const dimButton = el("button", "Open dimension");
  dimButton.type = "button";
  spaceForm.append(spaceLabel, spaceInput, spaceButton, dimInput, dimButton);
  spaceForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!host.canChange()) {
      note.textContent = "This tab does not run the game, so nothing was dealt.";
      return;
    }
    const id = spaceInput.value.trim();
    void host.spaceStart(id).then((start) => {
      const p = typeof start === "string" ? start : dealSpaceProblem(host.state(), id, host.now(), start);
      note.textContent = typeof p === "string" ? p : `Dealt ${p.key}.`;
      if (typeof p !== "string") host.changed();
    });
  });
  dimButton.addEventListener("click", () => {
    if (!host.canChange()) return;
    const opened = openDimension(host.state(), dimInput.value as DimensionId);
    note.textContent = opened ? `Opened ${dimInput.value}.` : `${dimInput.value} was open.`;
    if (opened) host.changed();
  });
  section.append(spaceForm);
  const save = dialogBody.querySelector("section.t-save");
  if (save) save.after(section);
  else dialogBody.append(section);
  return section;
}
