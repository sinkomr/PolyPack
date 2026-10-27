/**
 * The problems of the surface space as a domain of parameter ranges (for packages/spaces' SPACE_DOMAINS):
 * surface/<solid>/<mode>/<N>/<P> for the 49 solids, fold and nofold, N = 0 (disks) or 3 to 100, and
 * P = 1 to 100, as in 2D in 2D. Records exist only for the Platonic solids with N in {0, 3, 4, 5, 6, 8}
 * (data/surface/records.json); every other problem starts without one.
 *
 * Each problem's lower bound is the larger of two [CALC] bounds (docs/spaces/SURFACE.md 2.6), which
 * hold with and without folding:
 *  - area: P pieces of area a(N) fit on a surface of area s^2 A(1), so s >= sqrt(P a(N) / A(1));
 *  - one piece: a piece's inscribed disk (radius r = 1/2 for a disk of diameter 1, the apothem for a polygon) holds no
 *    vertex, and every point of a face f is within rho_f s of one of its corners (faceCornerRadius),
 *    so s >= r / max_f rho_f.
 * On the Platonic solids these are the bounds the records carry, computed as the records were (to the last bit).
 */
import { inradius } from "@polypack/geometry";
import { SURFACE_DISK_RADIUS, pieceAreaOf } from "./disk";
import { GENERAL_SOLID_DATA } from "./general.data";
import { ALL_SOLID_NAMES, type SolidName, faceCornerRadius, getSolid, isSolidName, surfaceArea } from "./solids";

export const SURFACE_MAX_N = 100;
export const SURFACE_MAX_P = 100;
/** The shape codes of the domain: disks, then 3 to 100 sides. */
export const SURFACE_NS: readonly number[] = [0, ...Array.from({ length: SURFACE_MAX_N - 2 }, (_, k) => k + 3)];

const PIECES: Record<number, string> = { 0: "disk", 3: "triangle", 4: "square", 5: "pentagon", 6: "hexagon", 7: "heptagon", 8: "octagon" };
const pieceTitle = (N: number) => PIECES[N] ?? `${N}-gon`;

const FAMILY: Record<string, string> = { platonic: "Platonic solids", archimedean: "Archimedean", catalan: "Catalan solids", prism: "Prisms", antiprism: "Antiprisms" };
// titles and families without building the solids (this module is read where ids are listed)
const DATA = new Map(GENERAL_SOLID_DATA.map((d) => [d.name, d]));
const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const titleOf = (n: string) => capital(DATA.get(n)?.title ?? n);
const familyOf = (n: string) => FAMILY[DATA.get(n)?.family ?? "platonic"];

const cornerRadius = new Map<SolidName, number>();
function maxCornerRadius(name: SolidName): number {
  let r = cornerRadius.get(name);
  if (r === undefined) {
    const S = getSolid(name);
    r = 0;
    for (let f = 0; f < S.F; f++) r = Math.max(r, faceCornerRadius(S, f));
    cornerRadius.set(name, r);
  }
  return r;
}

/**
 * tan(pi / n) as the Platonic records' bounds were computed (Python's math.tan, python/surface/tables.py).
 * V8's Math.tan differs from it in the last bit for n = 5, 6 and 8; with these values the bound below
 * is the records' bound.value to the last bit.
 */
const RECORD_TAN: Record<number, number> = {
  3: 1.7320508075688767,
  4: 0.9999999999999999,
  5: 0.7265425280053609,
  6: 0.5773502691896256,
  8: 0.4142135623730951,
};
const tanPi = (n: number) => RECORD_TAN[n] ?? Math.tan(Math.PI / n);

/** The two lower bounds of surface/<solid>/<mode>/<N>/<P> on the scale s (see the head of this file). */
export function surfaceBounds(solid: SolidName, N: number, P: number): { area: number; one: number } {
  const S = getSolid(solid);
  let area: number;
  let one: number;
  if (S.uniform) {
    // the Platonic solids, with the records' float operations (tables.py bounds): area F M s^2 / (4 tan(pi/M)),
    // and every point of a face within its circumradius s / (2 sin(pi/M)) of a corner
    const M = S.M;
    const a = N === 0 ? Math.PI / 4 : N / (4 * tanPi(N));  // a disk of diameter 1: pi / 4
    area = Math.sqrt((P * a * 4 * tanPi(M)) / (S.F * M));
    one = 2 * Math.sin(Math.PI / M) * (N === 0 ? SURFACE_DISK_RADIUS : 1 / (2 * tanPi(N)));
  } else {
    area = Math.sqrt((P * pieceAreaOf(N)) / surfaceArea(S, 1));
    one = (N === 0 ? SURFACE_DISK_RADIUS : inradius(N)) / maxCornerRadius(solid);
  }
  return { area, one };
}

