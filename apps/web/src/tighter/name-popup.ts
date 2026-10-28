/**
 * The pop-up that offers the player a name of their own, shown once at the end of the tutorial
 * (and from Settings). Every player starts with a generated name, "TighterGamePlayer" and seven
 * digits, and sends their records under it until they choose another.
 *
 * The page (main.ts) binds the game's name to it once at start-up; the tutorial only calls
 * showNamePopup().
 */
import { MAX_NAME_LENGTH, sanitizeName } from "./names";

/** What the pop-up needs of the game: the current name, and what to do when it changes. */
export interface NameBinding {
  get(): string;
  set(name: string): void;
}

let binding: NameBinding | null = null;

export function bindNamePopup(b: NameBinding): void {
  binding = b;
}

export interface NameChoice {
  /** The name to keep: the typed one cleaned as the server stores it, or the current one. */
  name: string;
  /** Whether it differs from the current name. */
  changed: boolean;
  /** Why the typed text was not taken (null: it was taken, or nothing was typed). */
  problem: string | null;
}

/** Empty or invalid input keeps the current name. */
export function chooseName(typed: string, current: string): NameChoice {
  const name = sanitizeName(typed);
  if (name) return { name, changed: name !== current, problem: null };
  return {
    name: current,
    changed: false,
    problem: typed.trim()
      ? "Nothing is left of that name once angle brackets and control characters are removed. Your name stays the same."
      : null,
  };
}

let open: Promise<void> | null = null;

/** Opens the pop-up and resolves when it closes. A second call while it is open returns the same promise. */
export function showNamePopup(): Promise<void> {
  if (open) return open;
  const b = binding;
  if (!b || typeof document === "undefined") return Promise.resolve();
  const dialog = document.createElement("dialog");
  dialog.id = "t-name-popup";
  dialog.className = "t-dialog t-name";
  dialog.setAttribute("aria-labelledby", "t-name-popup-title");
  dialog.innerHTML = `
    <div class="t-dialog-head"><h2 id="t-name-popup-title">Your name</h2></div>
    <form class="t-dialog-body" method="dialog">
      <p class="note">
        Your records go to PolyPack's public record tables under this name. You can change it later in Settings.
      </p>
      <div class="row">
        <label for="t-name-input">Name</label>
        <input id="t-name-input" maxlength="${MAX_NAME_LENGTH}" autocomplete="nickname" />
      </div>
      <p id="t-name-problem" class="note" role="status"></p>
      <div class="row wrap t-pop-actions">
        <button id="t-name-cancel" type="button">Keep my name</button>
        <button id="t-name-save" type="submit" class="primary">Save</button>
      </div>
    </form>`;
  const input = dialog.querySelector<HTMLInputElement>("#t-name-input")!;
  const problem = dialog.querySelector<HTMLElement>("#t-name-problem")!;
  input.value = b.get();
  open = new Promise<void>((resolve) => {
    dialog.addEventListener("close", () => {
      dialog.remove();
      open = null;
      resolve();
    });
  });
  dialog.querySelector("form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const choice = chooseName(input.value, b.get());
    if (choice.problem) {
      problem.textContent = choice.problem;
      input.focus();
      return;
    }
    if (choice.changed) b.set(choice.name);
    dialog.close();
  });
  dialog.querySelector("#t-name-cancel")!.addEventListener("click", () => dialog.close());
  (document.getElementById("t-settings")?.parentElement ?? document.body).append(dialog);
  dialog.showModal();
  input.select();
  return open;
}
