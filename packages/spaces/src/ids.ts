/**
 * Problem ids of the spaces, parsed into their fields and written back. Pure, and it uses no
 * validator, so that a page can use it without pulling them in. Boundary ids are read by the
 * boundary package's own parser (parseBoundaryId), so that both always agree; a bundle of this
 * file carries that parser and the few boundary modules it needs. Polyhedra ids are checked
 * against the polyhedra space's name list (no geometry).
 *
 *  - surface/<solid>/<mode>/<N>/<P>    e.g. surface/cube/fold/4/12
 *  - curved/<K>/<N>/<M>/<P>            e.g. curved/-1/3/4/7, curved/1e-06/0/0/5
 *  - sphere/<N>/<P>                    e.g. sphere/4/12
 *  - torus/<family>/<N>/<P>            e.g. torus/hex/5/8
 *  - boundary/<polytope>/<piece>/<P>   e.g. boundary/tesseract/ball/9
 *  - polyhedra/<code>/<P>              e.g. polyhedra/cubintet/12 (code: the wiki's <piece>in<container>)
 *  - balls/<code>/<P>                  e.g. balls/ballinball/13, balls/ballinpkd/20 (code <piece>in<container>:
 *                                      the piece or the container ball, the other one of the polyhedra space's
 *                                      solid codes)
 *  - ndim/<d>/<piece>/<container>/<P>  e.g. ndim/4/cube/ortho/12, ndim/8/421/ball/5 (d = 4 to 10; piece and container
 *                                      a polytope of the dimension's catalogue or ball)
 *
 * An id is accepted only in its one written form (no leading zeros, no "+", K written as the
 * research records write it), so that every problem has exactly one id.
 */
import { PIECES, POLYTOPES, parseBoundaryId } from "@polypack/boundary";
import type { PieceName, PolytopeName } from "@polypack/boundary";
import { problemNameOf } from "@polypack/polyhedra/catalogue";
import { BALLS_CODES_HINT, parseBallsId } from "@polypack/balls/catalogue";
import { ND_ID_FORM, parseNdId } from "@polypack/ndspace/catalogue";
import { SpaceName, isSpaceName } from "./types";

/**
 * The solids of the surface space, in the order the catalogue lists them: the Platonic solids, the
 * Archimedean solids (polyhedra catalogue order), Catalan solids (by number of faces), the prisms and the antiprisms (by number of sides), the 92 Johnson solids (J1 to J92). The same
 * list as ALL_SOLID_NAMES of @polypack/surface (a test checks it), written out here so that pages
 * reading ids need no geometry.
 */
