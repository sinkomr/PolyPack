import { RunPlanState, addStage, learned, moveStage, removeStage, runsObserved } from "./runplan";
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

  if (pipes) {
    parts.push(el("h3", "Pipeline"));
    const list = el("ol", undefined, "t-pipeline");
    plan.pipeline.forEach((m, i) => {
      const li = el("li");
      const name = el("span", `${i + 1}. ${m}`, input.allowed(m) ? undefined : "t-refused");
      if (!input.allowed(m)) name.title = "This cycle's rule does not allow this method: the stage is skipped";
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
      const opt = el("option", m);
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
          ? "Each new seed on a problem runs the next stage, in a loop: a stage moves on when its run stops improving by itself. While the pipeline has stages, it chooses the method, not the toolbar."
          : "No stages: the toolbar's method runs. Add methods in the order you want successive seeds to run them.",
        "note",
      ),
    );
  }

  if (match) {
    parts.push(el("h3", o.has("autoTune") ? "Method match and Auto-tune" : "Method match"));
    const runs = runsObserved(plan);
    const lines: string[] = [
      `Learned from ${runs.toLocaleString("en-US")} run${runs === 1 ? "" : "s"}, in RP earned per evaluation. ` +
        (plan.auto
          ? `Auto is on: it picks the ${o.has("autoTune") ? "method and setting" : "method"} of each new run.`
          : `Choose Auto in the toolbar to let it pick${o.has("autoTune") ? " methods and settings" : ""}.`),
    ];
    if (input.focusKind)
      lines.push(
        top.length
          ? `On problems like this one: ${top
              .map(
                (t) =>
                  `${t.method}${t.level ? ` (setting ${t.level})` : ""} ${fmt(t.mean)} (${t.runs} run${t.runs === 1 ? "" : "s"})`,
              )
              .join("; ")}.`
          : "Nothing learned yet on problems like this one.",
      );
    for (const l of lines) parts.push(el("p", l, "note"));
  }

  if (transfer) {
    parts.push(el("h3", "Transfers"));
    parts.push(
      el(
        "p",
        "A new problem starts from the best known packing of a neighbour with fewer pieces (yours in the queue, or the site's record), the rest placed around it, when that is at least 2 % smaller than Load all. It is never sent unimproved.",
        "note",
      ),
    );
  }
  body.replaceChildren(...parts);
}
