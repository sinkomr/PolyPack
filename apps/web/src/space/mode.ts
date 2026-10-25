/**
 * The board's space mode: chosen with the Space menu of the Problem section (space-switch.ts),
 * it shows a problem of another space in place of the polygon board. The polygon board's parts
 * are hidden, not changed (CSS: .layout[data-space] .poly-only), so going back shows it as it was.
 *
 * What it offers, per problem of the catalogue (GET /api/spaces/:space/records):
 *  - the problem's best packing (the research record or the site's best entry), drawn by the
 *    space's renderer, with its values in the spaces page's words;
 *  - the space's search in a Web Worker, from the shown packing or a new one, with a seed and a
 *    budget, pause and stop, and the improving packing drawn as it is found;
 *  - submission of a result that passes the server's rule and beats the problem's best, under the
 *    board's own Name and Note fields.
 * Pieces are not moved by hand in these spaces: the board shows and optimises.
 */
import { SCORE_TIE } from "@polypack/geometry";
import type { SpaceConfig, SpaceName, SpaceProblemSummary } from "@polypack/spaces";
import { SPACE_INFO } from "@polypack/spaces";
import type { SpaceCheck } from "@polypack/spaces/search";
import { downloadName } from "../spaces-model";
import { type BoardSpace, spaceAddress } from "../space-address";
import { type SpaceProblemHandle, spaceProblemHandle } from "./index";
import { listSpaceProblems, loadSpaceProblem } from "./load";
import {
  DEFAULT_PROBLEM,
  EVAL_UNIT,
  FRESH_EVALS,
  LARGE_FOLD,
  METHOD_TEXT,
  type LoadedSpaceProblem,
  defaultBudget,
  fieldsOfId,
  pickProblem,
  problemFacts,
  scoreLabel,
  roundSize,
  searchKind,
  shownText,
} from "./model";
import type { SpaceCandidate, SpaceSearch, SpaceSearchResult } from "./search";
import type { SpaceView } from "./view";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Makes an element with attributes and children (text is inserted as text, never as markup). */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false) continue;
    if (k === "class") e.className = String(v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  e.append(...children);
  return e;
}

const row = (label: string, id: string, control: HTMLElement, ...rest: HTMLElement[]) =>
  h("div", { class: "row" }, h("label", { for: id }, label), control, ...rest);

/** Shapes of the board's markup the space mode builds on (index.html). */
interface Host {
  layout: HTMLElement;
  problem: HTMLElement;
  submit: HTMLElement;
  name: HTMLInputElement;
  note: HTMLInputElement;
}

/** Where a run started: the research record, a site entry, an earlier result or nothing. */
type StartFrom = { kind: "certified" } | { kind: "site"; id: number } | { kind: "result" } | { kind: "fresh" };

/** "from the research record", for the method a submission names. */
const fromText = (f: StartFrom) =>
  f.kind === "certified"
    ? "from the research record"
    : f.kind === "site"
      ? `from site entry ${f.id}`
      : f.kind === "result"
        ? "from an earlier board result"
        : "from a new arrangement";

/** A checked result with the run that found it: its seed and start go with a submission. */
interface Result {
  candidate: SpaceCandidate;
  check: SpaceCheck;
  run: SpaceSearchResult;
  seed: number;
  start: SpaceConfig | null;
  from: StartFrom;
}

/** The first letter in upper case (a server's or a thread's reason starts a sentence here). */
const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** The longest method text the server takes (apps/server/src/spaces.ts SPACE_METHOD_LENGTH). */
const METHOD_MAX = 80;

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "3 rounds · 6,000 evaluations · 0.6 s" */
const progressText = (q: { rounds: number; evaluations: number; seconds: number }) =>
  `${count(q.rounds, "round", "rounds")} · ${count(q.evaluations, "evaluation", "evaluations")} · ${q.seconds.toFixed(1)} s`;

const ENDED: Record<SpaceSearchResult["ended"], string> = {
  evals: "Evaluation limit reached",
  time: "Time limit reached",
  bound: "Reached the lower bound",
  stopped: "Stopped",
  error: "The search ended with errors",
};

class SpaceMode {
  /** The problem shown (for the console and the tests). */
  get problem(): LoadedSpaceProblem | null {
    return this.handle?.problem ?? null;
  }

  /** The last run's checked result, and whether it can be submitted (for the console and the tests). */
  get lastResult(): { config: SpaceConfig; score: number; valid: boolean; submittable: boolean } | null {
    const r = this.result;
    if (!r || !this.handle) return null;
    return {
      config: r.candidate.config,
      score: r.candidate.score,
      valid: r.check.valid,
      submittable: !$<HTMLButtonElement>("space-submit").disabled,
    };
  }

