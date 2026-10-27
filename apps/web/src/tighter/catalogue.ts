import { BALLS_CODES, BALLS_PROBLEMS } from "@polypack/balls/catalogue";
import { SOLID_NAMES_LIST, problemNameOf } from "@polypack/polyhedra/catalogue";
import { DealerState, nextRandom } from "./dealer";
import { ProblemKey, SpaceKey, isPolygon, parseKey } from "./frontier";
import { spaceFields } from "./families";
import { SLICES, SOLID_FAMILY_SLICE, SliceId, laterSlice } from "./slices";

/**
 * The problems each slice (slices.ts) may deal, enumerated lazily: surfaces are 712,800 problems
 * and balls are 693, so those are drawn from parameter ranges with the dealer's seeded generator.
 * Polyhedra problems are every ordered pair of the 94 solids (8,836, of which 150 have records), drawn
 * from the solids of the open families. The other spaces (sphere, torus, curved) have only their
 * research records for problems, so they are drawn from the records listing of the server (GET /api/spaces/<space>/records),
 * read once a session by the page and passed in.
 */

// ---------- the solids of the surface space ----------

/** Written out as packages/spaces ids.ts writes them (a test checks the lists against it), so that the page loads no geometry. */
export const SURFACE_PLATONIC: readonly string[] = ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"];
/** The Catalan solids of the surface space and their numbers of faces. */
export const CATALAN_FACES: Readonly<Record<string, number>> = {
  rhombic_dodecahedron: 12,
  triakis_tetrahedron: 12,
  deltoidal_icositetrahedron: 24,
  pentagonal_icositetrahedron: 24,
  tetrakis_hexahedron: 24,
  triakis_octahedron: 24,
  rhombic_triacontahedron: 30,
  disdyakis_dodecahedron: 48,
  deltoidal_hexecontahedron: 60,
  pentagonal_hexecontahedron: 60,
  pentakis_dodecahedron: 60,
  triakis_icosahedron: 60,
  disdyakis_triacontahedron: 120,
};
export const SURFACE_CATALAN: readonly string[] = Object.keys(CATALAN_FACES);
export const SURFACE_PRISMS: readonly string[] = [
  ...[3, 5, 6, 7, 8, 9, 10, 11, 12].map((k) => `prism${k}`),
  ...[4, 5, 6, 7, 8, 9, 10, 11, 12].map((k) => `antiprism${k}`),
];

/** The solids of a surface slice. */
const SURFACE_SOLIDS: Partial<Record<SliceId, readonly string[]>> = {
  "surf-platonic": SURFACE_PLATONIC,
  "surf-prisms": SURFACE_PRISMS,
  "surf-catalan-a": SURFACE_CATALAN.filter((s) => CATALAN_FACES[s] <= 24),
  "surf-catalan-b": SURFACE_CATALAN.filter((s) => CATALAN_FACES[s] >= 30 && CATALAN_FACES[s] <= 60),
  "surf-catalan-c": SURFACE_CATALAN.filter((s) => CATALAN_FACES[s] >= 120),
  "surf-nofold-catalan": SURFACE_CATALAN,
};

// ---------- the solids and families of the polyhedra and balls problems ----------

const SOLID_BY_NAME = new Map(SOLID_NAMES_LIST.map((s) => [s.name, s]));
const BALLS_BY_CODE = new Map(BALLS_PROBLEMS.map((p) => [p.code, p]));

/** The slice of the solid's family, or null for "ball" or a name that is no solid. */
const solidSlice = (name: string): SliceId | null => {
  const s = SOLID_BY_NAME.get(name);
  return s ? SOLID_FAMILY_SLICE[s.family] : null;
};

/** The solids of the families open in `open`. */
const openSolids = (open: readonly SliceId[]) =>
  SOLID_NAMES_LIST.filter((s) => open.includes(SOLID_FAMILY_SLICE[s.family]));

/**
 * The slices a problem needs open to be dealt: for a pair of solids the slices of the piece's and the
 * container's family, for a balls problem the Balls slice and the slice of the solid's family (if it has
 * a solid). Null when the id is none of these.
 */
export function requiredSlices(id: string): SliceId[] | null {
  const f = spaceFields(id);
  if (!f) return null;
  if (f.family === "polyhedra") {
    const pair = problemNameOf(f.code);
    if (!pair) return null;
    const a = solidSlice(pair.piece);
    const b = solidSlice(pair.container);
    return a && b ? [...new Set([a, b])] : null;
  }
  if (f.family === "balls") {
    const p = BALLS_BY_CODE.get(f.code);
    if (!p) return null;
    const solid = solidSlice(p.piece === "ball" ? p.container : p.piece);
    return solid ? ["balls", solid] : ["balls"];
  }
  return null;
}

