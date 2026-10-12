import {
  LeaderboardEntry,
  LiteratureRecord,
  Pose,
  RecordStatus,
  beatsLiterature,
  containerVertices,
  enclose,
  pieceVertices,
} from "@polypack/geometry";

/**
 * The pure parts of the records atlas: which packing a tile draws, how pieces are classed by
 * tilt, the geometry of one drawing, and the display state kept in the URL. No DOM in here.
 */

// ---------- rows and status ----------

/** A published value as the records listing sends it (coordinates are fetched separately). */
export type ListedRecord = Omit<LiteratureRecord, "pieces"> & { has_coordinates?: boolean };

export interface AtlasRow {
  P: number;
  /** Best listed entry of the site. It may still be pending verification. */
  site?: LeaderboardEntry;
  /** Best entry that is not pending, where `site` is pending and such an entry exists. */
  verified?: LeaderboardEntry;
  lit?: ListedRecord;
  /** Area lower bound on the container size. */
  bound: number;
}

type Entries = Pick<AtlasRow, "site" | "verified" | "lit">;

/** The site's best entry that does not await review: only this one may stand as a known value. */
export function verifiedEntry(row: Entries): LeaderboardEntry | undefined {
  return row.site && row.site.verification !== "pending" ? row.site : row.verified;
}

/** The site's best entry when it claims to beat the published value and has not been reviewed. */
export function pendingEntry(row: Entries): LeaderboardEntry | undefined {
  return row.site?.verification === "pending" ? row.site : undefined;
}

/** Slack within which a site score counts as matching a published value: what the source prints, never finer than 1e-9. */
export function matchTolerance(lit: Pick<LiteratureRecord, "display_precision">): number {
  return Math.max(Math.pow(10, -lit.display_precision), 1e-9);
}

export type Drawable =
  /**
   * A site entry. `record`: it is verified and at least as good as the published value (or there
   * is none). Otherwise it is only the best packing that can be drawn: a verified entry behind a
   * published value without coordinates or, last of all, an entry that is `pending` verification.
   */
  { kind: "site"; id: number; record: boolean; pending: boolean } | { kind: "literature" } | { kind: "none" };

/**
 * Which packing a tile draws. Mirrors `atlasSource` on the server, which makes the decision that
 * counts; this one lets a tile show the right placeholder before any coordinates are loaded.
 * A pending entry is drawn only when nothing else can be.
 */
export function chooseDrawable(row: Entries): Drawable {
  const { lit } = row;
  const site = verifiedEntry(row);
  if (site && (!lit || site.score <= lit.value + matchTolerance(lit)))
    return { kind: "site", id: site.id, record: true, pending: false };
  if (lit?.has_coordinates) return { kind: "literature" };
  if (site) return { kind: "site", id: site.id, record: false, pending: false };
  const pending = pendingEntry(row);
  return pending ? { kind: "site", id: pending.id, record: false, pending: true } : { kind: "none" };
}

/** Identifies the drawing of a tile; a change means the coordinates must be fetched again. */
export function drawableKey(d: Drawable): string {
  return d.kind === "site" ? `site:${d.id}` : d.kind;
}

/** The same identity, read off an answer of /api/atlas (null: the server has nothing to draw). */
export function tileKey(t: { source: "site" | "literature"; id?: number } | null): string {
  return !t ? "none" : t.source === "site" ? `site:${t.id}` : "literature";
}

/** How the site's best verified entry stands against the published value. */
export type SiteStanding = "beats" | "matches" | "only" | "behind" | "none";

export interface TileStatus {
  /**
   * Smallest known container size for this P: the better of the published value and the best
   * verified site entry. An entry that is pending verification never counts. Null only when a
   * pending entry is all there is.
   */
  best: number | null;
  /** Status of the published value, when there is one. */
  published: RecordStatus | null;
  site: SiteStanding;
  /** An entry scored below the published value and has not been reviewed yet. */
  pending: boolean;
}