export const SURFACE_SOLIDS = [
  "tetrahedron",
  "cube",
  "octahedron",
  "dodecahedron",
  "icosahedron",
  "truncated_tetrahedron",
  "cuboctahedron",
  "truncated_cube",
  "truncated_octahedron",
  "rhombicuboctahedron",
  "truncated_cuboctahedron",
  "snub_cube",
  "icosidodecahedron",
  "truncated_dodecahedron",
  "truncated_icosahedron",
  "rhombicosidodecahedron",
  "truncated_icosidodecahedron",
  "snub_dodecahedron",
  "rhombic_dodecahedron",
  "triakis_tetrahedron",
  "deltoidal_icositetrahedron",
  "pentagonal_icositetrahedron",
  "tetrakis_hexahedron",
  "triakis_octahedron",
  "rhombic_triacontahedron",
  "disdyakis_dodecahedron",
  "deltoidal_hexecontahedron",
  "pentagonal_hexecontahedron",
  "pentakis_dodecahedron",
  "triakis_icosahedron",
  "disdyakis_triacontahedron",
  "prism3",
  "prism5",
  "prism6",
  "prism7",
  "prism8",
  "prism9",
  "prism10",
  "prism11",
  "prism12",
  "antiprism4",
  "antiprism5",
  "antiprism6",
  "antiprism7",
  "antiprism8",
  "antiprism9",
  "antiprism10",
  "antiprism11",
  "antiprism12",
  "square_pyramid",
  "pentagonal_pyramid",
  "triangular_cupola",
  "square_cupola",
  "pentagonal_cupola",
  "pentagonal_rotunda",
  "elongated_triangular_pyramid",
  "elongated_square_pyramid",
  "elongated_pentagonal_pyramid",
  "gyroelongated_square_pyramid",
  "gyroelongated_pentagonal_pyramid",
  "triangular_bipyramid",
  "pentagonal_bipyramid",
  "elongated_triangular_bipyramid",
  "elongated_square_bipyramid",
  "elongated_pentagonal_bipyramid",
  "gyroelongated_square_bipyramid",
  "elongated_triangular_cupola",
  "elongated_square_cupola",
  "elongated_pentagonal_cupola",
  "elongated_pentagonal_rotunda",
  "gyroelongated_triangular_cupola",
  "gyroelongated_square_cupola",
  "gyroelongated_pentagonal_cupola",
  "gyroelongated_pentagonal_rotunda",
  "gyrobifastigium",
  "triangular_orthobicupola",
  "square_orthobicupola",
  "square_gyrobicupola",
  "pentagonal_orthobicupola",
  "pentagonal_gyrobicupola",
  "pentagonal_orthocupolarotunda",
  "pentagonal_gyrocupolarotunda",
  "pentagonal_orthobirotunda",
  "elongated_triangular_orthobicupola",
  "elongated_triangular_gyrobicupola",
  "elongated_square_gyrobicupola",
  "elongated_pentagonal_orthobicupola",
  "elongated_pentagonal_gyrobicupola",
  "elongated_pentagonal_orthocupolarotunda",
  "elongated_pentagonal_gyrocupolarotunda",
  "elongated_pentagonal_orthobirotunda",
  "elongated_pentagonal_gyrobirotunda",
  "gyroelongated_triangular_bicupola",
  "gyroelongated_square_bicupola",
  "gyroelongated_pentagonal_bicupola",
  "gyroelongated_pentagonal_cupolarotunda",
  "gyroelongated_pentagonal_birotunda",
  "augmented_triangular_prism",
  "biaugmented_triangular_prism",
  "triaugmented_triangular_prism",
  "augmented_pentagonal_prism",
  "biaugmented_pentagonal_prism",
  "augmented_hexagonal_prism",
  "parabiaugmented_hexagonal_prism",
  "metabiaugmented_hexagonal_prism",
  "triaugmented_hexagonal_prism",
  "augmented_dodecahedron",
  "parabiaugmented_dodecahedron",
  "metabiaugmented_dodecahedron",
  "triaugmented_dodecahedron",
  "metabidiminished_icosahedron",
  "tridiminished_icosahedron",
  "augmented_tridiminished_icosahedron",
  "augmented_truncated_tetrahedron",
  "augmented_truncated_cube",
  "biaugmented_truncated_cube",
  "augmented_truncated_dodecahedron",
  "parabiaugmented_truncated_dodecahedron",
  "metabiaugmented_truncated_dodecahedron",
  "triaugmented_truncated_dodecahedron",
  "gyrate_rhombicosidodecahedron",
  "parabigyrate_rhombicosidodecahedron",
  "metabigyrate_rhombicosidodecahedron",
  "trigyrate_rhombicosidodecahedron",
  "diminished_rhombicosidodecahedron",
  "paragyrate_diminished_rhombicosidodecahedron",
  "metagyrate_diminished_rhombicosidodecahedron",
  "bigyrate_diminished_rhombicosidodecahedron",
  "parabidiminished_rhombicosidodecahedron",
  "metabidiminished_rhombicosidodecahedron",
  "gyrate_bidiminished_rhombicosidodecahedron",
  "tridiminished_rhombicosidodecahedron",
  "snub_disphenoid",
  "snub_square_antiprism",
  "sphenocorona",
  "augmented_sphenocorona",
  "sphenomegacorona",
  "hebesphenomegacorona",
  "disphenocingulum",
  "bilunabirotunda",
  "triangular_hebesphenorotunda",
] as const;
/** The Platonic solids of the surface space: their nofold problems are planar problems of one face. */
export const SURFACE_PLATONIC = SURFACE_SOLIDS.slice(0, 5);
/** The Archimedean solids: nofold values split among two or three regular face kinds. */
export const SURFACE_ARCHIMEDEAN: readonly string[] = SURFACE_SOLIDS.slice(5, 18);
/** The Catalan solids of the surface space: their faces are irregular, so their nofold problems are no 2D in 2D problem. */
export const SURFACE_CATALAN: readonly string[] = SURFACE_SOLIDS.slice(18, 31);
/** The 92 Johnson solids of the surface space (J1 to J92): regular faces of several kinds, no symmetry in general. */
export const SURFACE_JOHNSON: readonly string[] = SURFACE_SOLIDS.slice(-92);
export const SURFACE_MODES = ["fold", "nofold"] as const;
/** The lattice families of the torus space, in the order the catalogue lists them. */
export const TORUS_FAMILIES = ["sq", "hex", "free"] as const;
/** The polytopes and pieces of the boundary space, in the order the catalogue lists them. */
export const BOUNDARY_POLYTOPES: readonly PolytopeName[] = POLYTOPES;
export const BOUNDARY_PIECES: readonly PieceName[] = PIECES;