/** Whether a polyhedra or balls problem may be dealt with these slices open: every slice it requires is. */
export function dealableIn(id: string, open: readonly SliceId[]): boolean {
  const need = requiredSlices(id);
  return need !== null && need.every((s) => open.includes(s));
}

// ---------- which slice a problem is in ----------

/**
 * The slice of a space problem's id, or null for a problem no slice deals: a surface without
 * folding on a Platonic solid, a prism or an antiprism (each is a 2D in 2D packing of its faces), or an id
 * that is not a space problem's.
 */
export function sliceOfId(id: string): SliceId | null {
  const f = spaceFields(id);
  if (!f) return null;
  switch (f.family) {
    case "sphere":
    case "torus":
    case "curved":
      return f.family;
    case "balls":
    case "polyhedra": {
      // the later opened (dearer) of the slices the problem needs, so a problem is in the slice that opens it last
      const need = requiredSlices(id);
      return need ? need.reduce(laterSlice) : null;
    }
    case "surface": {
      if (f.mode === "nofold") return f.solid in CATALAN_FACES ? "surf-nofold-catalan" : null;
      if (SURFACE_PLATONIC.includes(f.solid)) return "surf-platonic";
      if (SURFACE_PRISMS.includes(f.solid)) return "surf-prisms";
      const faces = CATALAN_FACES[f.solid];
      if (faces === undefined) return null;
      return faces <= 24 ? "surf-catalan-a" : faces <= 60 ? "surf-catalan-b" : "surf-catalan-c";
    }
  }
}

/**
 * A problem key read from a save or a cheat: a polygon key, or a space key whose id is a space
 * problem's (spaceFields) of the key's family and piece count and that a slice deals (sliceOfId).
 * Null for anything else, so that titles and drawings never meet an id they cannot read.
 */
export function parseDealtKey(key: string): ProblemKey | null {
  const k = parseKey(key);
  if (!k || isPolygon(k)) return k;
  const f = spaceFields(k.id);
  return f && f.family === k.family && f.P === k.P && sliceOfId(k.id) !== null ? k : null;
}

export const inSlice = (slice: SliceId, id: string): boolean => sliceOfId(id) === slice;

// ---------- the records listing ----------

/** What the catalogue needs of a problem of GET /api/spaces/<space>/records. */
export interface ListedSpaceProblem {
  id: string;
  P: number;
  status?: string;
  accepts_submissions: boolean;
  certified: { score: number; status?: string } | null;
  bound: { value: number } | null;
}

/** The spaces whose problems are their records. */
export type ListedSpace = "sphere" | "torus" | "curved" | "polyhedra";
// (polyhedra stays a listed space for the page's other uses; no slice draws from it now)
export type SpaceListings = Partial<Record<ListedSpace, readonly ListedSpaceProblem[]>>;

/** The records listing a slice draws from, or null for a slice drawn from parameter ranges. */
export function listingOf(slice: SliceId): ListedSpace | null {
  // polyhedra pairs are drawn from the solids, not from the 150 records
  return slice === "sphere" || slice === "torus" || slice === "curved" ? slice : null;
}

/** A record within this relative distance of its bound is done for the game's purposes: nothing is left to gain. */
export const CLOSE_TO_BOUND = 1e-6;

/** Whether a listed problem may be dealt: it takes entries, is not proven, closed or infeasible, and its record is not at its bound. */
export function dealtFromListing(p: ListedSpaceProblem): boolean {
  if (!p.accepts_submissions) return false;
  const status = p.status ?? p.certified?.status;
  if (status === "proven" || status === "infeasible") return false;
  if (
    p.certified &&
    p.bound &&
    p.bound.value > 0 &&
    (p.certified.score - p.bound.value) / p.bound.value <= CLOSE_TO_BOUND
  )
    return false;
  return true;
}

// ---------- the starter corner ----------

/** A starter problem has few pieces and simple shapes, so that its first record comes within a few clicks. */
export const STARTER_P = { min: 8, max: 20 } as const;
const STARTER_SIDES = [3, 4, 5, 6] as const;
const STARTER_SOLIDS = ["tetrahedron", "cube", "octahedron"] as const;
const STARTER_BALLS = ["ballinball", "ballincub"] as const;
/** P of a polyhedra pair, from 2 to 500. */
export const POLY_P = { min: 2, max: 500 } as const;

// ---------- drawing ----------