  private space: SpaceName | null = null;
  private records = new Map<SpaceName, SpaceProblemSummary[]>();
  /** The last problem shown in each space, so that the menu returns to it. */
  private last = new Map<SpaceName, string>();
  private handle: SpaceProblemHandle | null = null;
  private view: SpaceView | null = null;
  private shown: "best" | "result" = "best";
  private result: Result | null = null;
  private run: SpaceSearch | null = null;
  /** The best of the run in progress, drawn while it runs. */
  private preview: SpaceCandidate | null = null;
  private runInfo: {
    settings: { seed: number; budget: { evals: number; time_s?: number }; fresh: boolean };
    start: SpaceConfig | null;
    from: StartFrom;
    trace: [number, number][];
  } | null = null;
  /** True while the space's problems or a problem are being read: nothing can be run or sent. */
  private loading = false;
  /** The defaults the panel last set: its search and, for fold surfaces, P. */
  private defaultsFor = "";
  /** The ticker that shows how long the round in flight has run, and when that round began. */
  private ticker: ReturnType<typeof setInterval> | null = null;
  private roundSince = 0;
  private lastProgress = "";
  private finished: SpaceSearchResult | null = null;
  /** Counts loads, so that a late answer for an earlier problem is dropped. */
  private token = 0;
  private submitting = false;
  /** True when a run was stopped because the problem changed, until the new problem is shown. */
  private interrupted = false;
  /** The problem whose values the panel lists. */
  private factsOf: LoadedSpaceProblem | null = null;

  constructor(private host: Host) {
    this.build();
  }

  // ---------- markup ----------

