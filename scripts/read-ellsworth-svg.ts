// Reads coordinates for squares in a square from the SVG drawings on David Ellsworth's "Squares in
// Squares" page, with credit, into data/sources/svg-ellsworth.json. Then run build-records.ts.
//
//   npx tsx scripts/read-ellsworth-svg.ts [--cache DIR]
//
// The drawings are hand-written SVG: a filled shape stands for a group of unit squares (a 5 x 5
// block, a staircase), placed by exact transforms, with the container side as a 30-digit entity.
// A filled shape is split into unit squares on the integer grid of its own frame; any exact
// tiling of the shape by unit squares is a valid packing of that many squares, whether or not it
// is the drawn one. A drawing is used only when every check holds: only the elements and path
// commands below appear, each shape is a union of whole unit cells, the transforms are rigid
// motions, the count is P, the site's checker finds no overlap, and the container it implies is
// within 1e-9 of the published value. Anything else is reported and skipped, never guessed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type LiteratureRecord, type Pose, evaluate } from "@polypack/geometry";
import { trimTo } from "./trim-down/lib";

const cacheArg = process.argv.indexOf("--cache");
const CACHE = cacheArg > 0 ? process.argv[cacheArg + 1] : join(process.env.TMPDIR ?? "/tmp", "polypack-ellsworth-svg");
const TODAY = new Date().toISOString().slice(0, 10);
const OUT = "data/sources/svg-ellsworth.json";

// ---------- a small SVG reader for these hand-written files ----------

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

class Unreadable extends Error {}

const numbers = (text: string) => (text.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);

