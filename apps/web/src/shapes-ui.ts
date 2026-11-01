export const SHAPE_NAMES: Record<number, string> = {
  3: "triangle",
  4: "square",
  5: "pentagon",
  6: "hexagon",
  8: "octagon",
};

export function shapeLabel(n: number): string {
  if (n === 0) return "circle";
  return SHAPE_NAMES[n] ?? `${n}-gon`;
}

export const shapePlural = (n: number) => `${shapeLabel(n)}s`;
/** "a square", "an octagon", "an 18-gon" */
export const withArticle = (n: number) =>
  `${/^(8|11|18)/.test(shapeLabel(n)) || shapeLabel(n) === "octagon" ? "an" : "a"} ${shapeLabel(n)}`;
/** A pair of shapes in words: "circles in a square" */
export const familyName = (N: number, M: number) => `${shapePlural(N)} in ${withArticle(M)}`;

/** Fills a select with circle and 3..max (20 unless given); each option keeps its plain text in data-label. */
export function fillShapeSelect(select: HTMLSelectElement, withOther: boolean, max = 20): void {
  const add = (text: string, value: string) => {
    const o = new Option(text, value);
    o.dataset.label = text;
    select.add(o);
  };
  add("Circle", "0");
  for (let n = 3; n <= max; n++) add(SHAPE_NAMES[n] ? `${n} (${SHAPE_NAMES[n]})` : String(n), String(n));
  if (withOther) select.add(new Option("Other…", "other"));
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (className) e.className = className;
  return e;
}
