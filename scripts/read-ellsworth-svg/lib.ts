// A small reader for the hand-written SVG drawings on David Ellsworth's "Squares in Squares" page:
// a filled shape stands for a group of unit squares (a 5 x 5 block, a staircase), placed by exact
// transforms, with the container side as a 30-digit entity. A filled shape is split into unit
// squares on the integer grid of its own frame; any exact tiling of the shape by unit squares is a
// valid packing of that many squares, whether or not it is the drawn one. Only the elements, path
// commands and transforms below are accepted, and every number must parse as one; anything else
// throws Unreadable, so that a drawing is skipped rather than guessed. The caller checks the count,
// the overlaps and the container (read-ellsworth-svg.ts).
import type { Pose } from "@polypack/geometry";

export class Unreadable extends Error {}

type Matrix = [number, number, number, number, number, number]; // a b c d e f, as in SVG
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** The numbers of a list such as "0 0 17.6 17.6" or "1,-.5". Any other text in it is refused:
 *  an unexpanded "&u2;" must not be read as the 2 of its name. */
export function numberList(text: string): number[] {
  if (text.replace(NUMBER, " ").replace(/[\s,]/g, "")) throw new Unreadable(`numbers "${text.trim()}"`);
  return (text.match(NUMBER) ?? []).map(Number);
}

function number(text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  const v = numberList(text);
  if (v.length !== 1) throw new Unreadable(`a number "${text.trim()}"`);
  return v[0];
}

function parseTransform(text: string | undefined): Matrix {
  let m: Matrix = IDENTITY;
  if (!text) return m;
  const re = /(\w+)\s*\(([^)]*)\)/g;
  let rest = text;
  for (let t = re.exec(text); t; t = re.exec(text)) {
    rest = rest.replace(t[0], "");
    const v = numberList(t[2]);
    let n: Matrix;
    if (t[1] === "translate" && (v.length === 1 || v.length === 2)) n = [1, 0, 0, 1, v[0], v[1] ?? 0];
    else if (t[1] === "scale" && (v.length === 1 || v.length === 2)) n = [v[0], 0, 0, v[1] ?? v[0], 0, 0];
    else if (t[1] === "rotate" && (v.length === 1 || v.length === 3)) {
      const a = (v[0] * Math.PI) / 180;
      const [c, s] = [Math.cos(a), Math.sin(a)];
      const [cx, cy] = [v[1] ?? 0, v[2] ?? 0];
      n = multiply(multiply([1, 0, 0, 1, cx, cy], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    } else if (t[1] === "matrix" && v.length === 6) n = v as Matrix;
    else throw new Unreadable(`transform ${t[0]}`);
    m = multiply(m, n);
  }
  if (rest.trim()) throw new Unreadable(`transform text "${rest.trim()}"`);
  return m;
}

interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}

/** Elements may only be these; anything else (text, circles, images, nested svg) is refused. */
const TAGS = new Set(["svg", "defs", "g", "rect", "path", "polygon", "use", "script", "title", "desc"]);

/** The document's internal entities, each expanded in full: an entity's text may use others, as
 *  in `<!ENTITY tr "translate(-&u2; 1)">`. Loops and runaway expansions are refused. */
function entitiesOf(source: string): Map<string, string> {
  const defined = new Map<string, string>();
  for (const e of source.matchAll(/<!ENTITY\s+(\w+)\s+"([^"]*)"\s*>/g)) defined.set(e[1], e[2]);
  const expanded = new Map<string, string>();
  const expand = (name: string, open: string[]): string => {
    if (expanded.has(name)) return expanded.get(name)!;
    if (!defined.has(name)) throw new Unreadable(`entity &${name};`);
    if (open.includes(name)) throw new Unreadable(`entity &${name}; refers to itself`);
    const text = defined.get(name)!.replace(/&(\w+);/g, (_, inner) => expand(inner, [...open, name]));
    if (text.length > 100_000) throw new Unreadable(`entity &${name}; expands too far`);
    expanded.set(name, text);
    return text;
  };
  for (const name of defined.keys()) expand(name, []);
  return expanded;
}