export interface ParsedSpaceId {
  space: SpaceName;
  id: string;
  /** surface {solid, mode, N, P}; curved {K, N, M, P}; sphere {N, P}; torus {family, N, P}; boundary {polytope, piece, P}; polyhedra and balls {code, piece, container, P}; ndim {d, piece, container, P} */
  fields: Record<string, string | number>;
  P: number;
}

/** A shape code (0 for a disk, else 3 to 100 sides) or a piece count (1 to 9999), in its one written form. */
const INT = /^(0|[1-9]\d{0,3})$/;

function shapeCode(text: string): number | null {
  if (!INT.test(text)) return null;
  const n = Number(text);
  return n === 0 || (n >= 3 && n <= 100) ? n : null;
}

function pieceCount(text: string): number | null {
  if (!INT.test(text)) return null;
  const n = Number(text);
  return n >= 1 ? n : null;
}

/**
 * K as the curved records write it: an integer as an integer ("1", "-1"), any other value as
 * Python's repr of the binary64 number ("1.225778283313099", "1e-06"). JavaScript and Python both
 * print the shortest digits that round-trip; they differ only in when they switch to exponent
 * notation and in how they write the exponent.
 */
export function formatCurvature(K: number): string {
  if (!Number.isFinite(K)) throw new RangeError(`K must be finite, not ${K}`);
  if (Object.is(K, -0)) return "0";
  if (Number.isInteger(K) && Math.abs(K) < 1e16) return String(K);
  const [mantissa, exp] = K.toExponential().split("e");
  const e = Number(exp);
  // Python's repr uses fixed notation for decimal exponents -4 <= e < 16, where it agrees with String()
  if (e >= -4 && e < 16) return String(K);
  const digits = String(Math.abs(e)).padStart(2, "0");
  return `${mantissa}e${e < 0 ? "-" : "+"}${digits}`;
}

const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?(e[-+]\d+)?$/;

