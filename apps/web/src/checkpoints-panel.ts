import { Board } from "./board";
import { BoardView } from "./view";
import {
  Checkpoint,
  Checkpoints,
  checkpointBoard,
  formatBytes,
  idbCheckpointStore,
  makeCheckpoint,
  problemKey,
} from "./checkpoints";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function linkButton(text: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "linkish";
  b.textContent = text;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", onClick);
  return b;
}

/**
 * The Checkpoints section of the board's panel (checkpoints.ts): save the board under a name, list this problem's
 * checkpoints to load or delete, and an overview of every problem with checkpoints, to clear out old ones.
 */
export class CheckpointsPanel {
  private shownKey = "";
  private shownVersion = -1;
  private ready = false;
  /** Saves still being written, so that unnamed ones saved in quick succession get numbers of their own. */
  private saving = 0;

  constructor(
    private board: Board,
    private view: BoardView,
    private say: (msg: string) => void,
    private cps = new Checkpoints(idbCheckpointStore()),
  ) {
    $("checkpoint-save").addEventListener("click", () => void this.save());
    $("checkpoint-name").addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.save();
    });
    $("checkpoint-delete-all").addEventListener("click", () => void this.deleteAll());
    board.onChange(() => this.render());
    // another tab may have saved or deleted some
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.reload();
    });
    void this.reload();
  }

  private async reload(): Promise<void> {
    const ok = await this.cps.reload();
    this.ready = true;
    this.render(true);
    if (!ok) this.note("The saved checkpoints could not be read from this browser's storage.", true);
  }

  private note(text: string, bad = false): void {
    const el = $("checkpoint-note");
    el.className = bad ? "note bad" : "note";
    el.textContent = text;
  }

  private get key(): string {
    return problemKey(this.board.state);
  }

  private async save(): Promise<void> {
    const s = this.board.state;
    if (!s.pieces.length) return this.note("Place some pieces first: an empty board isn't worth a checkpoint.", true);
    // The name is taken and the field cleared now, not after the write: a name typed for the next checkpoint while
    // this one is being written must not be wiped.
    const input = $<HTMLInputElement>("checkpoint-name");
    const typed = input.value;
    input.value = "";
    const name = typed.trim() || `Checkpoint ${this.cps.forProblem(this.key).length + this.saving + 1}`;
    const c = makeCheckpoint(this.board.toConfig(), name);
    this.saving++;
    try {
      await this.cps.add(c);
    } catch {
      if (!input.value) input.value = typed; // give the name back, unless another has been typed since
      return this.note("The checkpoint could not be saved: this browser's storage refused it (it may be full).", true);
    } finally {
      this.saving--;
    }
    this.say(`Saved checkpoint “${c.name}”.`);
    this.render(true);
  }

  private load(c: Checkpoint): void {
    const r = checkpointBoard(c);
    const err = r.ok ? this.board.load(r.config) : r.error;
    if (err) return this.note(`That checkpoint could not be loaded: ${err}.`, true);
    this.view.fit();
    this.say(`Loaded checkpoint “${c.name}”. Undo returns to your board.`);
  }

  /** Runs a deletion, then says what went. */
  private async remove(run: () => Promise<number>, what: string): Promise<void> {
    try {
      await run();
    } catch {
      return this.note("Nothing was deleted: this browser's storage refused it.", true);
    }
    this.say(`Deleted ${what}.`);
    this.render(true);
  }

  private async deleteProblem(key: string): Promise<void> {
    const n = this.cps.forProblem(key).length;
    const what = `${n} checkpoint${n === 1 ? "" : "s"} of ${key}`;
    if (!confirm(`Delete ${what}? This can't be undone.`)) return;
    await this.remove(() => this.cps.removeProblem(key), what);
  }

  private async deleteAll(): Promise<void> {
    const n = this.cps.size;
    if (!n) return;
    if (!confirm(`Delete every checkpoint, ${n} in all (${formatBytes(this.cps.bytes)})? This can't be undone.`))
      return;
    await this.remove(() => this.cps.removeAll(), `all ${n} checkpoints`);
  }

  /** Draws the section again when the problem, the checkpoints or (`force`) anything else changed. */
  render(force = false): void {
    const key = this.key;
    $<HTMLButtonElement>("checkpoint-save").disabled = !this.ready || this.board.state.pieces.length === 0;
    if (!force && key === this.shownKey && this.cps.version === this.shownVersion) return;
    this.shownKey = key;
    this.shownVersion = this.cps.version;
    this.renderList(key);
    this.renderOverview(key);
  }

  private renderList(key: string): void {
    const list = $("checkpoint-list");
    list.replaceChildren();
    const P = this.board.state.P;
    for (const c of this.cps.forProblem(key)) {
      const li = document.createElement("li");
      const head = document.createElement("span");
      head.className = "checkpoint-head";
      const score = document.createElement("b");
      score.textContent = c.score !== null ? c.score.toFixed(6) : `${c.placed} / ${P} pieces`;
      head.append(score, ` — ${c.name}`);
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.append(
        `${when(c.savedAt)} · ${formatBytes(c.bytes)} · `,
        linkButton("load", `Load the checkpoint ${c.name}`, () => this.load(c)),
        " · ",
        linkButton(
          "delete",
          `Delete the checkpoint ${c.name}`,
          () => void this.remove(() => this.cps.remove([c.id]), `“${c.name}”`),
        ),
      );
      li.append(head, meta);
      list.append(li);
    }
    const here = this.cps.forProblem(key).length;
    if (!this.cps.persistent)
      this.note("This browser has no storage for them here, so checkpoints last only until the page is closed.");
    else
      this.note(
        here
          ? "Kept in this browser only. Loading one replaces the board; Undo brings it back."
          : `No checkpoints for ${key} yet. Save the board to come back to it later; they are kept in this browser only.`,
      );
  }

  private renderOverview(key: string): void {
    const summary = this.cps.summary();
    const all = $<HTMLDetailsElement>("checkpoint-all");
    all.hidden = summary.length === 0;
    $("checkpoint-all-summary").textContent =
      `All checkpoints: ${this.cps.size} on ${summary.length} problem${summary.length === 1 ? "" : "s"}, ${formatBytes(this.cps.bytes)}`;
    const body = $("checkpoint-table-body");
    body.replaceChildren();
    for (const s of summary) {
      const tr = document.createElement("tr");
      if (s.key === key) tr.className = "current";
      const cell = (text: string, numeric = false) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (numeric) td.className = "num";
        tr.append(td);
      };
      cell(s.key);
      cell(String(s.count), true);
      cell(s.best !== null ? s.best.toFixed(6) : "—", true);
      cell(formatBytes(s.bytes), true);
      tr.title = `Last saved ${when(s.newest)}`;
      const actions = document.createElement("td");
      const best = this.cps.forProblem(s.key)[0];
      actions.append(
        linkButton("load best", `Load the best checkpoint of ${s.key}`, () => this.load(best)),
        " · ",
        linkButton("delete", `Delete all checkpoints of ${s.key}`, () => void this.deleteProblem(s.key)),
      );
      tr.append(actions);
      body.append(tr);
    }
  }
}