export function tileStatus(row: Entries): TileStatus | null {
  const { lit } = row;
  const site = verifiedEntry(row);
  const pending = pendingEntry(row);
  if (!site && !lit && !pending) return null;
  let standing: SiteStanding = "none";
  if (site && !lit) standing = "only";
  else if (site && lit) {
    standing = beatsLiterature(site.score, lit as LiteratureRecord)
      ? "beats"
      : site.score <= lit.value + matchTolerance(lit)
        ? "matches"
        : "behind";
  }
  const best = site && (!lit || site.score < lit.value) ? site.score : lit ? lit.value : null;
  return { best, published: lit?.status ?? null, site: standing, pending: !!pending };
}

/**
 * Size that places a tile in the layout (row, true scale). It is the smallest known value; a
 * pending entry only stands in when there is no other number at all.
 */
export function layoutSize(row: Entries): number {
  return tileStatus(row)?.best ?? pendingEntry(row)?.score ?? 1;
}

export const STATUS_TEXT: Record<RecordStatus, string> = {
  proven: "proven",
  proven_unrefereed: "proven (unrefereed)",
  best_known: "best known",
  trivial_tiling: "optimal tiling",
};

export const SITE_TEXT: Record<Exclude<SiteStanding, "none" | "behind">, string> = {
  beats: "site entry beats the published value",
  matches: "site entry matches the published value",
  only: "site entry, no published value",
};

/** One sentence for assistive technology and the tile's tooltip. */
export function tileLabel(row: AtlasRow, M: number): string {
  const st = tileStatus(row);
  if (!st) return `P = ${row.P}`;
  const pending = pendingEntry(row);
  const parts = [`P = ${row.P}`];
  parts.push(st.best === null ? "no verified value" : `${M === 0 ? "radius" : "side"} ${st.best.toFixed(6)}`);
  if (st.published) parts.push(STATUS_TEXT[st.published]);
  if (st.site !== "none" && st.site !== "behind") parts.push(SITE_TEXT[st.site]);
  if (pending) parts.push(`an entry at ${pending.score.toFixed(6)} is pending verification`);
  const d = chooseDrawable(row);
  if (d.kind === "none") parts.push("no coordinates");
  else if (d.kind === "literature") parts.push("drawn from published coordinates");
  else if (d.pending) parts.push(`drawing: the pending entry by ${pending!.name}`);
  else {
    const site = verifiedEntry(row)!;
    parts.push(
      d.record ? `drawn from the entry by ${site.name}` : `drawing: entry by ${site.name} at ${site.score.toFixed(6)}`,
    );
  }
  return parts.join(", ");
}

/** A link target taken from data: only http(s) addresses and paths of this site are followed. */
export function safeHref(url: string | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\/[^\s/]/i.test(url)) return url;
  return /^\/(?![/\\])/.test(url) ? url : null;
}

/**
 * Row of the grouped layout: every P whose best known container size lies in (k - 1, k] shares
 * row k. For squares in a square this is the side of the trivial grid, ceil(sqrt(P)).
 */
export function sizeRow(best: number): number {
  return Math.max(1, Math.ceil(best - 1e-9));
}

// ---------- tilt ----------

/**
 * 0: side-on, a side of the piece faces a container side squarely (same outward normal), so the
 *    piece could lie flat against it. In a circle container: unrotated, a corner straight up.
 * 1: corner-on, half a step (pi / N) from side-on: a corner points squarely at a container side.
 *    For odd N such a piece also has a side parallel to that container side, facing away from it,
 *    which is why class 0 is not described as "parallel". In a circle: a side facing straight up.
 * 2: any other angle.
 * Where the half step is itself side-on (M / gcd(N, M) even, e.g. squares in an octagon) class 1
 * cannot occur.
 */
export type TiltClass = 0 | 1 | 2;

export const TILT_TOL = 1e-6;

const TAU = 2 * Math.PI;
const mod = (a: number, m: number) => ((a % m) + m) % m;
/** Distance between two angles on a circle of circumference `period`. */
const circular = (a: number, b: number, period: number): number => {
  const d = mod(a - b, period);
  return Math.min(d, period - d);
};