function parseTransform(text: string | undefined): Matrix {
  let m: Matrix = IDENTITY;
  if (!text) return m;
  const re = /(\w+)\s*\(([^)]*)\)/g;
  let rest = text;
  for (let t = re.exec(text); t; t = re.exec(text)) {
    rest = rest.replace(t[0], "");
    const v = numbers(t[2]);
    let n: Matrix;
    if (t[1] === "translate") n = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
    else if (t[1] === "scale") n = [v[0], 0, 0, v[1] ?? v[0], 0, 0];
    else if (t[1] === "rotate") {
      const a = (v[0] * Math.PI) / 180;
      const [c, s] = [Math.cos(a), Math.sin(a)];
      const [cx, cy] = [v[1] ?? 0, v[2] ?? 0];
      n = multiply(multiply([1, 0, 0, 1, cx, cy], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    } else if (t[1] === "matrix" && v.length === 6) n = v as Matrix;
    else throw new Unreadable(`transform ${t[1]}`);
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

function parseSvg(source: string): Node {
  // internal entities, such as the container side; then drop the DTD, comments and scripts
  const entities = new Map<string, string>();
  for (const e of source.matchAll(/<!ENTITY\s+(\w+)\s+"([^"]*)"\s*>/g)) entities.set(e[1], e[2]);
  let text = source
    .replace(/<\?xml[^>]*\?>/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[\s\S]*?\]>/, "")
    .replace(/<!DOCTYPE[^>]*>/, "");
  text = text.replace(/&(\w+);/g, (all, name) => {
    if (!entities.has(name)) throw new Unreadable(`entity ${all}`);
    return entities.get(name)!;
  });
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
  const index = (n: Node) => {
    if (n.attrs.id) byId.set(n.attrs.id, n);
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
      const at = multiply(own, [1, 0, 0, 1, Number(n.attrs.x ?? 0), Number(n.attrs.y ?? 0)]);
      return visit(ref, at, f, depth + 1);
    }
    if (n.tag === "svg" || n.tag === "g" || n.tag === "#root")
      return n.children.forEach((c) => visit(c, own, f, depth + 1));
    // the white background and the outline are the container, not pieces
    if (f === "none" || f === "white" || f === "#fff" || f === "#ffffff") return;
    let polys: [number, number][][];
    if (n.tag === "rect") {
      const [x, y, w, h] = ["x", "y", "width", "height"].map((k) => Number(n.attrs[k] ?? 0));
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
      const v = numbers(n.attrs.points ?? "");
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

// ---------- read every drawing of a published record ----------

const { records } = JSON.parse(readFileSync("data/sources/ellsworth.json", "utf8")) as { records: LiteratureRecord[] };
const wanted = records.filter((r) => r.N === 4 && r.M === 4 && /\.svg$/.test(r.picture_url ?? ""));
mkdirSync(CACHE, { recursive: true });
const read: LiteratureRecord[] = [];
const skipped: string[] = [];
for (const r of wanted) {
  const file = join(CACHE, `square-${r.P}.svg`);
  if (!existsSync(file)) {
    const res = await fetch(r.picture_url!);
    if (!res.ok) {
      skipped.push(`P=${r.P}: HTTP ${res.status}`);
      continue;
    }
    writeFileSync(file, await res.text());
    await sleep(300); // one small file at a time, gently
  }
  try {
    const source = readFileSync(file, "utf8");
    const root = parseSvg(source);
    const svg = root.children.find((c) => c.tag === "svg");
    if (!svg) throw new Unreadable("no <svg>");
    const box = numbers(svg.attrs.viewBox ?? "");
    // the frame need not start at the origin: the container is recomputed and checked below
    if (box.length !== 4 || Math.abs(box[2] - box[3]) > 1e-12) throw new Unreadable("a viewBox that is not square");
    const drawn = squaresOf(root, box[2]);
    // Some drawings show a packing of more squares in the same side (14 and 15 both need side 4);
    // without the extra squares it is still a valid packing of P, in a container no larger.
    if (drawn.length < r.P) throw new Unreadable(`${drawn.length} squares for P = ${r.P}`);
    const pieces = drawn.length > r.P ? trimTo(4, 4, drawn, 0, r.P).pieces : drawn;
    const extra = drawn.length - r.P;
    const e = evaluate({ N: 4, M: 4, P: r.P, pieces, container_phi: 0 }, { autoOrient: true });
    if (!e.valid) throw new Unreadable(`not valid: ${e.reasons.join("; ")}`);
    if (Math.abs(e.score! - r.value) > 1e-9 * r.value)
      throw new Unreadable(`a container of ${e.score} for the published ${r.display}`);
    read.push(<LiteratureRecord & { reading_note: string }>{
      ...r,
      source_name: `${r.source_name}: drawing of the packing`,
      source_url: r.picture_url!,
      accessed: TODAY,
      pieces: pieces.map((p) => ({ x: p.x, y: p.y, theta: p.theta })),
      container_phi: e.container!.phi,
      // build-records.ts adds this to the record's coordinates note
      reading_note:
        `Coordinates read from the source's SVG drawing (filled shapes split into unit squares` +
        (extra
          ? `; it shows ${drawn.length} squares in the same side, and the ${extra === 1 ? "outermost one was" : `${extra} outermost were`} left out`
          : "") +
        `) and checked here: ` +
        `${r.P} squares, no overlap, container side ${e.score!.toPrecision(15)} for the published ${r.display}.`,
    });
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    skipped.push(`P=${r.P}: ${error.message}`);
  }
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      description:
        "Coordinates for squares in a square read from the SVG drawings on David Ellsworth's Squares in Squares page " +
        "(https://kingbird.myphotos.cc/packing/squares_in_squares.html), with credit; values as in ellsworth.json. " +
        "Produced by scripts/read-ellsworth-svg.ts; a drawing is used only when its reading reproduces the published value.",
      records: read,
      skipped,
    },
    null,
    1,
  ) + "\n",
);
console.log(`${read.length} of ${wanted.length} drawings read into ${OUT}; ${skipped.length} skipped`);
for (const s of skipped) console.log(`  skipped ${s}`);
