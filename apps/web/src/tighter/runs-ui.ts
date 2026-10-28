import { METHOD_MATCH, PIPELINE, TRANSFERS, andList } from "./help";
import { moreDetail } from "./detail";
import type { How } from "./how";
import { methodLabel } from "./methods";
import { RunPlanState, addStage, learned, moveStage, removeStage, runsObserved } from "./runplan";
import { TRANSFER_MARGIN } from "./transfer";
import type { EvolveMethod, Owned } from "./upgrades";

/**
 * The Runs panel: the pipeline editor (Pipelines), what Method match has learned about problems
 * like the one on the board, and a note on Transfers. Shown once any of them is owned. The panel
 * is rebuilt only when what it shows changes.
 */

export interface RunsPanelInput {
  plan: RunPlanState;
  owned: Owned;
  /** The methods the player owns, in the order they unlock. */
  methods: readonly EvolveMethod[];
  /** The cycle's rule lets this method run. */
  allowed: (m: EvolveMethod) => boolean;
  /** The kind of the problem on the board (see problemKind), if any. */
  focusKind: string | null;
}

/** What each "More detail" button in the Runs panel explains. */
const HOW_TITLES: Record<string, string> = {
  pipeline: "the pipeline",
  match: "method match",
  transfers: "transfers",
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};

function button(label: string, aria: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = el("button", label);
  b.type = "button";
  b.setAttribute("aria-label", aria);
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

const fmt = (x: number) => (Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(3));

/** Builds (or keeps) the panel; `onPipeline` receives the edited pipeline. */
export function renderRunsPanel(
  section: HTMLElement,
  body: HTMLElement,
  input: RunsPanelInput,
  onPipeline: (next: EvolveMethod[]) => void,
): void {
  const { plan, owned: o } = input;
  const pipes = o.has("pipeline");
  const match = o.has("methodMatch") || o.has("autoTune");
  const transfer = o.has("transfer");
  const visible = pipes || match || transfer;
  if (section.hidden === visible) section.hidden = !visible;
  if (!visible) return;
  const top = input.focusKind ? learned(plan, input.focusKind).slice(0, 3) : [];
  const sig = JSON.stringify([
    pipes,
    match,
    transfer,
    o.has("autoTune"),
    plan.pipeline,
    input.methods.map((m) => `${m}:${input.allowed(m)}`),
    match
      ? [plan.auto, runsObserved(plan), input.focusKind, top.map((t) => [t.method, t.level, fmt(t.mean), t.runs])]
      : 0,
  ]);
  if (body.dataset.sig === sig) return;
  body.dataset.sig = sig;
  const parts: HTMLElement[] = [];
  const how = (id: string, h: How): HTMLButtonElement => moreDetail(h, HOW_TITLES[id] ?? id, "t-how-btn");

  if (pipes) {
    parts.push(el("h3", "Pipeline"));
    const list = el("ol", undefined, "t-pipeline");
    plan.pipeline.forEach((stage, i) => {
      const m = methodLabel(stage);
      const li = el("li");
      const name = el("span", `${i + 1}. ${m}`, input.allowed(stage) ? undefined : "t-refused");
      if (!input.allowed(stage)) name.title = "This cycle's rule does not allow this method, so this stage is skipped.";
      const n = plan.pipeline.length;
      const actions = el("span", undefined, "t-q-actions");
      actions.append(
        button("↑", `Move stage ${i + 1}, ${m}, up`, () => onPipeline(moveStage(plan.pipeline, i, -1)), i === 0),
        button("↓", `Move stage ${i + 1}, ${m}, down`, () => onPipeline(moveStage(plan.pipeline, i, 1)), i === n - 1),
        button("Remove", `Remove stage ${i + 1}, ${m}`, () => onPipeline(removeStage(plan.pipeline, i))),
      );
      li.append(name, actions);
      list.append(li);
    });
    if (plan.pipeline.length) parts.push(list);
    const row = el("div", undefined, "row t-pipeline-add");
    const label = el("label", "Add a stage");
    label.htmlFor = "t-pipeline-method";
    const select = el("select");
    select.id = "t-pipeline-method";
    for (const m of input.methods) {
      const opt = el("option", methodLabel(m));
      opt.value = m;
      opt.disabled = !input.allowed(m);
      select.append(opt);
    }
    row.append(
      label,
      select,
      button(
        "Add",
        "Add the chosen method as the pipeline's last stage",
        () => onPipeline(addStage(plan.pipeline, select.value as EvolveMethod)),
        plan.pipeline.length >= 9,
      ),
    );
    parts.push(row);
    parts.push(
      el(
        "p",
        plan.pipeline.length
          ? "Each new run on a problem uses the next stage, in a loop. While the pipeline has stages, it chooses the method instead of the toolbar."
          : "With no stages, your clicks run the toolbar's method. Add methods in the order you want the runs on a problem to use them.",
        "note",
      ),
      how("pipeline", PIPELINE),
    );
  }

  if (match) {
    parts.push(el("h3", o.has("autoTune") ? "Method match and Auto-tune" : "Method match"));
    const runs = runsObserved(plan);
    const lines: string[] = [
      `It has learned from ${runs.toLocaleString("en-US")} run${runs === 1 ? "" : "s"} so far, as RP earned per evaluation. ` +
        (plan.auto
          ? `Auto is on, so it picks the ${o.has("autoTune") ? "method and setting" : "method"} of each new run.`
          : `Choose Auto in the toolbar to let it pick the ${o.has("autoTune") ? "method and setting" : "method"} of each new run.`),
    ];
    if (input.focusKind)
      lines.push(
        top.length
          ? `On problems like this one, the best so far ${top.length === 1 ? "is" : "are"} ${andList(
              top.map(
                (t) =>
                  `${methodLabel(t.method)}${t.level ? ` at setting ${t.level}` : ""} with ${fmt(t.mean)} RP an evaluation (${t.runs} run${t.runs === 1 ? "" : "s"})`,
              ),
            )}.`
          : "It has learned nothing yet on problems like this one.",
      );
    for (const l of lines) parts.push(el("p", l, "note"));
    parts.push(how("match", METHOD_MATCH));
  }

  if (transfer) {
    parts.push(el("h3", "Transfers"));
    parts.push(
      el(
        "p",
        `A new open problem starts from the best known packing with fewer pieces, the rest placed around it, when that is more than ${Math.round((1 - TRANSFER_MARGIN) * 100)} % smaller than the usual start.`,
        "note",
      ),
      how("transfers", TRANSFERS),
    );
  }
  body.replaceChildren(...parts);
}