/**
 * Tilt of a polygon piece against its container, reduced to [0, 2 pi / N) by the piece's
 * rotational symmetry. Zero means one side of the piece is parallel to the container's bottom
 * side and lies flush against it when pushed down: the outward normal of piece side k is at
 * theta + pi/2 + pi/N + 2 pi k / N, that of the bottom side at phi - pi/2. In a circle container
 * (M = 0) there is nothing to align with and zero means unrotated, a vertex pointing up.
 */
export function tiltOf(N: number, M: number, theta: number, phi: number): number {
  const period = TAU / N;
  return mod(M === 0 ? theta : theta - phi + Math.PI + Math.PI / N, period);
}

/**
 * Class of a tilt returned by `tiltOf`. A piece is aligned when one of its sides is parallel to
 * any container side with matching outward normals, that is when the tilt is a multiple of
 * 2 pi / M (modulo the piece's symmetry).
 */
export function tiltClass(N: number, M: number, tilt: number, tol = TILT_TOL): TiltClass {
  if (N === 0) return 0;
  const period = TAU / N;
  const sides = M === 0 ? 1 : M;
  let half = false;
  for (let j = 0; j < sides; j++) {
    const aligned = M === 0 ? 0 : (TAU * j) / M;
    if (circular(tilt, aligned, period) <= tol) return 0;
    if (circular(tilt, aligned + period / 2, period) <= tol) half = true;
  }
  return half ? 1 : 2;
}

/**
 * A tilt within `tol` of a side-on or corner-on angle is replaced by that angle, so that the
 * number shown for a group never contradicts its class (1e-10 is "0°" and side-on, both).
 */
function snapTilt(N: number, M: number, tilt: number, tol: number): number {
  const period = TAU / N;
  const sides = M === 0 ? 1 : M;
  for (let j = 0; j < 2 * sides; j++) {
    // side-on angles are multiples of 2 pi / M, corner-on ones lie half a step further
    const special = mod((M === 0 ? 0 : (TAU * Math.floor(j / 2)) / M) + (j % 2 ? period / 2 : 0), period);
    if (circular(tilt, special, period) <= tol) return period - special <= tol ? 0 : special;
  }
  return tilt;
}

export interface TiltGroup {
  /** Tilt in radians, in [0, 2 pi / N). */
  tilt: number;
  cls: TiltClass;
  count: number;
}

/** The distinct tilts of a packing, most common first. Circles have a single group. */
export function tiltGroups(N: number, M: number, pieces: readonly Pose[], phi: number, tol = TILT_TOL): TiltGroup[] {
  if (N === 0) return pieces.length ? [{ tilt: 0, cls: 0, count: pieces.length }] : [];
  const period = TAU / N;
  const tilts = pieces
    .map((p) => tiltOf(N, M, p.theta, phi))
    // a tilt a hair below a full period is a hair below zero, not a large tilt
    .map((t) => (period - t <= tol ? 0 : t))
    .sort((a, b) => a - b);
  const groups: TiltGroup[] = [];
  for (const t of tilts) {
    const last = groups[groups.length - 1];
    if (last && t - last.tilt <= tol) last.count++;
    else groups.push({ tilt: snapTilt(N, M, t, tol), cls: tiltClass(N, M, t, tol), count: 1 });
  }
  return groups.sort((a, b) => b.count - a.count || a.tilt - b.tilt);
}

// ---------- drawing ----------

export interface Outline {
  /** viewBox x, y, width, height, in piece units with y pointing down. */
  box: [number, number, number, number];
  /** Radius of a circle container, or the corner points of a polygon container. */
  circle?: number;
  points?: string;
}

export interface Drawing extends Outline {
  /** Container side or radius computed from the coordinates. */
  size: number;
  /** One path per tilt class present, all its pieces as sub-paths. */
  paths: { cls: TiltClass; count: number; d: string }[];
  tilts: TiltGroup[];
}