function parseSvg(source: string): Node {
  // internal entities, such as the container side; then drop the DTD, comments and scripts
  const entities = entitiesOf(source);
  let text = source
    .replace(/<\?xml[^>]*\?>/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[\s\S]*?\]>/, "")
    .replace(/<!DOCTYPE[^>]*>/, "");
  text = text.replace(/&(\w+);/g, (all, name) => {
    if (!entities.has(name)) throw new Unreadable(`entity ${all}`);
    return entities.get(name)!;
  });
  if (text.length > 10_000_000) throw new Unreadable("a document that expands too far");
  const root: Node = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const re = /<(\/?)([\w:]+)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let last = 0;
  for (let t = re.exec(text); t; t = re.exec(text)) {
    if (text.slice(last, t.index).trim() && stack[stack.length - 1].tag !== "script")
      throw new Unreadable("text content");
    last = re.lastIndex;
    const [, closing, tag, attrText, selfClosing] = t;
    if (!TAGS.has(tag)) throw new Unreadable(`element <${tag}>`);
    if (closing) {
      if (stack.pop()!.tag !== tag) throw new Unreadable("mismatched tags");
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of attrText.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = a[2];
    const node = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1 || text.slice(last).trim()) throw new Unreadable("unbalanced document");
  return root;
}

function fillOf(node: Node, inherited: string): string {
  const style = Object.fromEntries(
    (node.attrs.style ?? "")
      .split(";")
      .map((s) => s.split(":").map((p) => p.trim()))
      .filter((p) => p.length === 2 && p[0]),
  );
  return (style.fill ?? node.attrs.fill ?? inherited).toLowerCase();
}

/** Subpaths of a path made of straight lines only (M L H V Z, absolute or relative). */
function pathPolygons(d: string): [number, number][][] {
  if (/[^a-zA-Z\d.,+\-\s]/.test(d)) throw new Unreadable("path text");
  const out: [number, number][][] = [];
  let current: [number, number][] = [];
  let x = 0;
  let y = 0;
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0;
  let command = "";
  const next = () => {
    const v = Number(tokens[i++]);
    if (!Number.isFinite(v)) throw new Unreadable("path numbers");
    return v;
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) command = tokens[i++];
    const rel = command === command.toLowerCase();
    switch (command.toUpperCase()) {
      case "M":
        if (current.length) out.push(current);
        x = (rel ? x : 0) + next();
        y = (rel ? y : 0) + next();
        current = [[x, y]];
        command = rel ? "l" : "L"; // further pairs are lines
        break;
      case "L":
        x = (rel ? x : 0) + next();
        y = (rel ? y : 0) + next();
        current.push([x, y]);
        break;
      case "H":
        x = (rel ? x : 0) + next();
        current.push([x, y]);
        break;
      case "V":
        y = (rel ? y : 0) + next();
        current.push([x, y]);
        break;
      case "Z":
        if (current.length) {
          out.push(current);
          [x, y] = current[0];
        }
        current = [];
        break;
      default:
        throw new Unreadable(`path command ${command}`);
    }
  }
  if (current.length) out.push(current);
  return out;
}

/** Is (x, y) inside the union of the subpaths, by the even-odd rule? */
function inside(polys: [number, number][][], x: number, y: number): boolean {
  let odd = false;
  for (const poly of polys)
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
    }
  return odd;
}

/** Unit cells of a filled shape, in its own frame, as their lower corners. */
function unitCells(polys: [number, number][][]): [number, number][] {
  const pts = polys.flat();
  const x0 = Math.min(...pts.map((p) => p[0]));
  const y0 = Math.min(...pts.map((p) => p[1]));
  const near = (v: number) => Math.abs(v - Math.round(v)) < 1e-9;
  if (!pts.every(([x, y]) => near(x - x0) && near(y - y0))) throw new Unreadable("a shape off the unit grid");
  let area = 0;
  for (const poly of polys)
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
      area += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  area = Math.abs(area / 2);
  const w = Math.round(Math.max(...pts.map((p) => p[0])) - x0);
  const h = Math.round(Math.max(...pts.map((p) => p[1])) - y0);
  const cells: [number, number][] = [];
  for (let i = 0; i < w; i++)
    for (let j = 0; j < h; j++) if (inside(polys, x0 + i + 0.5, y0 + j + 0.5)) cells.push([x0 + i, y0 + j]);
  // holes or overlapping subpaths would make the even-odd area and the cell count disagree
  if (!near(area) || cells.length !== Math.round(area)) throw new Unreadable("a shape that is not whole unit cells");
  return cells;
}

