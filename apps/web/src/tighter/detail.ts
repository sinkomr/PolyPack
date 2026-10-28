import { How, renderHow } from "./how";

/**
 * The small "More detail" button and its pop-up. The pop-up is one shared modal dialog: it holds the
 * plain sentences of a How (no formulas; those are on the Mechanics page), closes with Escape, the
 * Close button or a press outside it, and gives focus back to the button that opened it.
 */

/** The button's accessible name: it says which thing it explains. */
export function detailLabel(title: string): string {
  return `More detail: ${title}`;
}

let dialog: HTMLDialogElement | null = null;
let body: HTMLElement;
let heading: HTMLElement;
let opener: HTMLElement | null = null;
let openerTitle = "";

function ensureDialog(): HTMLDialogElement {
  if (dialog) return dialog;
  const d = document.createElement("dialog");
  d.className = "t-dialog t-detail-dialog";
  d.setAttribute("aria-labelledby", "t-detail-heading");
  const head = document.createElement("div");
  head.className = "t-dialog-head";
  heading = document.createElement("h2");
  heading.id = "t-detail-heading";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.setAttribute("aria-label", "Close more detail");
  close.addEventListener("click", () => d.close());
  head.append(heading, close);
  body = document.createElement("div");
  body.className = "t-dialog-body";
  d.append(head, body);
  // a press on the backdrop (outside the box) closes it
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  });
  d.addEventListener("close", () => {
    // a rebuild of the panel may have replaced the button: find its successor by title
    const back =
      opener && opener.isConnected
        ? opener
        : Array.from(document.querySelectorAll<HTMLElement>("button.t-more-detail")).find(
            (b) => b.dataset.detail === openerTitle,
          );
    opener = null;
    back?.focus();
  });
  document.body.append(d);
  dialog = d;
  return d;
}

/** Opens the pop-up with the paragraphs of one or more Hows; `from` gets focus back when it closes. */
export function openDetail(title: string, hows: How | readonly How[], from: HTMLElement | null = null): void {
  const d = ensureDialog();
  heading.textContent = title;
  body.replaceChildren(...(Array.isArray(hows) ? (hows as readonly How[]) : [hows as How]).map((h) => renderHow(h)));
  opener = from;
  openerTitle = title;
  if (d.open) return;
  if (typeof d.showModal === "function") d.showModal();
  else d.setAttribute("open", "");
}

/** A "More detail" button for a How (or a list of them) about the thing named `title`. */
export function moreDetail(hows: How | readonly How[], title: string, className = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `t-more-detail ${className}`.trim();
  b.textContent = "More detail";
  b.dataset.detail = title;
  b.setAttribute("aria-haspopup", "dialog");
  b.setAttribute("aria-label", detailLabel(title));
  b.addEventListener("click", () => openDetail(title, hows, b));
  return b;
}
