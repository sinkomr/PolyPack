export const SHAPE_NAMES: Record<number, string> = { 3: "triangle", 4: "square", 5: "pentagon", 6: "hexagon", 8: "octagon" };

export function shapeLabel(n: number): string {
  if (n === 0) return "circle";
  return SHAPE_NAMES[n] ?? `${n}-gon`;
}

/** Fills a select with circle and 3..20. */
export function fillShapeSelect(select: HTMLSelectElement, withOther: boolean): void {
  select.add(new Option("Circle", "0"));
  for (let n = 3; n <= 20; n++) select.add(new Option(SHAPE_NAMES[n] ? `${n} (${SHAPE_NAMES[n]})` : String(n), String(n)));
  if (withOther) select.add(new Option("Other…", "other"));
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (className) e.className = className;
  return e;
}