/** Every unit square the drawing fills, as poses in the drawing's frame. */
function squaresOf(root: Node, sideOuter: number): Pose[] {
  const byId = new Map<string, Node>();
  // a repeated id refers to its first element, as in browsers: drawings 107 and 267 give a 2 x 1
  // rect inside #two the id "one" again, and every <use> of #one still means a single square
  const index = (n: Node) => {
    if (n.attrs.id && !byId.has(n.attrs.id)) byId.set(n.attrs.id, n);
    n.children.forEach(index);
  };
  index(root);
  const out: Pose[] = [];
  const visit = (n: Node, m: Matrix, fill: string, depth: number) => {
    if (depth > 20) throw new Unreadable("references nested too deeply");
    if (n.tag === "defs" || n.tag === "script" || n.tag === "title" || n.tag === "desc") return;
    const own = multiply(m, parseTransform(n.attrs.transform));
    const f = fillOf(n, fill);
    if (n.tag === "use") {
      const ref = byId.get((n.attrs["xlink:href"] ?? n.attrs.href ?? "").replace(/^#/, ""));
      if (!ref) throw new Unreadable("a <use> of an unknown id");
      const at = multiply(own, [1, 0, 0, 1, number(n.attrs.x, 0), number(n.attrs.y, 0)]);
      return visit(ref, at, f, depth + 1);
    }
    if (n.tag === "svg" || n.tag === "g" || n.tag === "#root")
      return n.children.forEach((c) => visit(c, own, f, depth + 1));
    // the white background and the outline are the container, not pieces
    if (f === "none" || f === "white" || f === "#fff" || f === "#ffffff") return;
    let polys: [number, number][][];
    if (n.tag === "rect") {
      const [x, y, w, h] = ["x", "y", "width", "height"].map((k) => number(n.attrs[k], 0));
      if (Math.abs(w - sideOuter) < 1e-9 && Math.abs(h - sideOuter) < 1e-9) return; // a filled container
      polys = [
        [
          [x, y],
          [x + w, y],
          [x + w, y + h],
          [x, y + h],
        ],
      ];
    } else if (n.tag === "path") polys = pathPolygons(n.attrs.d ?? "");
    else if (n.tag === "polygon") {
      const v = numberList(n.attrs.points ?? "");
      if (v.length % 2) throw new Unreadable("polygon points");
      polys = [Array.from({ length: v.length / 2 }, (_, i) => [v[2 * i], v[2 * i + 1]] as [number, number])];
    } else throw new Unreadable(`a filled <${n.tag}>`);
    // only rigid motions keep unit squares unit squares
    const [a, b, c, d] = own;
    if (Math.abs(a * a + b * b - 1) > 1e-12 || Math.abs(c * c + d * d - 1) > 1e-12 || Math.abs(a * c + b * d) > 1e-12)
      throw new Unreadable("a transform that is not a rigid motion");
    for (const [cx, cy] of unitCells(polys)) {
      const [x, y] = apply(own, cx + 0.5, cy + 0.5);
      // an unrotated piece points a vertex up, so a square with axis-parallel sides has theta pi/4
      out.push({ x, y, theta: Math.PI / 4 + Math.atan2(b, a) });
    }
  };
  visit(root, IDENTITY, "black", 0);
  return out;
}

/** The unit squares a drawing shows, in its own frame, and the side of its square viewBox. */
export function readSquares(source: string): { side: number; squares: Pose[] } {
  const root = parseSvg(source);
  const svg = root.children.find((c) => c.tag === "svg");
  if (!svg) throw new Unreadable("no <svg>");
  const box = numberList(svg.attrs.viewBox ?? "");
  // the frame need not start at the origin: the caller recomputes and checks the container
  if (box.length !== 4 || Math.abs(box[2] - box[3]) > 1e-12) throw new Unreadable("a viewBox that is not square");
  return { side: box[2], squares: squaresOf(root, box[2]) };
}
