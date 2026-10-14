import { Container, PackingConfig, parseConfig } from "@polypack/geometry";
import type { Result } from "@polypack/solver";
import { Board } from "./board";
import { Attribution, HAND, RunInfo, attributionAfter, readRun } from "./found-with";
import { BoardView } from "./view";
import { ParameterError, parameterForm } from "./solve-params";
import type { SolveMethod, SolveRequest, SolveResponse } from "./solve-protocol";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const names: Record<string, string> = {
  basin_hopping: "Basin hopping",
  penalty: "Penalty / augmented Lagrangian",
  mc_compress: "Monte Carlo compression",
  asc: "Adaptive shrinking container",
  ls_growth: "Lubachevsky–Stillinger growth",
  morph: "Shape continuation",
  harden: "Soft-to-rigid hardening, after Yohei Nakajima",
  seed: "Lattice & symmetry seeds",
  polish: "Contact polish",
};
const order = Object.keys(names);
const descriptions: Record<string, string> = {
  basin_hopping:
    "Perturbs and improves a packing repeatedly to escape local minima. A useful starting choice for polygons.",
  penalty: "Compresses the packing with continuous optimization, then refines its contacts.",
  mc_compress: "Tries small random moves while gradually shrinking the container.",
  asc: "Adjusts the pieces and container together to find a tighter packing.",
  ls_growth:
    "Moves and grows pieces until they settle into contact. Circle collisions are event-driven; polygon dynamics are approximate.",
  morph: "Starts with rounded pieces and gradually changes them to the chosen shape.",
  harden:
    "Soft-to-rigid hardening, after Yohei Nakajima: squeezes soft inscribed disks together, hardens them into the true shapes and keeps the best of several seeded runs.",
  seed: "Generates arrangements from lattices, rings, rows, or an adjacent record.",
  polish: "Fine-tunes the contacts and positions in a complete packing.",
};
interface Candidate {
  config: PackingConfig;
  container: Container;
  score: number;
}
type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const ACCEPTED_KEY = "polypack.solve.accepted";
const ACCEPTED_LIMIT = 20;
/** Edited optimizer boards, by a hash of the board: what undo and a reload return to. */
const LINEAGE_KEY = "polypack.solve.lineage";
const LINEAGE_LIMIT = 100;