const pick = <T>(d: DealerState, list: readonly T[]): T => list[Math.floor(nextRandom(d) * list.length)];
const span = (d: DealerState, a: number, b: number) => a + Math.floor(nextRandom(d) * (b - a + 1));

export interface DrawOptions {
  /** The records listings read so far. */
  listings: SpaceListings;
  /** Keys never to deal. */
  exclude: ReadonlySet<string>;
  /** The slice's starter corner (the first deal after its dimension opens). */
  starter?: boolean;
  /** The slices open now (polyhedra pairs and balls problems are dealt by their families); every slice when absent. */
  open?: readonly SliceId[];
  attempts?: number;
}

const keyFor = (id: string, P: number, family: SpaceKey["family"]): SpaceKey => ({ family, id, P });

/**
 * A random problem of the slice not in `exclude`, or null: none is left, or the slice needs a
 * records listing that has not been read. Draws come from the dealer's seeded generator, so a game
 * started with the same seed is dealt the same candidates.
 */
export function drawSliceProblem(d: DealerState, slice: SliceId, o: DrawOptions): SpaceKey | null {
  const listed = listingOf(slice);
  if (listed) {
    const all = o.listings[listed];
    if (!all) return null;
    const ok = all.filter((p) => p.P >= 2 && dealtFromListing(p) && inSlice(slice, p.id) && !o.exclude.has(p.id));
    const small = o.starter ? ok.filter((p) => p.P >= STARTER_P.min && p.P <= STARTER_P.max) : [];
    const from = small.length ? small : ok;
    if (!from.length) return null;
    const p = pick(d, from);
    return keyFor(p.id, p.P, listed);
  }
  const attempts = o.attempts ?? 24;
  const open = o.open ?? SLICES.map((s) => s.id);
  if (slice.startsWith("poly-")) {
    // The slice's own family supplies the piece or the container (a coin says which), the other comes
    // from any open family, so each card's solids are dealt as soon as it is bought. A starter is
    // Archimedean in Archimedean.
    const own = SOLID_NAMES_LIST.filter(
      (s) => SOLID_FAMILY_SLICE[s.family] === (o.starter ? "poly-archimedean" : slice),
    );
    const any = o.starter ? own : openSolids(open);
    if (!own.length || !any.length) return null;
    for (let i = 0; i < attempts; i++) {
      const focus = pick(d, own);
      const other = pick(d, any);
      const [piece, container] = nextRandom(d) < 0.5 ? [focus, other] : [other, focus];
      // P is log-uniform in [2, 500]: the cost of an evaluation grows with P, so the many small problems
      // that can be improved quickly are dealt as often as the few large ones that take long
      const P = o.starter
        ? span(d, STARTER_P.min, STARTER_P.max)
        : Math.min(
            POLY_P.max,
            Math.max(
              POLY_P.min,
              Math.round(Math.exp(Math.log(POLY_P.min) + nextRandom(d) * Math.log(POLY_P.max / POLY_P.min))),
            ),
          );
      const id = `polyhedra/${piece.code}in${container.code}/${P}`;
      if (!o.exclude.has(id)) return keyFor(id, P, "polyhedra");
    }
    return null;
  }
  if (slice === "balls") {
    const codes = (o.starter ? STARTER_BALLS : BALLS_CODES).filter((c) => dealableIn(`balls/${c}/2`, open));
    if (!codes.length) return null;
    for (let i = 0; i < attempts; i++) {
      const code = pick(d, codes);
      const P = o.starter ? span(d, STARTER_P.min, STARTER_P.max) : span(d, 2, 100);
      const id = `balls/${code}/${P}`;
      if (!o.exclude.has(id)) return keyFor(id, P, "balls");
    }
    return null;
  }
  const solids = SURFACE_SOLIDS[slice];
  if (!solids) return null;
  const mode = slice === "surf-nofold-catalan" ? "nofold" : "fold";
  for (let i = 0; i < attempts; i++) {
    const solid = pick(d, o.starter && slice === "surf-platonic" ? STARTER_SOLIDS : solids);
    // pieces: a disk (0), or a polygon of 3 to 100 sides; a starter has few sides
    const N = o.starter ? pick(d, STARTER_SIDES) : nextRandom(d) < 1 / 98 ? 0 : span(d, 3, 100);
    const P = o.starter ? span(d, STARTER_P.min, STARTER_P.max) : span(d, 2, 100);
    const id = `surface/${solid}/${mode}/${N}/${P}`;
    if (!o.exclude.has(id)) return keyFor(id, P, "surface");
  }
  return null;
}
