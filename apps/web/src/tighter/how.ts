/**
 * "How it works": the detailed explanation behind a short description (an upgrade, a setting, a
 * panel). It says what happens in plain sentences, gives the rule as formulas, and defines every
 * variable the formulas use.
 *
 * Formulas and variable symbols are trusted markup written in this codebase, never player or
 * server text. Only <var>, <sub>, <sup>, <em>, <strong>, <code> and <br> are kept; any other tag
 * keeps its text and loses the tag.
 */
export interface How {
  /** What happens, in plain sentences (one or more paragraphs). */
  text: string | readonly string[];
  /** The rule as formulas, one per line, in markup such as `<var>r</var> = 2<sup><var>k</var></sup>`. */
  math?: readonly string[];
  /** Every variable in `math`: [symbol markup, what it is, with its units]. */
  vars?: readonly (readonly [string, string])[];
  /** A last note after the variables (limits, edge cases), in plain sentences. */
  note?: string;
}

/** A variable in How markup: sym("s", "ref") is s with the subscript "ref". */
export const sym = (name: string, sub?: string) => `<var>${name}</var>${sub === undefined ? "" : `<sub>${sub}</sub>`}`;
/** One entry of How's `vars`: [symbol markup, what it is]. */
export type Var = readonly [string, string];

const KEPT = new Set(["VAR", "SUB", "SUP", "EM", "STRONG", "CODE", "BR"]);

function copy(from: Node, to: Node): void {
  for (const n of Array.from(from.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE) to.appendChild(document.createTextNode(n.textContent ?? ""));
    else if (n.nodeType === Node.ELEMENT_NODE) {
      const tag = (n as Element).tagName;
      if (KEPT.has(tag)) {
        const e = document.createElement(tag.toLowerCase());
        copy(n, e);
        to.appendChild(e);
      } else copy(n, to);
    }
  }
}

/** Markup (see How) as DOM nodes, appended to `into`. */
export function markup(into: HTMLElement, source: string): HTMLElement {
  copy(new DOMParser().parseFromString(`<body>${source}</body>`, "text/html").body, into);
  return into;
}

/** Text of markup without its tags (for aria labels and tests). */
export function plain(source: string): string {
  return source.replace(/<[^>]*>/g, "");
}

/** The explanation as one block: paragraphs, then formulas, then "where" and the variables. */
export function renderHow(how: How, className = "t-how"): HTMLElement {
  const box = document.createElement("div");
  box.className = className;
  for (const t of typeof how.text === "string" ? [how.text] : how.text) {
    const p = document.createElement("p");
    p.textContent = t;
    box.append(p);
  }
  if (how.math?.length) {
    const m = document.createElement("div");
    m.className = "t-math";
    for (const line of how.math) m.append(markup(document.createElement("p"), line));
    box.append(m);
  }
  if (how.vars?.length) {
    const where = document.createElement("p");
    where.className = "t-where";
    where.textContent = "where";
    const dl = document.createElement("dl");
    dl.className = "t-vars";
    for (const [sym, meaning] of how.vars) {
      dl.append(markup(document.createElement("dt"), sym));
      const dd = document.createElement("dd");
      dd.textContent = meaning;
      dl.append(dd);
    }
    box.append(where, dl);
  }
  if (how.note) {
    const p = document.createElement("p");
    p.className = "t-how-note";
    p.textContent = how.note;
    box.append(p);
  }
  return box;
}

/**
 * A disclosure: the summary line always shows; "How it works" opens to the explanation. Used where
 * there is no hover (phones, the panels).
 */
export function howDisclosure(how: How, summary = "How it works"): HTMLDetailsElement {
  const d = document.createElement("details");
  d.className = "t-how-more";
  const s = document.createElement("summary");
  s.textContent = summary;
  d.append(s, renderHow(how));
  return d;
}