  private build(): void {
    const { layout, problem, submit } = this.host;
    const stage = h(
      "section",
      { class: "stage space-stage space-only", "aria-label": "Space workspace" },
      h("div", { id: "space-view-host", class: "space-view-host" }),
      h(
        "div",
        { id: "space-busy", class: "space-busy", hidden: true },
        h("p", { id: "space-busy-text" }),
        h("button", { id: "space-retry", type: "button", hidden: true }, "Try again"),
      ),
      h("p", { id: "space-status", class: "status", role: "status", "aria-live": "polite" }),
    );
    // space-switch.ts shows a placeholder while this module loads
    layout.querySelector(".space-placeholder")?.remove();
    layout.prepend(stage);

    problem.append(
      h(
        "div",
        { id: "space-picker", class: "space-only" },
        h("div", { id: "space-fields" }),
        h("p", { id: "space-problem-note", class: "note" }),
      ),
    );

    const facts = h("dl", { class: "stats", id: "space-facts" });
    const packing = h(
      "section",
      { id: "space-packing", class: "space-only", "aria-labelledby": "space-packing-heading" },
      h("h2", { id: "space-packing-heading" }, "Packing"),
      h(
        "dl",
        { class: "stats" },
        h("dt", { id: "space-score-label" }, "Score"),
        h("dd", { id: "space-score", class: "big" }, "—"),
        h("dt", {}, "Shown"),
        h("dd", { id: "space-shown" }, "—"),
      ),
      facts,
      h(
        "div",
        { id: "space-show", class: "row wrap space-show", hidden: true },
        h("button", { id: "space-show-best", type: "button" }, "Show the problem's best"),
        h("button", { id: "space-show-result", type: "button" }, "Show the result"),
      ),
      h(
        "p",
        { class: "note" },
        "The certified value is proven valid with interval arithmetic. The site best is an entry sent to this site and checked by the server in floating point.",
      ),
    );

    const time = h("input", { id: "space-solve-time", type: "range", min: "1", max: "300", step: "1", value: "15" });
    const solve = h(
      "section",
      { id: "space-solve", class: "space-only", "aria-labelledby": "space-solve-heading" },
      h("h2", { id: "space-solve-heading" }, "Solve automatically"),
      h(
        "form",
        { id: "space-solve-form", novalidate: true },
        h(
          "fieldset",
          { id: "space-solve-settings", class: "plain" },
          h("p", { id: "space-method", class: "note" }),
          row(
            "Start from",
            "space-solve-start",
            h(
              "select",
              { id: "space-solve-start" },
              h("option", { value: "shown" }, "Shown packing"),
              h("option", { value: "fresh" }, "New arrangement"),
            ),
          ),
          row(
            "Budget",
            "space-solve-budget",
            h(
              "select",
              { id: "space-solve-budget" },
              h("option", { value: "both" }, "Time + evaluations"),
              h("option", { value: "evals" }, "Evaluations only"),
            ),
          ),
          row(
            "Time limit",
            "space-solve-time",
            time,
            h("output", { id: "space-solve-time-value", for: "space-solve-time" }, "15 s"),
          ),
          row(
            "Evaluations",
            "space-solve-evals",
            h("input", {
              id: "space-solve-evals",
              type: "number",
              min: "1",
              max: "1000000",
              step: "1",
              required: true,
            }),
          ),
          row(
            "Random seed",
            "space-solve-seed",
            h("input", {
              id: "space-solve-seed",
              type: "number",
              min: "0",
              max: "4294967295",
              step: "1",
              value: "1",
              required: true,
            }),
          ),
          h("p", { id: "space-solve-unit", class: "note" }),
        ),
        h("button", { id: "space-solve-run", class: "wide primary", type: "submit" }, "Run optimizer"),
      ),
      h(
        "div",
        { class: "row wrap solve-actions" },
        h("button", { id: "space-solve-pause", type: "button", disabled: true }, "Pause"),
        h("button", { id: "space-solve-stop", type: "button", disabled: true }, "Stop"),
        h(
          "button",
          {
            id: "space-solve-download",
            type: "button",
            disabled: true,
            title: "Save the settings, the start, the result and the progress",
          },
          "Download run JSON",
        ),
      ),
      h(
        "p",
        { id: "space-solve-status", class: "note", role: "status", "aria-live": "polite" },
        "Choose a budget, then run.",
      ),
      h(
        "p",
        { id: "space-hold", class: "note", hidden: true },
        "The polygon board's optimizer run is paused while a space is shown. It goes on when you choose Polygon in polygon again.",
      ),
      h(
        "dl",
        { class: "stats solve-stats" },
        h("dt", {}, "Best result"),
        h("dd", { id: "space-solve-score" }, "—"),
        h("dt", {}, "Progress"),
        h("dd", { id: "space-solve-progress" }, "—"),
      ),
    );
    const trace = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    trace.id = "space-solve-trace";
    trace.setAttribute("viewBox", "0 0 300 100");
    trace.setAttribute("role", "img");
    trace.setAttribute("aria-label", "Best result over active time");
    trace.setAttribute("hidden", "");
    solve.append(trace);
    problem.after(packing, solve);

    // the board's Name and Note fields serve both modes; the space mode adds its own button
    const noteRow = this.host.note.closest(".row")!;
    noteRow.after(
      h(
        "div",
        { id: "space-submit-box", class: "space-only" },
        h(
          "button",
          { id: "space-submit", type: "button", class: "wide primary", "aria-describedby": "space-submit-note" },
          "Submit to PolyPack",
        ),
        h("p", { id: "space-submit-note", class: "note" }),
        h("p", { id: "space-submit-result", class: "note", role: "status", "aria-live": "polite" }),
      ),
    );
    submit.after(
      h(
        "section",
        { id: "space-save", class: "space-only", "aria-labelledby": "space-save-heading" },
        h("h2", { id: "space-save-heading" }, "Save and share"),
        h(
          "div",
          { class: "row wrap" },
          h("button", { id: "space-export", type: "button" }, "Export JSON"),
          h("button", { id: "space-share", type: "button" }, "Copy link"),
        ),
      ),
      h(
        "details",
        { id: "space-about", class: "space-only" },
        h("summary", {}, "About this space"),
        h("p", { id: "space-summary", class: "note" }),
        h(
          "ul",
          { class: "help" },
          h(
            "li",
            {},
            "Drag the globe or the solid to turn it, or focus it and use the arrow keys (Shift for larger steps, Home to reset).",
          ),
          h("li", {}, "Pieces are not moved by hand here. Run the optimizer to improve the shown packing."),
          h(
            "li",
            {},
            "A result is offered for submission only when it passes the server's check and beats the problem's best by more than a relative 1e-9.",
          ),
          h("li", {}, "The address of the page names the problem, so a link reopens it."),
        ),
        h(
          "p",
          { class: "note" },
          h("a", { id: "space-docs", href: "#", target: "_blank", rel: "noopener noreferrer" }, "Notes on this space"),
          " · ",
          h("a", { id: "space-records", href: "/spaces.html" }, "All its records"),
        ),
      ),
    );

    $("space-retry").addEventListener("click", () => this.retry?.());
    $("space-show-best").addEventListener("click", () => this.showBest());
    $("space-show-result").addEventListener("click", () => this.showResult());
    $("space-solve-form").addEventListener("submit", (e) => {
      e.preventDefault();
      this.startRun();
    });
    time.addEventListener("input", () => ($("space-solve-time-value").textContent = `${time.value} s`));
    $("space-solve-budget").addEventListener("change", () => this.updateButtons());
    $("space-solve-pause").addEventListener("click", () => this.pauseRun());
    $("space-solve-stop").addEventListener("click", () => this.run?.stop());
    $("space-solve-download").addEventListener("click", () => this.downloadRun());
    $("space-submit").addEventListener("click", () => void this.submit());
    $("space-export").addEventListener("click", () => this.exportShown());
    $("space-share").addEventListener("click", () => void this.share());
    window.addEventListener("pagehide", () => this.run?.stop());
  }

  private say(text: string): void {
    $("space-status").textContent = text;
  }

  /** What to do on "Try again" after a failed read. */
  private retry: (() => void) | null = null;

