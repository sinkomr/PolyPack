import { surfaceNofoldNote } from "./nofold";

/** Insert trusted record text as text nodes, with source links and working polygon-board links. */
export function renderNofoldNote(container: HTMLElement, id: string, drawableScore?: number, compact = false): void {
  const parts = surfaceNofoldNote(id, drawableScore, compact);
  container.hidden = parts.length === 0;
  container.replaceChildren(
    ...parts.map((part) => {
      if (typeof part === "string") return document.createTextNode(part);
      const a = document.createElement("a");
      a.textContent = part.text;
      a.href = part.href;
      return a;
    }),
  );
}