/** Four decimals of a piece unit: below a tenth of a pixel at any size the atlas draws. */
const f = (v: number) => String(+v.toFixed(4));

/**
 * Outline of a container of the given size in its own frame: centred on the origin with a
 * horizontal bottom side. The viewBox is the bounding box, so drawings of one container shape
 * differ only by scale.
 */
export function containerOutline(M: number, size: number): Outline {
  if (M === 0) return { box: [-size, -size, 2 * size, 2 * size], circle: size };
  const v = containerVertices({ M, cx: 0, cy: 0, phi: 0, size });
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  const pts: string[] = [];
  for (let k = 0; k < M; k++) {
    const x = v[2 * k],
      y = -v[2 * k + 1];
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
    pts.push(`${f(x)},${f(y)}`);
  }
  return { box: [x0, y0, x1 - x0, y1 - y0], points: pts.join(" ") };
}

/**
 * Geometry of one packing in the frame of its smallest container at orientation phi: the
 * container is centred, turned to a horizontal bottom side (so every tile of one problem family
 * frames the same shape) and y is flipped for SVG. Returns null for an empty packing.
 */
export function drawPacking(N: number, M: number, pieces: readonly Pose[], phi: number): Drawing | null {
  if (!pieces.length) return null;
  const c = enclose(N, pieces, M, M === 0 ? 0 : phi);
  const turn = M === 0 ? 0 : c.phi;
  const cos = Math.cos(turn),
    sin = Math.sin(turn);
  const parts: string[][] = [[], [], []];
  const counts = [0, 0, 0];
  const verts = new Float64Array(2 * Math.max(N, 1));
  for (const p of pieces) {
    const dx = p.x - c.cx,
      dy = p.y - c.cy;
    // rotate by -phi about the container centre
    const x = dx * cos + dy * sin;
    const y = -dx * sin + dy * cos;
    if (N === 0) {
      counts[0]++;
      parts[0].push(`M${f(x - 1)} ${f(-y)}a1 1 0 1 0 2 0a1 1 0 1 0 -2 0`);
      continue;
    }
    const cls = tiltClass(N, M, tiltOf(N, M, p.theta, turn));
    pieceVertices(N, { x, y, theta: p.theta - turn }, 1, verts);
    let d = "";
    for (let k = 0; k < N; k++) d += `${k ? "L" : "M"}${f(verts[2 * k])} ${f(-verts[2 * k + 1])}`;
    counts[cls]++;
    parts[cls].push(d + "Z");
  }
  const paths = ([0, 1, 2] as TiltClass[])
    .filter((cls) => counts[cls])
    .map((cls) => ({ cls, count: counts[cls], d: parts[cls].join("") }));
  return { ...containerOutline(M, c.size), size: c.size, paths, tilts: tiltGroups(N, M, pieces, turn) };
}

// ---------- display state in the URL ----------

export const SIZES = ["small", "medium", "large"] as const;
export const SCALES = ["fixed", "row", "global"] as const;
export const LAYOUTS = ["grid", "rows"] as const;
export type TileSize = (typeof SIZES)[number];
export type DrawScale = (typeof SCALES)[number];
export type AtlasLayout = (typeof LAYOUTS)[number];

export interface AtlasView {
  size: TileSize;
  /** fixed: every container the same size; row / global: true size against the largest of the row / of all shown. */
  scale: DrawScale;
  layout: AtlasLayout;
  /** Show every tile instead of the first FIRST_TILES. */
  all: boolean;
  /** P of the open detail panel. */
  p: number | null;
}

export const DEFAULT_VIEW: AtlasView = { size: "medium", scale: "fixed", layout: "grid", all: false, p: null };
/** Tiles shown before "Show more". */
export const FIRST_TILES = 100;

/** The row scale compares within a row, so it needs the rows layout; elsewhere it falls back to fixed. */
export function normalizeView(v: AtlasView): AtlasView {
  return v.scale === "row" && v.layout !== "rows" ? { ...v, scale: "fixed" } : v;
}