  /**
   * Shows `text` over the drawing while the problems or a problem are read (and disables Run and
   * Submit until they arrive), or a failure with a Try again button; null hides it.
   */
  private busy(text: string | null, retry: (() => void) | null = null): void {
    this.loading = text !== null && !retry;
    this.retry = retry;
    $("space-busy").hidden = text === null;
    $("space-busy-text").textContent = text ?? "";
    $("space-retry").hidden = !retry;
    this.updateButtons();
  }

  /** Shows that the polygon board's own run is held while a space is shown (space-switch.ts). */
  setPolygonHeld(held: boolean): void {
    $("space-hold").hidden = !held;
  }

  private solveStatus(text: string): void {
    $("space-solve-status").textContent = text;
  }

  // ---------- entering and leaving ----------

  async enter(space: BoardSpace, id: string | null): Promise<void> {
    const wanted = id ?? this.last.get(space) ?? null;
    if (space === this.space && this.handle && (wanted === null || wanted === this.handle.problem.id)) {
      this.setAddress();
      return;
    }
    this.space = space;
    $("space-summary").textContent = SPACE_INFO[space].summary;
    $<HTMLAnchorElement>("space-docs").href = SPACE_INFO[space].docs;
    $<HTMLAnchorElement>("space-records").href = `/spaces.html#space=${space}`;
    await this.open(space, wanted);
  }

  leave(): void {
    this.stopRun("left");
  }

  /** Shows a problem of the space: the one wanted when the catalogue has it, else the nearest one. */
  private async open(space: SpaceName, wanted: string | null): Promise<void> {
    const token = ++this.token;
    this.stopRun("problem");
    // the problem of another space is not shown, run or sent while this one loads
    if (this.handle && this.handle.problem.space !== space) this.clearProblem();
    this.setAddress();
    let problems = this.records.get(space);
    if (!problems) {
      this.busy("Loading the problems of this space…");
      this.say("");
      $("space-fields").replaceChildren();
      const listed = await listSpaceProblems(space);
      if (token !== this.token) return;
      if (!listed) {
        this.clearProblem();
        this.setAddress();
        const text = "The problems of this space could not be loaded. The server may be unreachable.";
        this.say(text);
        this.busy(text, () => void this.open(space, wanted));
        return;
      }
      problems = listed;
      this.records.set(space, problems);
    }
    const pick = pickProblem(space, problems, fieldsOfId(space, wanted ?? DEFAULT_PROBLEM[space]));
    this.renderPicker(space, pick.fields);
    if (!pick.id) {
      this.clearProblem();
      this.busy("This space lists no problems.", () => void this.open(space, wanted));
      return;
    }
    const missing =
      wanted !== null && pick.id !== wanted ? `${wanted} is not in the catalogue, so ${pick.id} is shown.` : "";
    await this.load(space, pick.id, token, missing);
  }

  private renderPicker(space: SpaceName, fields: ReturnType<typeof pickProblem>["fields"]): void {
    const box = $("space-fields");
    const rows = fields.map((f) => {
      const id = `space-f-${f.key}`;
      const select = h("select", { id });
      for (const o of f.options) select.add(new Option(o.text, o.value));
      select.value = f.value;
      select.addEventListener("change", () => {
        const wish: Record<string, string> = {};
        for (const g of fields) wish[g.key] = g.key === f.key ? select.value : g.value;
        const problems = this.records.get(space) ?? [];
        const pick = pickProblem(space, problems, wish);
        this.renderPicker(space, pick.fields);
        // keep the focus on the field that was changed
        $(id)?.focus();
        if (pick.id) void this.load(space, pick.id, ++this.token, "");
      });
      return row(f.label, id, select);
    });
    box.replaceChildren(...rows);
  }

  private async load(space: SpaceName, id: string, token: number, note: string): Promise<void> {
    this.stopRun("problem");
    this.busy(`Loading ${id}…`);
    const p = await loadSpaceProblem(space, id);
    if (token !== this.token) return;
    if (typeof p === "string") {
      this.clearProblem();
      this.setAddress();
      this.say(p);
      this.busy(`${id} could not be loaded. ${p}`, () => void this.load(space, id, ++this.token, note));
      return;
    }
    this.busy(null);
    const sameProblem = this.handle?.problem.id === p.id;
    this.handle = spaceProblemHandle(p);
    this.last.set(space, id);
    this.result = null;
    this.finished = null;
    this.shown = "best";
    if (!sameProblem || !this.view) {
      this.view?.destroy();
      this.view = this.handle.render($("space-view-host"));
    }
    this.view.show(p.best?.config ?? null);
    this.setDefaults(p);
    this.setAddress();
    this.renderFacts();
    this.renderTrace([]);
    $("space-solve-score").textContent = "—";
    $("space-solve-progress").textContent = "—";
    $("space-submit-result").textContent = "";
    this.say(
      note ||
        (p.best
          ? `${p.id}: ${shownText(p.best.source, p)}, ${p.best.score.toFixed(6)}.`
          : p.status === "infeasible"
            ? `${p.id}: no packing exists for this problem.`
            : `${p.id}: the server's packing of this problem could not be read.`),
    );
    const stopped = this.interrupted;
    this.interrupted = false;
    this.solveStatus(
      (stopped ? "The problem changed, so the run was stopped. " : "") +
        (p.best ? "Choose a budget, then run." : "There is no packing to start from."),
    );
    this.updateButtons();
  }

