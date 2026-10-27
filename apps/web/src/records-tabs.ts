import { tabModel } from "./records-model";
import { el } from "./shapes-ui";

/**
 * The tabs at the head of the Records page and of the polygons' page (browse.html): a link per
 * dimension, and under the current one a link per kind when it has several. They are links, each
 * with an address of its own, so that a tab can be shared and the browser's Back button returns to
 * the last one.
 */
export function renderTabs(host: HTMLElement, current: string): void {
  const { dimensions, kinds } = tabModel(current);
  const list = (label: string, links: typeof dimensions, className: string) => {
    const nav = el("nav", "", className);
    nav.setAttribute("aria-label", label);
    for (const t of links) {
      const a = t.soon ? el("span", `${t.text} (coming soon)`, "soon") : el("a", t.text);
      if (a instanceof HTMLAnchorElement) a.href = t.href;
      if (t.current) a.setAttribute("aria-current", "page");
      nav.append(a);
    }
    return nav;
  };
  host.replaceChildren(list("Dimension", dimensions, "dim-tabs"));
  if (kinds.length) host.append(list("Kind", kinds, "kind-tabs"));
}