const pick = <T extends string>(options: readonly T[], value: string | null, fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

/** Reads the display state from a query string; anything unknown falls back to the default. */
export function parseView(search: string): AtlasView {
  const q = new URLSearchParams(search);
  const p = q.get("p");
  return normalizeView({
    size: pick(SIZES, q.get("size"), DEFAULT_VIEW.size),
    scale: pick(SCALES, q.get("scale"), DEFAULT_VIEW.scale),
    layout: pick(LAYOUTS, q.get("layout"), DEFAULT_VIEW.layout),
    all: q.get("show") === "all",
    p: p !== null && /^[1-9]\d{0,2}$/.test(p) ? Number(p) : null,
  });
}

/** The query string for a display state ("" for the default), keeping unrelated parameters of `search`. */
export function viewQuery(view: AtlasView, search = ""): string {
  const v = normalizeView(view);
  const q = new URLSearchParams(search);
  const set = (key: string, value: string | null) => (value === null ? q.delete(key) : q.set(key, value));
  set("size", v.size === DEFAULT_VIEW.size ? null : v.size);
  set("scale", v.scale === DEFAULT_VIEW.scale ? null : v.scale);
  set("layout", v.layout === DEFAULT_VIEW.layout ? null : v.layout);
  set("show", v.all ? "all" : null);
  set("p", v.p === null ? null : String(v.p));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Formats a tilt for the legend and the detail panel, in degrees. */
export function tiltDegrees(tilt: number, digits = 2): string {
  const deg = (tilt * 180) / Math.PI;
  return `${+deg.toFixed(digits)}°`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Whether a piece can be corner-on without being side-on (see TiltClass). */
export function hasHalfStep(N: number, M: number): boolean {
  return N !== 0 && (M === 0 || (M / gcd(N, M)) % 2 === 1);
}

export interface TiltLegendEntry {
  cls: TiltClass;
  /** Short name, used where the angle is printed beside it. */
  name: string;
  /** What the class means, true for every piece of the class. */
  text: string;
}

/** The fill classes that can occur for N-gon pieces in an M-gon (or circle) container, with their meaning. */
export function tiltLegend(N: number, M: number): TiltLegendEntry[] {
  if (N === 0) return [];
  const circle = M === 0;
  const entries: TiltLegendEntry[] = [
    circle
      ? { cls: 0, name: "unrotated", text: "unrotated: a corner points straight up" }
      : { cls: 0, name: "side-on", text: "side-on: a side faces a container side squarely" },
  ];
  if (hasHalfStep(N, M)) {
    entries.push(
      circle
        ? {
            cls: 1,
            name: "half a step",
            text: `turned half a step (${tiltDegrees(Math.PI / N)}): a side faces straight up`,
          }
        : { cls: 1, name: "corner-on", text: "corner-on: a corner points squarely at a container side" },
    );
  }
  entries.push({ cls: 2, name: "other", text: "any other angle" });
  return entries;
}

/** How one tilt group reads in the detail panel: its class by name and its angle in degrees. */
export function tiltName(N: number, M: number, group: Pick<TiltGroup, "tilt" | "cls">): string {
  if (group.cls !== 2) {
    const name = tiltLegend(N, M).find((e) => e.cls === group.cls)?.name ?? "";
    return `${name} (${tiltDegrees(group.tilt)})`;
  }
  // An angle of another class must not print like a side-on or corner-on one: 44.99996 degrees is
  // not "45°". Digits are added until the two can be told apart.
  const period = TAU / N;
  const near = snapTilt(N, M, group.tilt, 0.01);
  let digits = 2;
  while (
    digits < 8 &&
    [near, near === 0 ? period : near].some(
      (a) => a !== group.tilt && tiltDegrees(a, digits) === tiltDegrees(group.tilt, digits),
    )
  ) {
    digits++;
  }
  return tiltDegrees(group.tilt, digits);
}