  /** The address names the problem shown (the polygon board's own links are not touched). */
  private setAddress(): void {
    if (!this.space) return;
    const hash = spaceAddress(this.space as BoardSpace, this.handle?.problem.id ?? null);
    if (location.hash !== hash)
      history.replaceState(history.state, "", `${location.pathname}${location.search}${hash}`);
  }

  /** No problem shown: nothing to draw, run or send (another space is loading, or a read failed). */
  private clearProblem(): void {
    this.handle = null;
    this.result = null;
    this.finished = null;
    this.shown = "best";
    this.view?.destroy();
    this.view = null;
    this.renderFacts();
  }

  /**
   * The budget and the notes of the problem's search. The budget is set again only for another
   * search (or, for fold surfaces, another P), so that a budget the user chose stays.
   */
  private setDefaults(p: LoadedSpaceProblem): void {
    const kind = searchKind(p.search);
    const fold = kind === "surface";
    const key = fold ? `${kind}/${p.P}` : kind;
    if (key !== this.defaultsFor) {
      this.defaultsFor = key;
      const d = defaultBudget(p.search);
      $<HTMLInputElement>("space-solve-time").value = String(d.time_s);
      $("space-solve-time-value").textContent = `${d.time_s} s`;
      $<HTMLInputElement>("space-solve-evals").value = String(d.evals);
    }
    $("space-method").replaceChildren(h("b", {}, "Method: "), METHOD_TEXT[kind]);
    const size = roundSize(p.search);
    const n = (v: number) => v.toLocaleString("en-US");
    $("space-solve-unit").textContent =
      `An evaluation here is ${EVAL_UNIT[kind]}. The search runs in rounds of ${n(size)}, each from the best so far` +
      (FRESH_EVALS[kind] > size ? `; a new arrangement needs a first round of ${n(FRESH_EVALS[kind])}` : "") +
      ". With Evaluations only, the same seed gives the same result." +
      (fold && p.P >= 20
        ? ` Fold rounds on ${p.P} pieces are slow: one compression can take ${p.P >= LARGE_FOLD ? "half a minute or more" : "several seconds"}, and the time limit ends the run.`
        : "");
  }

  // ---------- the panel ----------

  /** The configuration shown, and what it is. */
  private shownConfig(): {
    config: SpaceConfig;
    score: number;
    source: "certified" | "site" | "result" | "preview";
  } | null {
    const p = this.handle?.problem;
    if (!p) return null;
    if (this.run && this.preview) return { ...this.preview, source: "preview" };
    if (this.shown === "result" && this.result) return { ...this.result.candidate, source: "result" };
    return p.best;
  }

  private renderFacts(): void {
    const p = this.handle?.problem ?? null;
    const shown = this.shownConfig();
    $("space-score-label").textContent = p ? scoreLabel(p.search) : "Score";
    $("space-score").textContent = shown ? shown.score.toFixed(6) : "—";
    $("space-shown").textContent =
      shown && p
        ? shownText(shown.source, p)
        : p
          ? p.status === "infeasible"
            ? "no packing exists"
            : "none could be read"
          : "—";
    // built again only for another problem, so that an opened "Why" stays open during a run
    const facts = $("space-facts");
    if (this.factsOf !== p) {
      this.factsOf = p;
      facts.replaceChildren();
    }
    if (p && !facts.childElementCount)
      for (const f of problemFacts(p)) {
        const dd = h("dd", {}, f.value);
        // a closed problem's reason can be long (a proof is cited), so it opens on demand
        if (f.note && f.label === "Entries")
          dd.append(h("details", { class: "fact-note" }, h("summary", {}, "Why"), f.note));
        else if (f.note) dd.append(h("span", { class: "fact-note" }, f.note));
        facts.append(h("dt", {}, f.label), dd);
      }
    $("space-problem-note").replaceChildren(...(p ? ["Problem ", h("code", {}, p.id)] : []));
    $("space-show").hidden = !this.result;
    $<HTMLButtonElement>("space-show-best").disabled = !p?.best || this.shown === "best" || !!this.run;
    $<HTMLButtonElement>("space-show-result").disabled = !this.result || this.shown === "result" || !!this.run;
    this.renderSubmit();
  }

