import { BALLS_CODES } from "@polypack/balls/catalogue";
import { PROBLEM_NAMES } from "@polypack/polyhedra/catalogue";
import { DealerState, nextRandom } from "./dealer";
import { SpaceKey } from "./frontier";
import { spaceFields } from "./families";
import { SliceId } from "./slices";

/**
 * The problems each slice (slices.ts) may deal, enumerated lazily: surfaces are 712,800 problems
 * and balls are 693, so those are drawn from parameter ranges with the dealer's seeded generator.
 * The other spaces (sphere, torus, curved, polyhedra) have only their research records for
 * problems, so they are drawn from the records listing of the server (GET /api/spaces/<space>/records),
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

// ---------- the groups of polyhedra problems ----------

const POLY_GROUPS: Partial<Record<SliceId, (p: (typeof PROBLEM_NAMES)[number]) => boolean>> = {
  "poly-archimedean": (p) => p.family === "archimedean",
  "poly-catalan": (p) => p.family === "catalan",
  "poly-platonic": (p) => p.family === "platonic",
  // prisms and antiprisms in themselves, without the elongated ones (which are only ever in a cube)
  "poly-prisms": (p) => p.family === "prisms" && p.piece === p.container,
  "poly-cube": (p) => p.family === "prisms" && p.container === "cube" && /^(anti)?prism\d+$/.test(p.piece),
  "poly-elongated": (p) => p.family === "prisms" && /_l\d+$/.test(p.piece),
  "poly-duals": (p) => p.family === "bipyramids" || p.family === "trapezohedra",
};

/** The polyhedra codes of a poly-* slice: each of the 150 codes is in one slice. */
export function polyhedraCodes(slice: SliceId): string[] {
  const keep = POLY_GROUPS[slice];
  return keep ? PROBLEM_NAMES.filter(keep).map((p) => p.code) : [];
}

const POLY_SLICE_OF: ReadonlyMap<string, SliceId> = (() => {
  const m = new Map<string, SliceId>();
  for (const slice of Object.keys(POLY_GROUPS) as SliceId[]) for (const c of polyhedraCodes(slice)) m.set(c, slice);
  return m;
})();

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
    case "balls":
      return f.family;
    case "polyhedra":
      return POLY_SLICE_OF.get(f.code) ?? null;
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
export type SpaceListings = Partial<Record<ListedSpace, readonly ListedSpaceProblem[]>>;

/** The records listing a slice draws from, or null for a slice drawn from parameter ranges. */
export function listingOf(slice: SliceId): ListedSpace | null {
  if (slice === "sphere" || slice === "torus" || slice === "curved") return slice;
  return slice.startsWith("poly-") ? "polyhedra" : null;
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
    const ok = all.filter((p) => dealtFromListing(p) && inSlice(slice, p.id) && !o.exclude.has(p.id));
    const small = o.starter ? ok.filter((p) => p.P >= STARTER_P.min && p.P <= STARTER_P.max) : [];
    const from = small.length ? small : ok;
    if (!from.length) return null;
    const p = pick(d, from);
    return keyFor(p.id, p.P, listed);
  }
  const attempts = o.attempts ?? 24;
  if (slice === "balls") {
    for (let i = 0; i < attempts; i++) {
      const code = pick(d, o.starter ? STARTER_BALLS : BALLS_CODES);
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
    const P = o.starter ? span(d, STARTER_P.min, STARTER_P.max) : span(d, 1, 100);
    const id = `surface/${solid}/${mode}/${N}/${P}`;
    if (!o.exclude.has(id)) return keyFor(id, P, "surface");
  }
  return null;
}