/** The lower bound of surface/<solid>/<mode>/<N>/<P> on the scale s, with its kind. */
export function surfaceBound(solid: SolidName, N: number, P: number): { value: number; kind: "area" | "one piece" } {
  const { area, one } = surfaceBounds(solid, N, P);
  return area >= one ? { value: area, kind: "area" } : { value: one, kind: "one piece" };
}

/** True when the fields name a problem of the domain. */
function inDomain(solid: unknown, mode: unknown, N: unknown, P: unknown): solid is SolidName {
  return (
    isSolidName(solid) &&
    (mode === "fold" || mode === "nofold") &&
    typeof N === "number" &&
    (N === 0 || (Number.isInteger(N) && N >= 3 && N <= SURFACE_MAX_N)) &&
    typeof P === "number" &&
    Number.isInteger(P) &&
    P >= 1 &&
    P <= SURFACE_MAX_P
  );
}

/**
 * The domain object (the shape of packages/spaces' SpaceDomain). Its sample for the volunteers' work
 * list holds problems without a record, small P first from P = 2 (the work list leaves out P = 1): the
 * folding ones, and the Catalan nofold ones (the other nofold problems are 2D in 2D problems); within a P
 * the shapes of the records' tables (0, 3, 4, 5, 6, 8) first, then the other N, the solids in catalogue order.
 */
export const surfaceDomain = {
  info: {
    id: "surface/<solid>/<mode>/<N>/<P>",
    fields: [
      {
        key: "solid",
        label: "Solid",
        values: [...ALL_SOLID_NAMES],
        titles: Object.fromEntries(ALL_SOLID_NAMES.map((n) => [n, titleOf(n)])),
        /** The family of each solid, for grouping a menu (Platonic, Archimedean, Catalan, prisms, antiprisms). */
        groups: Object.fromEntries(ALL_SOLID_NAMES.map((n) => [n, familyOf(n)])),
      },
      { key: "mode", label: "Folding", values: ["fold", "nofold"], titles: { fold: "Fold over edges", nofold: "No fold" } },
      {
        key: "N",
        label: "Piece (N)",
        values: SURFACE_NS.map(String),
        titles: Object.fromEntries(SURFACE_NS.map((N) => [String(N), `${capital(pieceTitle(N))} (N = ${N})`])),
      },
      { key: "P", label: "Pieces (P)", min: 1, max: SURFACE_MAX_P },
    ],
    problems: ALL_SOLID_NAMES.length * 2 * SURFACE_NS.length * SURFACE_MAX_P,
  },
  bound(id: { fields: Readonly<Record<string, string | number>>; P: number }) {
    const { solid, mode, N } = id.fields;
    if (!inDomain(solid, mode, N, id.P)) return undefined;
    const b = surfaceBound(solid, N as number, id.P);
    return { value: b.value, label: `${b.kind} bound; [CALC]` };
  },
  sample(limit: number): string[] {
    const first = [0, 3, 4, 5, 6, 8];
    const order = [...first, ...SURFACE_NS.filter((N) => !first.includes(N))];
    const out: string[] = [];
    for (let P = 2; P <= SURFACE_MAX_P && out.length < limit; P++)
      for (const N of order)
        for (const solid of ALL_SOLID_NAMES) {
          if (out.length >= limit) return out;
          // the Platonic records' table: fold P <= 24 for these shapes
          if (DATA.has(solid) || !first.includes(N) || P > 24) out.push(`surface/${solid}/fold/${N}/${P}`);
          // a Catalan nofold problem has an irregular face, which no 2D in 2D problem covers
          if (DATA.get(solid)?.family === "catalan" && out.length < limit) out.push(`surface/${solid}/nofold/${N}/${P}`);
        }
    return out;
  },
};