  private renderSubmit(): void {
    const p = this.handle?.problem ?? null;
    const note = $("space-submit-note");
    const button = $<HTMLButtonElement>("space-submit");
    let why = "";
    if (this.loading) why = "Loading…";
    else if (!p) why = "Choose a problem first.";
    else if (!p.accepts_submissions) why = `This problem takes no entries: ${p.closed_reason ?? "it is closed"}.`;
    else if (this.run) why = "The optimizer is running.";
    else if (!this.result) why = "Run the optimizer first. Only a result that beats the problem's best can be sent.";
    else if (!this.result.check.valid)
      why = `The result did not pass the check: ${this.result.check.reasons[0] ?? "invalid"}.`;
    else if (!this.handle!.improves(this.result.candidate.score))
      why = `The result ${this.result.candidate.score.toFixed(6)} does not beat the problem's best ${p.best_score!.toFixed(6)}.`;
    button.disabled = !!why || this.submitting;
    note.textContent =
      why ||
      `Sends the optimizer's result, ${this.result!.candidate.score.toFixed(6)}, which beats the problem's best${p!.best_score === null ? "" : ` ${p!.best_score.toFixed(6)}`}.`;
  }

  private updateButtons(): void {
    const running = !!this.run;
    const p = this.handle?.problem ?? null;
    $<HTMLFieldSetElement>("space-solve-settings").disabled = running;
    const fresh = $<HTMLSelectElement>("space-solve-start").value === "fresh";
    $<HTMLButtonElement>("space-solve-run").disabled =
      running || this.loading || !p || (!p.best && !fresh) || p.status === "infeasible";
    $<HTMLButtonElement>("space-export").disabled = this.loading || !p?.best;
    $<HTMLButtonElement>("space-solve-pause").disabled = !running;
    $("space-solve-pause").textContent = this.run?.state === "paused" ? "Resume" : "Pause";
    $<HTMLButtonElement>("space-solve-stop").disabled = !running;
    $<HTMLButtonElement>("space-solve-download").disabled = running || !this.finished;
    $<HTMLInputElement>("space-solve-time").disabled =
      running || $<HTMLSelectElement>("space-solve-budget").value === "evals";
    this.renderFacts();
  }

  private showBest(): void {
    const p = this.handle?.problem;
    if (!p?.best || this.run) return;
    this.shown = "best";
    this.view?.show(p.best.config);
    this.renderFacts();
    this.say(`Showing ${shownText(p.best.source, p)}, ${p.best.score.toFixed(6)}.`);
  }

  private showResult(): void {
    if (!this.result || this.run) return;
    this.shown = "result";
    this.view?.show(this.result.candidate.config);
    this.renderFacts();
    this.say(`Showing the optimizer's result, ${this.result.candidate.score.toFixed(6)}.`);
  }

  // ---------- the optimizer ----------

