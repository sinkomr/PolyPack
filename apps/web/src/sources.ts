import type { ListedRecord } from "./atlas-model";
import { el } from "./shapes-ui";

/**
 * Credit for the published record data. The values, the captions with their finder and prover
 * attributions, and some coordinates are taken from three compilations and from one paper's
 * supplement. Wherever such data is
 * shown, a numbered reference mark points to the note of its source; the notes are listed at the
 * foot of the records page. The numbers are fixed: they follow the order of this list.
 */
export interface Source {
  /** Note number, from 1. */
  n: number;
  author: string;
  /** Title of the site. `author, title` begins the `source_name` of every record taken from it. */
  title: string;
  url: string;
  /** What this site takes from the source. */
  takes: string;
}

export const SOURCES: readonly Source[] = [
  {
    n: 1,
    author: "Erich Friedman",
    title: "Packing Center",
    url: "https://erich-friedman.github.io/packing/",
    takes:
      "Record values and their captions, with the finder and prover attributions, for circles, triangles, squares, pentagons, hexagons and octagons packed in each of those shapes. Pictures are linked, not copied.",
  },
  {
    n: 2,
    author: "David Ellsworth",
    title: "Squares in Squares",
    url: "https://kingbird.myphotos.cc/packing/squares_in_squares.html",
    takes:
      "Record values and their captions, with the finder and prover attributions, for squares in a square, and the coordinates of most of those packings, read from its drawings. Pictures are linked, not copied.",
  },
  {
    n: 3,
    author: "Eckard Specht",
    title: "Packomania",
    url: "http://www.packomania.com/",
    takes: "Record values for equal circles in a circle and in a square, and the coordinates of those packings.",
  },
  {
    n: 4,
    author: "Berthold, Kamp, Mexi, Pokutta and Polik",
    title: "Packing Solutions",
    url: "https://github.com/DominikKamp/Packing",
    takes:
      "Record values and coordinates for regular polygons of 3 to 7 sides packed in each other, used where no other source gives a value: every pair with a heptagon. " +
      "The online supplement of their paper submitted to the Journal of Global Optimization, 2026 (arXiv:2605.04850); it states no licence and is used with citation.",
  },
];

/** How a source is named in the data and in the labels of the reference marks. */
export const sourceLabel = (s: Source) => `${s.author}, ${s.title}`;

type Credited = Pick<
  ListedRecord,
  "source_name" | "conversion_note" | "coordinates_note" | "has_coordinates" | "citation"
>;

/** The sources named in a text of the data, by note number. */
const named = (text: string | undefined) => SOURCES.filter((s) => text?.includes(sourceLabel(s))).map((s) => s.n);

export interface RecordSources {
  /** Sources of the published value: the record's own source first, then one that added digits. */
  value: number[];
  /** Sources of the published coordinates; empty when there are none or this site constructed them. */
  coordinates: number[];
}

/**
 * Note numbers of the sources of one published record. A record that this site derived itself,
 * or one from a source that is not in the list, has none.
 */
export function recordSources(lit: Credited): RecordSources {
  const own = SOURCES.find((s) => lit.source_name.startsWith(sourceLabel(s)))?.n;
  // the build writes "More digits (...) from <source>" into the note when a second source refined the value
  const value = [...new Set([...(own ? [own] : []), ...named(lit.conversion_note)])];
  let coordinates: number[] = [];
  if (lit.has_coordinates) {
    const note = lit.coordinates_note;
    const others = named(note);
    if (others.length) coordinates = others;
    // No note: the coordinates came with the value. "Coordinates from the source's ...": the same
    // source, read later. Any other note ("constructed by PolyPack, not taken from the source") credits nobody.
    else if (own && (!note || /^Coordinates from the source\b/.test(note))) coordinates = [own];
  }
  return { value, coordinates };
}

export interface Credit {
  n: number;
  /** What this record takes from the source, for the credit line. */
  what: string;
}

/** One credit per source of a record, in the order of the notes. */
export function recordCredits(lit: Credited): Credit[] {
  const { value, coordinates } = recordSources(lit);
  const parts = new Map<number, string[]>();
  const add = (n: number, part: string) => parts.set(n, [...(parts.get(n) ?? []), part]);
  value.forEach((n, i) => add(n, i > 0 ? "further digits of the value" : lit.citation ? "value and caption" : "value"));
  for (const n of coordinates) add(n, "coordinates");
  return [...parts].sort(([a], [b]) => a - b).map(([n, list]) => ({ n, what: list.join(", ") }));
}

/**
 * Reference marks for the given notes: a superscript of links, "1" or "1, 3". `prefix` is the id
 * prefix of the notes they point to ("source-" for the list at the foot of the page). Null when
 * there is nothing to mark.
 */
export function sourceMarks(numbers: number[], prefix = "source-"): HTMLElement | null {
  const sources = SOURCES.filter((s) => numbers.includes(s.n));
  if (!sources.length) return null;
  const sup = el("sup", "", "src-ref");
  sources.forEach((s, i) => {
    if (i) sup.append(", ");
    const a = el("a", String(s.n));
    a.href = `#${prefix}${s.n}`;
    a.setAttribute("aria-label", `Source ${s.n}: ${sourceLabel(s)}`);
    sup.append(a);
  });
  return sup;
}

/** The notes themselves, one list item per source with the id `source-<n>`. */
export function renderSourceList(list: HTMLElement): void {
  list.replaceChildren(
    ...SOURCES.map((s) => {
      const li = el("li");
      li.id = `source-${s.n}`;
      // a reference mark moves the focus here
      li.tabIndex = -1;
      const a = el("a", s.title);
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      li.append(`${s.author}, `, a, `. ${s.takes}`);
      return li;
    }),
  );
}

/**
 * A reference mark is followed without touching the address, because the hash of the records
 * page names the problem. The note is scrolled into view and takes the focus.
 */
export function followSourceMarks(root: Document): void {
  root.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>(".src-ref a") : null;
    const note = a ? root.getElementById(a.hash.slice(1)) : null;
    if (!note) return;
    e.preventDefault();
    note.scrollIntoView({ block: "nearest" });
    note.focus({ preventScroll: true });
  });
}