/** A short hash of a board fingerprint (cyrb53), so that the lineage stays small in storage. */
function hashBoard(text: string): string {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const FOUND_TEXT: Record<Attribution["found_with"], string> = {
  hand: "Found by hand.",
  optimizer: "Found with the PolyPack optimizer; its method and settings are sent with the entry.",
  optimizer_edited:
    "Found with the PolyPack optimizer, then edited by hand; the method and settings are sent with the entry.",
};

/** Owns one worker job and a read-only preview. Board edits invalidate the whole job. */
export class SolvePanel {
  private worker?: Worker;
  private methods: SolveMethod[] = [];
  private ready = false;
  private nextId = 0;
  private activeId: number | null = null;
  private state: "idle" | "running" | "pausing" | "paused" | "stopping" = "idle";
  private readParams: () => Record<string, unknown> = () => ({});
  private candidate: Candidate | null = null;
  private fingerprint: string;
  private savedCamera: BoardView["cam"] | null = null;
  private stopTimer = 0;
  private trace: [number, number][] = [];
  private request?: Extract<SolveRequest, { type: "run" }>;
  private result: Result | null = null;
  private accepting = false;
  // How the board was found is a function of the board and its lineage (see attributionAfter):
  // every accepted result's fingerprint maps to its run, oldest first, and the hashes of boards
  // edited from one map to that run. Both survive undo history and reloads.
  private accepted = new Map<string, RunInfo>();
  private lineage = new Map<string, Attribution>();
  /** The attribution of the board `board`; `hash` is set once an edited board is remembered. */
  private attribution: { board: string; value: Attribution; hash: string | null } = {
    board: "",
    value: HAND,
    hash: null,
  };
  private rejected: HTMLElement | null = null;
  private restarting = false;

  get lastResult(): Result | null {
    return this.result;
  }

  /** How the board's current pieces were found, for the submission. */
  get foundWith(): Attribution {
    return this.attribution.value;
  }

  constructor(
    private board: Board,
    private view: BoardView,
    private say: (message: string) => void,
  ) {
    this.fingerprint = JSON.stringify(board.toConfig());
    $("solve-form").addEventListener("submit", (e) => {
      e.preventDefault();
      this.start();
    });
    $("solve-method").addEventListener("change", () => this.methodChanged());
    $("solve-start").addEventListener("change", () => this.updateButtons());
    $("solve-budget").addEventListener("change", () => this.updateButtons());
    $("solve-time").addEventListener("input", () => {
      $("solve-time-value").textContent = `${$<HTMLInputElement>("solve-time").value} s`;
    });
    $("solve-pause").addEventListener("click", () => this.pause());
    $("solve-stop").addEventListener("click", () => this.stop());
    $("solve-accept").addEventListener("click", () => this.accept());
    $("solve-dismiss").addEventListener("click", () => this.dismiss());
    $("solve-download").addEventListener("click", () => this.download());
    board.onChange(() => this.boardChanged());
    window.addEventListener("pagehide", () => {
      this.worker?.terminate();
      clearTimeout(this.stopTimer);
    });
    this.loadAccepted();
    // the board was restored from storage or a link before the panel existed
    this.trackAttribution(this.fingerprint, "history");
    this.createWorker();
    this.updateButtons();
  }

  private createWorker(): void {
    this.ready = false;
    this.worker = undefined;
    try {
      const worker = new Worker(new URL("./solve-worker.ts", import.meta.url), { type: "module" });
      this.worker = worker;
      worker.onmessage = (e: MessageEvent<SolveResponse>) => {
        if (worker === this.worker) this.receive(e.data);
      };
      // A failed worker is discarded; the next Run creates a fresh one (see start).
      const failed = (reason: string) => {
        if (worker !== this.worker) return;
        worker.terminate();
        this.worker = undefined;
        this.ready = false;
        const running = this.activeId !== null;
        this.finish();
        // A result that was already complete does not depend on the worker and stays available.
        if (running) {
          this.clearPreview();
          this.candidate = null;
          $("solve-score").textContent = "—";
        }
        this.status(
          `Optimizer failed${running ? " during the run" : ""}: ${reason}. ${running ? "The run was cancelled. " : ""}Run again to restart it.`,
        );
        this.updateButtons();
      };
      worker.onerror = (e) => {
        e.preventDefault();
        failed(e.message || "worker error");
      };
      worker.onmessageerror = () => failed("a message from the optimizer could not be read");
    } catch (error) {
      this.status(`Optimizer unavailable: ${String(error)}. Run again to retry.`);
    }
  }

  private methodChanged(): void {
    const method = this.methods.find((m) => m.name === $<HTMLSelectElement>("solve-method").value);
    if (!method) return;
    $("solve-description").textContent = descriptions[method.name] ?? method.schema.description ?? "";
    $("solve-method").title = names[method.name] ?? method.name;
    this.readParams = parameterForm($("solve-params"), method.schema, method.defaults);
    this.updateButtons();
  }

  private status(text: string): void {
    $("solve-status").textContent = text;
  }

  private updateButtons(): void {
    const busy = this.activeId !== null;
    $<HTMLFieldSetElement>("solve-settings").disabled = busy;
    $<HTMLSelectElement>("solve-method").disabled = busy || !this.methods.length;
    // Without a worker (it failed), Run stays available to start a fresh one.
    $<HTMLButtonElement>("solve-run").disabled = busy || (!!this.worker && !this.ready);
    $<HTMLButtonElement>("solve-pause").disabled = !busy || this.state === "stopping" || this.state === "pausing";
    $("solve-pause").textContent = this.state === "paused" ? "Resume" : "Pause";
    $<HTMLButtonElement>("solve-stop").disabled = !busy || this.state === "stopping";
    $<HTMLButtonElement>("solve-accept").disabled = busy || !this.candidate;
    $<HTMLButtonElement>("solve-dismiss").disabled = busy || !this.savedCamera;
    $<HTMLButtonElement>("solve-download").disabled = busy || (!this.result && !this.candidate);
    $<HTMLInputElement>("solve-time").disabled = busy || $<HTMLSelectElement>("solve-budget").value === "evals";
    const complete = this.board.state.pieces.length === this.board.state.P;
    const mode = $<HTMLSelectElement>("solve-start").value;
    $("solve-start-note").textContent =
      mode === "board" || (mode === "auto" && complete)
        ? complete
          ? "Improve your complete board; it stays unchanged until you accept."
          : "Place exactly P pieces to use the current board."
        : "Generate a new arrangement for this problem. Your board stays unchanged.";
  }

  /** Show a rejected setting: a control inside closed <details> can neither take focus nor show a bubble. */
  private reveal(control: HTMLElement): void {
    for (let d = control.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
    this.clearRejected();
    this.rejected = control;
    control.setAttribute("aria-invalid", "true");
    control.addEventListener("input", () => control === this.rejected && this.clearRejected(), { once: true });
    control.focus();
  }

  private clearRejected(): void {
    this.rejected?.removeAttribute("aria-invalid");
    this.rejected = null;
  }

  /** Why a control failed native validation, in the panel's words rather than the browser's locale. */
  private problem(control: Control): string {
    const name = (control.closest("label")?.querySelector("span") ?? control.labels?.[0])?.textContent ?? "A setting";
    const v = control.validity,
      input = control as HTMLInputElement;
    if (v.badInput) return `${name}: enter a valid number.`;
    if (v.valueMissing) return `${name}: enter a value; this setting cannot be left empty.`;
    if (v.rangeUnderflow) return `${name}: must be at least ${input.min}.`;
    if (v.rangeOverflow) return `${name}: must be at most ${input.max}.`;
    if (v.stepMismatch) return `${name}: enter a whole number.`;
    return `${name}: ${control.validationMessage}`;
  }

  private start(): void {
    if (this.activeId !== null || (this.worker && !this.ready)) return;
    if (!this.worker) {
      this.createWorker();
      this.updateButtons();
      if (!this.worker) return;
      if (!this.methods.length) {
        // The first worker never listed its methods; they arrive with this one's ready message.
        this.restarting = true;
        this.status("Restarting the optimizer…");
        return;
      }
    }
    // The form is novalidate: the browser's own check before submit cannot focus a control
    // inside closed <details> and would silently swallow the click.
    const form = $<HTMLFormElement>("solve-form");
    const invalid = (Array.from(form.elements) as Control[]).find((c) => c.willValidate && !c.checkValidity());
    if (invalid) {
      this.reveal(invalid);
      this.status(`${this.problem(invalid)} Nothing was run.`);
      invalid.reportValidity();
      return;
    }
    this.clearRejected();
    try {
      const config = this.board.toConfig();
      const complete = config.pieces.length === config.P;
      const mode = $<HTMLSelectElement>("solve-start").value;
      const method = $<HTMLSelectElement>("solve-method").value;
      if ((mode === "board" || method === "polish") && !complete)
        throw new Error("Place exactly P pieces before using the current board or contact polish.");
      if (method === "polish" && mode === "scratch")
        throw new Error("Contact polish needs a current board. Choose Board if complete or Current board.");
      const evals = Number($<HTMLInputElement>("solve-evals").value);
      const seed = Number($<HTMLInputElement>("solve-seed").value);
      if (
        !Number.isSafeInteger(evals) ||
        evals < 1 ||
        evals > 1000000 ||
        !Number.isInteger(seed) ||
        seed < 0 ||
        seed > 0xffffffff
      )
        throw new Error("Enter valid evaluation and seed limits.");
      const params = this.readParams();
      this.request = {
        type: "run",
        id: ++this.nextId,
        problem: { N: config.N, M: config.M, P: config.P },
        method,
        params,
        seed,
        budget: {
          evals,
          ...($<HTMLSelectElement>("solve-budget").value === "both"
            ? { time_s: Number($<HTMLInputElement>("solve-time").value) }
            : {}),
        },
        ...(mode === "board" || (mode === "auto" && complete) ? { start: config } : {}),
      };
      this.clearPreview();
      this.candidate = null;
      this.result = null;
      this.trace = [];
      this.drawTrace();
      this.activeId = this.request.id;
      this.state = "running";
      this.fingerprint = JSON.stringify(config);
      $("solve-score").textContent = "—";
      $("solve-progress").textContent = "Starting…";
      this.status(`Running ${names[method] ?? method}…`);
      this.updateButtons();
      // A fresh worker queues this until its script has loaded.
      this.worker!.postMessage(this.request);
    } catch (error) {
      if (error instanceof ParameterError && error.control) this.reveal(error.control);
      this.status(
        (error instanceof Error ? error.message : String(error)) +
          (error instanceof ParameterError ? " Nothing was run." : ""),
      );
    }
  }

  private receive(message: SolveResponse): void {
    if (message.type === "ready") {
      this.ready = true;
      if (!this.methods.length) {
        this.methods = message.methods
          .filter((m) => m.name !== "identity")
          .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
        const select = $<HTMLSelectElement>("solve-method");
        select.replaceChildren();
        for (const method of this.methods) {
          const option = document.createElement("option");
          option.value = method.name;
          option.textContent = names[method.name] ?? method.schema.title ?? method.name;
          select.append(option);
        }
        this.methodChanged();
      }
      if (this.restarting) {
        // Run was pressed before any method could be chosen, so nothing is started on its behalf.
        this.restarting = false;
        this.status("Optimizer ready. Choose a method, then run.");
      }
      this.updateButtons();
      return;
    }
    if (message.id !== this.activeId) return;
    if (message.type === "control") {
      if (this.state === "stopping" && message.state !== "stopping") return;
      this.state = message.state;
      this.status(
        message.state === "paused"
          ? "Paused. Resume or stop to keep the best result."
          : message.state === "stopping"
            ? "Stopping; keeping the best result…"
            : "Running…",
      );
      this.updateButtons();
    } else if (message.type === "progress") {
      $("solve-progress").textContent =
        `${message.frame.evaluations.toLocaleString()} evaluations · ${message.frame.elapsed.toFixed(1)} s`;
      if (message.preview && message.previewContainer)
        this.showCandidate(message.preview, message.previewContainer, message.frame.elapsed);
    } else if (message.type === "result") {
      this.result = message.result;
      this.finish();
      const r = message.result;
      this.candidate = null;
      if (r.valid && r.strict && r.best && r.container && r.score !== null)
        this.showCandidate(r.best, r.container, r.wallTime);
      else {
        this.clearPreview();
        $("solve-score").textContent = "—";
      }
      $("solve-progress").textContent = `${r.evaluations.toLocaleString()} evaluations · ${r.wallTime.toFixed(1)} s`;
      const ending =
        r.termination === "time"
          ? "Time limit reached"
          : r.termination === "evals"
            ? "Evaluation limit reached"
            : r.termination === "aborted"
              ? "Stopped"
              : r.termination === "error"
                ? "Method ended with an error"
                : "Finished";
      this.status(
        `${ending}. ${this.candidate ? "Accept result to put it on your board." : "No strict valid result available."}${r.reasons.length ? " " + r.reasons.join("; ") : ""}`,
      );
      this.updateButtons();
    } else if (message.type === "error") {
      this.finish();
      this.candidate = null;
      this.clearPreview();
      $("solve-score").textContent = "—";
      this.status(message.message);
      this.updateButtons();
    }
  }

  private showCandidate(config: PackingConfig, container: Container, elapsed: number): void {
    const problem = this.request?.problem;
    const parsed = parseConfig(config);
    if (
      !parsed.ok ||
      !problem ||
      config.N !== problem.N ||
      config.M !== problem.M ||
      config.P !== problem.P ||
      config.pieces.length !== problem.P ||
      !Number.isFinite(container.size)
    )
      return;
    this.candidate = { config: structuredClone(parsed.config), container: { ...container }, score: container.size };
    const first = !this.savedCamera;
    if (first) this.savedCamera = { ...this.view.cam };
    this.view.setPreview(this.candidate.config, this.candidate.container);
    if (first) this.view.fit();
    $("solve-score").textContent = container.size.toFixed(6);
    const last = this.trace[this.trace.length - 1],
      previous = this.trace[this.trace.length - 2];
    if (last && previous && last[1] === container.size && previous[1] === container.size) last[0] = elapsed;
    else this.trace.push([elapsed, container.size]);
    if (this.trace.length > 2000) this.trace = this.trace.filter((_, i) => i % 2 === 0 || i === this.trace.length - 1);
    this.drawTrace();
  }

  private pause(): void {
    if (this.activeId === null || this.state === "stopping" || this.state === "pausing") return;
    const resume = this.state === "paused";
    if (!resume) this.state = "pausing";
    this.worker?.postMessage({ type: resume ? "resume" : "pause", id: this.activeId } satisfies SolveRequest);
    this.updateButtons();
  }

  private stop(): void {
    if (this.activeId === null || this.state === "stopping") return;
    this.state = "stopping";
    this.status("Stopping; keeping the best result…");
    this.worker?.postMessage({ type: "stop", id: this.activeId } satisfies SolveRequest);
    // A worker can be terminated even during an atomic scoring call. Keep only the last
    // strict preview if the cooperative stop has not answered in one second.
    this.stopTimer = window.setTimeout(() => {
      this.worker?.terminate();
      this.finish();
      this.createWorker();
      this.status(
        this.candidate
          ? "Stopped. The best received preview is available to accept."
          : "Stopped before a strict valid result was received.",
      );
      this.updateButtons();
    }, 1000);
    this.updateButtons();
  }

  private finish(): void {
    clearTimeout(this.stopTimer);
    this.stopTimer = 0;
    this.activeId = null;
    this.state = "idle";
  }

  private clearPreview(): void {
    this.view.setPreview(null);
    if (this.savedCamera) {
      this.view.cam = this.savedCamera;
      this.savedCamera = null;
      this.view.requestDraw();
    }
  }

  private dismiss(): void {
    if (this.activeId === null) {
      this.clearPreview();
      this.updateButtons();
    }
  }

  private download(): void {
    if (this.activeId !== null || !this.request || (!this.result && !this.candidate)) return;
    const data = {
      ...(this.result?.best ?? this.candidate?.config),
      solver: {
        request: this.request,
        result: this.result,
        ...(this.result ? {} : { stoppedPreview: this.candidate }),
        environment: "browser",
        downloadedAt: new Date().toISOString(),
      },
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `polypack-${this.request.method}-seed${this.request.seed}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  private accept(): void {
    const before = JSON.stringify(this.board.toConfig());
    if (this.activeId !== null || !this.candidate || before !== this.fingerprint) return;
    this.accepting = true;
    this.clearPreview();
    const error = this.board.load(this.candidate.config);
    this.accepting = false;
    const after = JSON.stringify(this.board.toConfig());
    if (error) {
      this.candidate = null;
      this.status(`Result could not be accepted: ${error}.`);
    } else if (after === before) {
      // Nothing was placed, so the board keeps whatever attribution it already had.
      this.candidate = null;
      this.status("The result is identical to your board; nothing changed.");
    } else {
      this.view.fit();
      this.candidate = null;
      if (this.request)
        this.remember(after, {
          method: this.request.method,
          // the resolved parameters; a preview kept after a forced stop has only the requested ones
          params: structuredClone(this.result?.params ?? this.request.params),
          seed: this.request.seed,
          budget: { ...this.request.budget },
        });
      this.trackAttribution(after, "load", true);
      this.status("Result accepted. Undo returns to your previous board; you can edit or submit this packing.");
      this.say("Optimizer result accepted. Undo returns to your previous board.");
    }
    this.fingerprint = after;
    this.updateButtons();
  }

  private loadAccepted(): void {
    // Unavailable or malformed storage only loses attribution of earlier sessions.
    for (const [key, map, limit] of [
      [ACCEPTED_KEY, this.accepted, ACCEPTED_LIMIT],
      [LINEAGE_KEY, this.lineage, LINEAGE_LIMIT],
    ] as const)
      try {
        const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
        if (!Array.isArray(stored)) continue;
        for (const entry of stored.slice(-limit)) {
          if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
          // accepted results map to a run (older pages stored a note), edited boards to an attribution
          if (map === this.accepted) {
            const run = readRun(entry[1]);
            if (run) this.accepted.set(entry[0], run);
          } else {
            const run = entry[1]?.found_with === "optimizer_edited" ? readRun(entry[1].run) : undefined;
            if (run) this.lineage.set(entry[0], { found_with: "optimizer_edited", run });
          }
        }
      } catch {
        // see above
      }
  }

  /** Newest last, within `limit`: the oldest entries are dropped first. */
  private store<T>(key: string, map: Map<string, T>, limit: number, id: string, value: T): void {
    map.delete(id);
    map.set(id, value);
    for (const oldest of map.keys()) {
      if (map.size <= limit) break;
      map.delete(oldest);
    }
    try {
      localStorage.setItem(key, JSON.stringify([...map]));
    } catch {
      // Storage may be full or disabled; attribution still works for this session.
    }
  }

  /** Record an accepted solver board. */
  private remember(board: string, run: RunInfo): void {
    this.store(ACCEPTED_KEY, this.accepted, ACCEPTED_LIMIT, board, run);
  }

  /**
   * Decide how the board `current` was found after a change of the given kind. A change that
   * leaves the board as it was (a selection, say) keeps its attribution, unless `force`.
   */
  private trackAttribution(current: string, change: Board["lastChange"], force = false): void {
    if (this.attribution.board !== current || force) {
      const value = attributionAfter({
        change,
        previous: this.attribution.value,
        accepted: this.accepted.get(current),
        recorded: this.lineage.get(hashBoard(current)),
        empty: this.board.state.pieces.length === 0,
      });
      this.attribution = { board: current, value, hash: null };
      $("found-with").textContent = FOUND_TEXT[value.found_with];
    }
    // Edited boards are remembered so that undo and a reload return to them as edited. Only boards
    // that end a gesture can be returned to, so the intermediate steps of a drag are not kept; the
    // end of a gesture often leaves the board as its last step did, which is why this is checked on
    // every change. Exact results need no entry: they are recognised from the accepted results.
    const a = this.attribution;
    if (a.value.found_with === "optimizer_edited" && a.hash === null && !this.board.gesturing) {
      a.hash = hashBoard(current);
      if (this.lineage.get(a.hash)?.found_with !== "optimizer_edited")
        this.store(LINEAGE_KEY, this.lineage, LINEAGE_LIMIT, a.hash, a.value);
    }
  }

  private boardChanged(): void {
    const current = JSON.stringify(this.board.toConfig());
    this.trackAttribution(current, this.board.lastChange);
    if (!this.accepting && current !== this.fingerprint && (this.activeId !== null || this.candidate)) {
      this.worker?.terminate();
      this.finish();
      this.candidate = null;
      this.result = null;
      this.clearPreview();
      this.createWorker();
      this.status("Board changed. The solver run and its preview were cleared.");
    }
    this.fingerprint = current;
    this.updateButtons();
  }

  private drawTrace(): void {
    const svg = $("solve-trace") as unknown as SVGSVGElement;
    svg.replaceChildren();
    svg.toggleAttribute("hidden", !this.trace.length);
    if (!this.trace.length) return;
    const end = Math.max(0.01, this.trace[this.trace.length - 1][0]);
    const low = Math.min(...this.trace.map((p) => p[1])),
      high = Math.max(...this.trace.map((p) => p[1]));
    const range = high - low || Math.max(0.001, high * 0.01);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute(
      "points",
      this.trace.map(([t, score]) => `${10 + (280 * t) / end},${10 + (65 * (high - score)) / range}`).join(" "),
    );
    svg.append(line);
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", "10");
    text.setAttribute("y", "92");
    text.textContent = `${high.toFixed(6)} → ${low.toFixed(6)} · ${end.toFixed(1)} s`;
    svg.append(text);
    svg.setAttribute(
      "aria-label",
      `Best solver score from ${high.toFixed(6)} to ${low.toFixed(6)} over ${end.toFixed(1)} seconds`,
    );
  }
}