  private readSettings(): { seed: number; budget: { evals: number; time_s?: number }; fresh: boolean } | string {
    const field = (id: string) => $<HTMLInputElement>(id).value.trim();
    // an empty field is not 0: Number("") is
    const evals = field("space-solve-evals") === "" ? NaN : Number(field("space-solve-evals"));
    const seed = field("space-solve-seed") === "" ? NaN : Number(field("space-solve-seed"));
    const time = Number($<HTMLInputElement>("space-solve-time").value);
    if (!Number.isSafeInteger(evals) || evals < 1 || evals > 1_000_000) {
      $("space-solve-evals").focus();
      return "Evaluations: enter a whole number from 1 to 1,000,000. Nothing was run.";
    }
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      $("space-solve-seed").focus();
      return "Random seed: enter a whole number from 0 to 4,294,967,295. Nothing was run.";
    }
    const both = $<HTMLSelectElement>("space-solve-budget").value === "both";
    return {
      seed,
      budget: { evals, ...(both ? { time_s: Math.max(1, Math.min(300, time)) } : {}) },
      fresh: $<HTMLSelectElement>("space-solve-start").value === "fresh",
    };
  }

  private startRun(): void {
    const handle = this.handle;
    if (!handle || this.run) return;
    const settings = this.readSettings();
    if (typeof settings === "string") return this.solveStatus(settings);
    const shown = this.shownConfig();
    const start = settings.fresh ? null : (shown?.config ?? null);
    if (!start && !settings.fresh)
      return this.solveStatus("There is no packing to start from. Choose New arrangement.");
    const p = handle.problem;
    const from: StartFrom = settings.fresh
      ? { kind: "fresh" }
      : shown?.source === "result"
        ? { kind: "result" }
        : shown?.source === "site" && p.site_best
          ? { kind: "site", id: p.site_best.id }
          : { kind: "certified" };
    const trace: [number, number][] = [];
    this.runInfo = { settings, start, from, trace };
    this.preview = null;
    this.finished = null;
    $("space-solve-score").textContent = "—";
    $("space-solve-progress").textContent = "Starting…";
    $("space-submit-result").textContent = "";
    this.renderTrace(trace);
    const problemId = handle.problem.id;
    const run = handle.search(start, {
      ...settings,
      onProgress: (q) => {
        if (this.run !== run) return;
        // a round ended, or the run was paused or resumed: the next round starts now
        this.roundSince = performance.now();
        this.lastProgress = progressText(q);
        $("space-solve-progress").textContent = this.lastProgress;
        if (q.improved && q.best) {
          this.preview = q.best;
          $("space-solve-score").textContent = q.best.score.toFixed(6);
          trace.push([q.seconds, q.best.score]);
          this.renderTrace(trace);
          this.view?.show(q.best.config);
        }
        this.solveStatus(
          q.state === "paused" ? "Paused. Resume, or stop to keep the best result." : `Running ${handle.method}…`,
        );
        this.updateButtons();
      },
    });
    this.run = run;
    this.solveStatus(`Running ${handle.method}…`);
    this.startTicker();
    this.updateButtons();
    void run.done.then((r) => {
      if (this.run !== run) return;
      this.run = null;
      this.stopTicker();
      this.preview = null;
      this.finished = r;
      if (this.handle?.problem.id !== problemId) return;
      this.finishRun(r);
    });
  }

  private finishRun(r: SpaceSearchResult): void {
    const handle = this.handle!;
    const p = handle.problem;
    $("space-solve-progress").textContent = progressText(r);
    let text = `${ENDED[r.ended]}.`;
    if (r.ended === "error" && r.reasons.length) text += ` ${capital(r.reasons.join("; "))}.`;
    const info = this.runInfo!;
    const best = p.best_score === null ? "" : ` ${p.best_score.toFixed(6)}`;
    // a run that started from the earlier result keeps it, with the seed and start of the run
    // that found it, unless it found a better one
    const previous = info.from.kind === "result" ? this.result : null;
    const check = r.best ? handle.validate(r.best.config) : null;
    const better = !!r.best && (!previous || r.best.score < previous.candidate.score * (1 - SCORE_TIE));
    if (r.best && check?.valid && better) {
      this.result = { candidate: r.best, check, run: r, seed: info.settings.seed, start: info.start, from: info.from };
      this.shown = "result";
      text += handle.improves(r.best.score)
        ? ` The result ${r.best.score.toFixed(6)} beats the problem's best${best}. You can submit it.`
        : ` The result ${r.best.score.toFixed(6)} does not beat the problem's best${best}.`;
    } else {
      if (r.best && !check?.valid)
        text += ` The result did not pass the check (${check?.reasons[0] ?? "invalid"}), so it is not offered.`;
      else if (r.rounds === 0) text += " It ended before its first round finished.";
      else if (previous) text += " It found nothing better than the result it started from.";
      else text += " No valid result was found.";
      if (previous) {
        this.result = previous;
        this.shown = "result";
        text += ` That result, ${previous.candidate.score.toFixed(6)}, is kept.`;
      } else {
        // nothing from this run, and the earlier result (if any) is not what it started from
        this.result = null;
        this.shown = "best";
      }
    }
    const shown = this.shownConfig();
    this.view?.show(shown?.config ?? null);
    $("space-solve-score").textContent = this.result ? this.result.candidate.score.toFixed(6) : "—";
    this.solveStatus(text);
    this.updateButtons();
  }

  private pauseRun(): void {
    const run = this.run;
    if (!run) return;
    if (run.state === "paused") run.resume();
    else run.pause();
    this.roundSince = performance.now();
    this.solveStatus(run.state === "paused" ? "Paused. Resume, or stop to keep the best result." : "Running…");
    this.updateButtons();
  }

  /** Ends a run without offering its result (the problem changed, or the board left the space). */
  private stopRun(why: "problem" | "left"): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    this.stopTicker();
    this.preview = null;
    this.interrupted = why === "problem";
    run.stop();
    this.solveStatus(why === "problem" ? "The problem changed, so the run was stopped." : "The run was stopped.");
    this.updateButtons();
  }

  /** Every second of a run, the progress line says how long the round in flight has run. */
  private startTicker(): void {
    this.stopTicker();
    this.roundSince = performance.now();
    this.lastProgress = "Starting…";
    this.ticker = setInterval(() => {
      const run = this.run;
      if (!run || run.state !== "running") return;
      const s = (performance.now() - this.roundSince) / 1000;
      // short rounds need no clock; a long one shows it is working
      if (s >= 2) $("space-solve-progress").textContent = `${this.lastProgress} · round running for ${Math.floor(s)} s`;
    }, 1000);
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  private renderTrace(trace: [number, number][]): void {
    const svg = $("space-solve-trace") as unknown as SVGSVGElement;
    svg.replaceChildren();
    svg.toggleAttribute("hidden", trace.length < 1);
    if (!trace.length) return;
    const NS = "http://www.w3.org/2000/svg";
    const end = Math.max(0.01, trace[trace.length - 1][0]);
    const low = Math.min(...trace.map((p) => p[1]));
    const high = Math.max(...trace.map((p) => p[1]));
    const range = high - low || Math.max(1e-6, high * 1e-6);
    const line = document.createElementNS(NS, "polyline");
    line.setAttribute(
      "points",
      trace
        .map(([t, s]) => `${(10 + (280 * t) / end).toFixed(2)},${(10 + (65 * (high - s)) / range).toFixed(2)}`)
        .join(" "),
    );
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", "10");
    label.setAttribute("y", "92");
    label.textContent = `${high.toFixed(6)} → ${low.toFixed(6)} · ${end.toFixed(1)} s`;
    svg.append(line, label);
    svg.setAttribute(
      "aria-label",
      `Best result from ${high.toFixed(6)} to ${low.toFixed(6)} over ${end.toFixed(1)} seconds`,
    );
  }

  private downloadRun(): void {
    const p = this.handle?.problem;
    const r = this.finished;
    const info = this.runInfo;
    if (!p || !r || !info || this.run) return;
    const kind = searchKind(p.search);
    const data = {
      space: p.space,
      id: p.id,
      method: this.handle!.method,
      settings: { ...info.settings, round_evals: roundSize(p.search), fresh_round_evals: FRESH_EVALS[kind] },
      start: info.start,
      start_from: fromText(info.from),
      result: r.best ? { score: r.best.score, round: r.best.round, seed: r.best.seed, config: r.best.config } : null,
      rounds: r.rounds,
      evaluations: r.evaluations,
      seconds: r.seconds,
      ended: r.ended,
      trace: r.trace,
      environment: "browser",
      downloadedAt: new Date().toISOString(),
    };
    this.download(`polypack-${p.id.replace(/[^A-Za-z0-9.-]+/g, "_")}-seed${info.settings.seed}.json`, data);
  }

  private download(name: string, data: unknown): void {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- submit, save, share ----------

  private async submit(): Promise<void> {
    const handle = this.handle;
    const result = this.result;
    const out = $("space-submit-result");
    if (!handle || !result || this.run || this.submitting) return;
    const name = this.host.name.value.trim();
    if (!name) {
      this.host.name.focus();
      out.className = "note bad";
      out.textContent = "✗ Enter a display name.";
      return;
    }
    try {
      localStorage.setItem("polypack.name", name);
    } catch {
      // storage can be unavailable (private mode)
    }
    this.submitting = true;
    this.renderSubmit();
    out.className = "note";
    out.textContent = "Submitting…";
    // the seed and the start of the run that found it
    const method = `${handle.method} (board, ${fromText(result.from)})`;
    const answer = await handle.submit(result.candidate.config, {
      name,
      note: this.host.note.value.trim(),
      method: method.length <= METHOD_MAX ? method : handle.method,
      seed: result.seed,
      software: "PolyPack board",
    });
    this.submitting = false;
    const tone = answer.kind === "kept" ? "note good" : answer.kind === "not-kept" ? "note" : "note bad";
    if (this.handle !== handle) {
      // another problem is shown now: say what became of this one's entry, under its name
      const text = `Your entry for ${handle.problem.id}: ${answer.text}`;
      this.say(text);
      out.className = tone;
      out.textContent = text;
      this.renderSubmit();
      return;
    }
    out.className = tone;
    out.textContent = answer.text;
    // read the problem again: its best may have changed, or it may have closed
    if (answer.kind === "kept" || answer.kind === "not-kept" || answer.kind === "closed") {
      const keep = out.textContent;
      await this.load(handle.problem.space, handle.problem.id, ++this.token, "");
      $("space-submit-result").className = out.className;
      $("space-submit-result").textContent = keep;
    } else this.renderSubmit();
  }

  private exportShown(): void {
    const p = this.handle?.problem;
    const shown = this.shownConfig();
    if (!p || !shown) return this.say("There is no packing to export.");
    this.download(downloadName(p.id), { space: p.space, id: p.id, score: shown.score, config: shown.config });
  }

  private async share(): Promise<void> {
    if (!this.space) return;
    const url = `${location.origin}${location.pathname}${spaceAddress(this.space as BoardSpace, this.handle?.problem.id ?? null)}`;
    try {
      await navigator.clipboard.writeText(url);
      this.say("Link copied to the clipboard.");
    } catch {
      this.say("The link is in the address bar.");
    }
  }
}

let mode: SpaceMode | null = null;

/** The board's space mode, built on first use from the board's markup. */
export function createSpaceMode(): {
  enter(space: BoardSpace, id: string | null): Promise<void>;
  leave(): void;
  setPolygonHeld(held: boolean): void;
} {
  if (!mode) {
    const select = $("space-select");
    const name = $<HTMLInputElement>("name");
    mode = new SpaceMode({
      layout: select.closest("main")!,
      problem: select.closest("section")!,
      submit: name.closest("section")!,
      name,
      note: $<HTMLInputElement>("agent-note"),
    });
    // a handle for the browser console and the end-to-end tests, beside the board's own
    const w = window as unknown as { polypack?: Record<string, unknown> };
    w.polypack = { ...w.polypack, space: mode };
  }
  return mode;
}