/** The fields of a problem id, or a message saying what is wrong with it. */
export function parseSpaceId(space: SpaceName, id: unknown): ParsedSpaceId | string {
  if (typeof id !== "string") return "id must be a string";
  if (id.length > 100) return "id is too long";
  const parts = id.split("/");
  if (parts[0] !== space) return `the id of a ${space} problem starts with "${space}/"`;
  const bad = (pattern: string) => `"${id}" is not a ${space} problem id: the form is ${pattern}`;
  switch (space) {
    case "surface": {
      const pattern =
        "surface/<solid>/<mode>/<N>/<P>, solid a Platonic solid (tetrahedron, cube, octahedron, dodecahedron, icosahedron), " +
        "an Archimedean solid (such as snub_cube), a Catalan solid (such as rhombic_dodecahedron), a prism (prism3, prism5 to prism12), an antiprism " +
        "(antiprism4 to antiprism12) or a Johnson solid (such as square_pyramid or snub_disphenoid), mode fold or nofold";
      if (parts.length !== 5) return bad(pattern);
      const [, solid, mode, n, p] = parts;
      const N = shapeCode(n);
      const P = pieceCount(p);
      if (
        !(SURFACE_SOLIDS as readonly string[]).includes(solid) ||
        !(SURFACE_MODES as readonly string[]).includes(mode)
      )
        return bad(pattern);
      if (N === null || P === null) return bad(pattern);
      return { space, id, fields: { solid, mode, N, P }, P };
    }
    case "curved": {
      const pattern = "curved/<K>/<N>/<M>/<P>, K written as the catalogue writes it (for example 1, -1 or 1e-06)";
      if (parts.length !== 5) return bad(pattern);
      const [, k, n, m, p] = parts;
      const N = shapeCode(n);
      const M = shapeCode(m);
      const P = pieceCount(p);
      if (!DECIMAL.test(k) || N === null || M === null || P === null) return bad(pattern);
      const K = Number(k);
      if (!Number.isFinite(K)) return bad(pattern);
      const written = formatCurvature(K);
      if (written !== k) return `"${id}" is not written in its one form: K is written ${written}`;
      return { space, id, fields: { K, N, M, P }, P };
    }
    case "sphere": {
      const pattern = "sphere/<N>/<P>";
      if (parts.length !== 3) return bad(pattern);
      const N = shapeCode(parts[1]);
      const P = pieceCount(parts[2]);
      if (N === null || P === null) return bad(pattern);
      return { space, id, fields: { N, P }, P };
    }
    case "torus": {
      const pattern = "torus/<family>/<N>/<P>, family one of sq, hex, free";
      if (parts.length !== 4) return bad(pattern);
      const [, family, n, p] = parts;
      const N = shapeCode(n);
      const P = pieceCount(p);
      if (!(TORUS_FAMILIES as readonly string[]).includes(family) || N === null || P === null) return bad(pattern);
      return { space, id, fields: { family, N, P }, P };
    }
    case "boundary": {
      const pattern = `boundary/<polytope>/<piece>/<P>, polytope ${POLYTOPES.join(" or ")}, piece ${PIECES.join(" or ")}`;
      const parsed = parseBoundaryId(id);
      // the package's sentence says which part is wrong, once the id has the right number of parts
      if (typeof parsed === "string") return parts.length === 4 ? `${bad(pattern)}. ${parsed}` : bad(pattern);
      return { space, id, fields: { polytope: parsed.polytope, piece: parsed.piece, P: parsed.P }, P: parsed.P };
    }
    case "polyhedra": {
      const pattern = "polyhedra/<code>/<P>, code the wiki's <piece>in<container> such as cubincub or cubintet";
      if (parts.length !== 3) return bad(pattern);
      const problem = problemNameOf(parts[1]);
      const P = pieceCount(parts[2]);
      if (!problem || P === null) return bad(pattern);
      return { space, id, fields: { code: problem.code, piece: problem.piece, container: problem.container, P }, P };
    }
    case "balls": {
      const pattern = `balls/<code>/<P>, code ${BALLS_CODES_HINT}`;
      const parsed = parseBallsId(id);
      if (typeof parsed === "string") return bad(pattern);
      const { problem, P } = parsed;
      return { space, id, fields: { code: problem.code, piece: problem.piece, container: problem.container, P }, P };
    }
    case "ndim": {
      const parsed = parseNdId(id);
      if (typeof parsed === "string") return `"${id}" is not an ndim problem id: the form is ${ND_ID_FORM}`;
      return {
        space,
        id,
        fields: { d: parsed.d, piece: parsed.piece, container: parsed.container, P: parsed.P },
        P: parsed.P,
      };
    }
  }
}

/** The space an id belongs to (its first segment), or null. */
export function spaceOfId(id: string): SpaceName | null {
  const head = id.split("/", 1)[0];
  return isSpaceName(head) ? head : null;
}

/** The id of a problem from its fields; the inverse of parseSpaceId. */
export function formatSpaceId(space: SpaceName, fields: Record<string, string | number>): string {
  switch (space) {
    case "surface":
      return `surface/${fields.solid}/${fields.mode}/${fields.N}/${fields.P}`;
    case "curved":
      return `curved/${formatCurvature(Number(fields.K))}/${fields.N}/${fields.M}/${fields.P}`;
    case "sphere":
      return `sphere/${fields.N}/${fields.P}`;
    case "torus":
      return `torus/${fields.family}/${fields.N}/${fields.P}`;
    case "boundary":
      // as formatBoundaryId writes it, but without its throw on fields that name no problem
      return `boundary/${fields.polytope}/${fields.piece}/${fields.P}`;
    case "polyhedra":
      return `polyhedra/${fields.code}/${fields.P}`;
    case "balls":
      return `balls/${fields.code}/${fields.P}`;
    case "ndim":
      return `ndim/${fields.d}/${fields.piece}/${fields.container}/${fields.P}`;
  }
}
