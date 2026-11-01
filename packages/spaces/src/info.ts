/**
 * What GET /api/spaces says about each space, apart from its problem and record counts, which come from the
 * loaded catalogue. Pure data.
 */
import { MAX_S } from "@polypack/boundary";
import { BALLS_MAX_COORD, BALLS_MAX_SIZE, BALL_RADIUS } from "@polypack/balls";
import { SCORE_TIE } from "@polypack/geometry";
import {
  POLYHEDRA_MAX_COORD,
  POLYHEDRA_MAX_QUATERNION,
  POLYHEDRA_MIN_QUATERNION_NORM,
  POLYHEDRA_RECORD_MARGIN,
} from "@polypack/polyhedra";
import { SpaceExhibit, SpaceInfo, SpaceName } from "./types";

const NOTES = "https://github.com/sinkomr/PolyPack/blob/main/docs/spaces";

/** PolyPack's touching tolerance, the same as on the main site: overlaps deeper than this are rejected. */
export const SPACE_TOL = 1e-9;
/**
 * Tolerance of the strict check of a configuration that beats a research record (validate.ts):
 * far below the touching tolerance, and above the float error of the validators at these sizes.
 */
export const SPACE_STRICT_TOL = 1e-11;
/** Largest absolute value of a coordinate, an angle or a quaternion component, each on its own. */
export const SPACE_MAX_COORD = 1e4;
/** Smallest norm of a sphere piece's quaternion: a tinier one's squared norm can underflow. */
export const SPACE_MIN_QUATERNION_NORM = 1e-6;
/**
 * Most chains of faces one piece may cross in the fold check. [CALC] Real packings on the Platonic
 * solids need at most about 35; random single pieces at the one-piece and area scales need up to 126
 * on the other solids (antiprisms with many sides, whose small triangles a piece crosses in numbers).
 */
export const SURFACE_MAX_CHAINS = 600;
/** Most lattice translates checked per pair of torus pieces; a reduced basis needs at most about 60. */
export const TORUS_MAX_TRANSLATES = 1000;
/**
 * Most chains of cells one boundary piece may cross in the check (the boundary validator's
 * maxChains). [CALC] Every research record, and every one of 1,449 random valid single balls and
 * cubes (s from sqrt 2 and 0.95 up), needs at most 79; the cap is 13 times that.
 */
export const BOUNDARY_MAX_CHAINS = 1024;
/** Largest edge s of a boundary configuration: the boundary validator's MAX_S. */
export const BOUNDARY_MAX_S = MAX_S;

/**
 * Relative margin by which an entry must beat a space's research record (score < certified (1 - margin)) to count
 * as better than it. The tie tolerance, except for polyhedra: its records keep the wiki's clearance of up to 1e-7
 * between pieces and from the walls (up to 2.6e-7 of s where the touching limit is known), and removing that
 * clearance is not a better packing. Site entries still compete with each other by the tie tolerance. The balls
 * space's records keep a clearance of only 1e-10 (exact rational and interval certificates need no float slack),
 * which costs about 5e-11 of s relative, so the tie tolerance serves as its margin.
 */
export const SPACE_RECORD_MARGIN: Record<SpaceName, number> = {
  surface: SCORE_TIE,
  curved: SCORE_TIE,
  sphere: SCORE_TIE,
  torus: SCORE_TIE,
  boundary: SCORE_TIE,
  polyhedra: POLYHEDRA_RECORD_MARGIN,
  balls: SCORE_TIE,
  // records keep the wiki's clearance of 1e-7 between pieces and from the walls (as polyhedra)
  ndim: POLYHEDRA_RECORD_MARGIN,
};

/** Largest absolute value of a polyhedra quaternion component (only its direction matters; see the polyhedra package). */
export { POLYHEDRA_MAX_QUATERNION };

/** The space's notes on GitHub. */
export function spaceDocsUrl(file: string): string {
  return `${NOTES}/${file}`;
}

/** The common rule of every space, as the conventions state it. */
const VALIDITY = `pieces may touch; the server rejects overlaps deeper than ${SPACE_TOL} (in piece units) with its floating-point validator of the space`;
const SCORING =
  "the score is the size stated in the configuration; the server checks the configuration at that size and does not shrink it";
const IMPROVEMENT = `an entry is kept only when its score is below the problem's best value (the research record or the site leader, whichever is smaller) by more than a relative ${SCORE_TIE}; one below the research record must also be valid with overlaps of at most ${SPACE_STRICT_TOL}`;

export const SPACE_INFO: Record<SpaceName, Omit<SpaceInfo, "problems" | "records" | "domain">> = {
  surface: {
    space: "surface",
    title: "Polyhedral surfaces",
    summary:
      "Unit pieces packed on the surface of a convex solid, as small as possible: a Platonic solid (tetrahedron, cube, octahedron, dodecahedron, icosahedron), one of the 13 Archimedean or 13 Catalan solids, a prism, an antiprism or one of the 92 Johnson solids. In fold mode a piece may bend over edges onto the neighbouring faces; in nofold mode each piece stays inside one face.",
    score: "the scale s of the solid (its edge length for the Platonic, Archimedean and Johnson solids, prisms and antiprisms); smaller is better",
    problem_id: "surface/<solid>/<mode>/<N>/<P>",
    conventions: {
      units: "polygon pieces have side 1, disks (N = 0) diameter 1; angles in radians",
      solid:
        "solid is a Platonic solid (tetrahedron, cube, octahedron, dodecahedron, icosahedron) of edge s, an Archimedean solid (the same names and unit-edge normalisation as the polyhedra space) of edge s, a Catalan solid (rhombic_dodecahedron, triakis_tetrahedron, deltoidal_icositetrahedron, pentagonal_icositetrahedron, tetrakis_hexahedron, triakis_octahedron, rhombic_triacontahedron, disdyakis_dodecahedron, deltoidal_hexecontahedron, pentagonal_hexecontahedron, pentakis_dodecahedron, triakis_icosahedron, disdyakis_triacontahedron) scaled by s from the polyhedra space's canonical one (the polar reciprocal of the unit-edge Archimedean solid about the midsphere), a prism (prism3, prism5 to prism12) or an antiprism (antiprism4 to antiprism12) of edge s, or a Johnson solid (J1 to J92, the polyhedra space's names such as square_pyramid, gyrobifastigium and triangular_hebesphenorotunda, in its unit-edge normalisation; exact coordinates from python/polyhedra/solids_exact.json after Johnson 1966 and Zalgaller 1967, J44 to J48 in one handedness) of edge s. A face's frame has its origin at the foot of the perpendicular from the solid's centre (for a Johnson solid: at the face's centre, the mean of its vertices) and its last edge (frame vertex M - 1 to frame vertex 0) horizontal at the bottom; a regular face is the regular M-gon of side s centred at the origin, frame vertex k at angle -pi/2 + pi/M + 2 pi k/M. data/surface/solids.json lists the faces and how their edges are glued",
      pose: "{face, x, y, theta}: the piece centre (x, y) lies in the closed face `face`, in that face's frame; piece vertex k is at angle theta + pi/2 + 2 pi k/N about the centre",
      modes:
        "nofold: every piece lies in one closed face; fold: a rigid flat piece is laid out from its centre and continues across edges onto the next faces, no vertex of the solid may lie inside a piece and a piece may not overlap itself",
      configuration: "{s, pieces: [{face, x, y, theta}, ...]} with P pieces",
      score: "s, the scale of the solid (the edge for unit-edge solids); smaller is better",
      validity: VALIDITY,
      scoring: SCORING,
      improvement: IMPROVEMENT,
      work_limit: `the fold check gives up with an error when one piece crosses more than ${SURFACE_MAX_CHAINS} chains of faces (real packings need far fewer); x, y and theta are each at most ${SPACE_MAX_COORD} in absolute value`,
    },
    viewer: "/spaces/surface.html",
    docs: spaceDocsUrl("SURFACE.md"),
  },
  curved: {
    space: "curved",
    title: "Constant curvature",
    summary:
      "Unit pieces (polygons of side 1, disks of diameter 1) in the smallest regular polygon or disk on a surface of constant curvature K: the hyperbolic plane (K < 0), the flat plane (K = 0) or a sphere of radius 1/sqrt(K) (K > 0). Some problems have no packing at all, because the pieces do not fit in any container.",
    score: "the container's side s (polygon) or diameter d (disk) as a geodesic length at curvature K; smaller is better",
    problem_id: "curved/<K>/<N>/<M>/<P>",
    conventions: {
      space:
        "the complete surface of constant curvature K: hyperbolic plane for K < 0, Euclidean plane for K = 0, sphere of radius 1/sqrt(K) for K > 0",
      units: "geodesic lengths at curvature K; polygon pieces have side 1, disks (N = 0) diameter 1; angles in radians",
      container:
        "centred at the origin O with a horizontal bottom edge: a regular M-gon of geodesic side s, or a disk of diameter d (M = 0); for K > 0 the container lies in the open hemisphere around O",
      pose: "{x, y, theta}: the centre is the point at geodesic distance sqrt(x^2 + y^2) from O in direction (x, y); theta is the piece's angle relative to the frame carried from O along that geodesic, and a vertex points up at theta = 0; at K = 0 this is PolyPack's usual pose",
      configuration: "{size, pieces: [{x, y, theta}, ...]} with P pieces; size is s, or d (the diameter) for a disk container",
      score: "size; smaller is better",
      validity: VALIDITY + "; gaps and protrusions are signed geodesic distances",
      scoring: SCORING,
      improvement: IMPROVEMENT,
      id: "K is written as the catalogue writes it: integers as integers, other values as the shortest decimal that gives the same binary64 number (1e-06, 1.225778283313099)",
    },
    viewer: "/spaces/curved.html",
    docs: spaceDocsUrl("CURVED.md"),
  },
  sphere: {
    space: "sphere",
    title: "Whole sphere",
    summary:
      "Congruent pieces on a whole sphere with no container: the score is the smallest sphere radius that holds them all. For disks this is the Tammes problem.",
    score: "the sphere radius rho; smaller is better",
    problem_id: "sphere/<N>/<P>",
    conventions: {
      space: "the whole sphere of radius rho (curvature 1/rho^2); there is no container",
      units:
        "disks (N = 0) of geodesic diameter 1, or regular spherical N-gons of geodesic side 1, on the sphere of radius rho",
      pose: `{q: [w, x, y, z]}: a quaternion of norm at least ${SPACE_MIN_QUATERNION_NORM.toExponential()}, each component at most ${SPACE_MAX_COORD} in absolute value; the piece is the standard piece turned by the rotation of q/|q| (v -> q v q*)`,
      standard_piece:
        "centred at the north pole (0, 0, 1) of the unit sphere, vertex k at (sin R cos phi_k, sin R sin phi_k, cos R) with phi_k = pi/2 + 2 pi k/N and sin(1/(2 rho)) = sin R sin(pi/N)",
      configuration: "{rho, pieces: [{q: [w, x, y, z]}, ...]} with P pieces",
      score: "rho; smaller is better",
      validity: VALIDITY + "; gaps are measured in length units on the sphere of radius rho",
      scoring: SCORING,
      improvement: IMPROVEMENT,
    },
    viewer: "/spaces/sphere.html",
    docs: spaceDocsUrl("SPHERE.md"),
  },
  torus: {
    space: "torus",
    title: "Flat tori",
    summary:
      "Pieces on a flat torus, a plane that repeats along a lattice: a square or hexagonal torus of side L, or any lattice of the solver's choice. Each piece must also miss its own repeated copies.",
    score: "L for the square (sq) and hexagonal (hex) tori, sqrt|det(b1, b2)| for a free lattice; smaller is better",
    problem_id: "torus/<family>/<N>/<P>",
    conventions: {
      families:
        "sq: lattice b1 = L (1, 0), b2 = L (0, 1), score L; hex: b1 = L (1, 0), b2 = L (1/2, sqrt(3)/2), score L; free: any basis b1, b2, score sqrt|det(b1, b2)|",
      units: "polygon pieces have side 1, disks (N = 0) diameter 1; angles in radians",
      pose: "[x, y, theta] in the plane; positions count modulo the lattice; piece vertex k at (x, y) + R (cos a_k, sin a_k), a_k = theta + pi/2 + 2 pi k/N, R = 1/(2 sin(pi/N))",
      configuration:
        "{lattice: {L} for sq and hex or {b1: [x, y], b2: [x, y]} for free, poses: [[x, y, theta], ...]} with P poses",
      score: "L or sqrt|det(b1, b2)|; smaller is better",
      validity:
        VALIDITY +
        "; the pieces and all their lattice translates must have disjoint interiors, so a piece may not overlap its own translates either",
      scoring: SCORING,
      improvement: IMPROVEMENT,
      work_limit: `a free basis must be reduced well enough that at most ${TORUS_MAX_TRANSLATES} lattice translates per pair of pieces need checking (a Lagrange-Gauss reduced basis always is); x, y and theta of each pose are each at most ${SPACE_MAX_COORD} in absolute value`,
      stored:
        "a kept entry with a free lattice is stored with its basis Lagrange-Gauss reduced and det(b1, b2) > 0: the same lattice and the same score, with the poses as sent",
    },
    viewer: "/spaces/torus.html",
    docs: spaceDocsUrl("TORUS.md"),
  },
  boundary: {
    space: "boundary",
    title: "Polytope boundaries",
    summary:
      "Balls of diameter 1 or unit cubes on the boundary of a 4D polytope, starting with the tesseract: its boundary is 8 solid cubes glued face to face, a closed 3D space. A piece may fold across the square faces where two cells meet, but no edge of the polytope may pass through it.",
    score: "the edge length s of the polytope; smaller is better",
    problem_id: "boundary/<polytope>/<piece>/<P>",
    conventions: {
      polytope:
        "the tesseract [-s/2, s/2]^4 of edge s; its boundary is 8 cubes (cells), every two of which share a square face unless they are opposite; edges and vertices may not lie inside a piece",
      cells:
        "cell 2 i + (sigma > 0) is the cube x_i = sigma s/2, for i = 0..3 and sigma = -1 or +1: cell 0 is x_0 = -s/2, cell 1 is x_0 = +s/2, ..., cell 7 is x_3 = +s/2",
      frame:
        "a point of a cell has local coordinates u = its other three R^4 coordinates in increasing order of index, so the cell is the cube [-s/2, s/2]^3 centred at the origin (in cell 5, x_2 = +s/2, u = (x_0, x_1, x_3))",
      units:
        `balls have diameter 1 (radius ${BALL_RADIUS}), cubes edge 1 (the cube [-1/2, 1/2]^3 about its centre); lengths scale with s, the pieces do not`,
      pose: `{cell, u, q?}: cell is the anchor cell, which holds the piece's centre; u = [u0, u1, u2] is the centre in that cell's local coordinates at s and must lie in the closed cell (each component at most ${SPACE_MAX_COORD} in absolute value); q = [w, x, y, z] is a unit quaternion (norm within 1e-9 of 1) that turns a cube in the anchor's frame, absent for an axis-aligned cube; balls have no q`,
      fold: "a piece is laid out from its centre by straight segments that continue across the square faces into the next cells, unfolded flat; no point of the edges or vertices may lie inside a piece, and a piece may not overlap itself",
      configuration: "{s, pieces: [{cell, u, q?}, ...]} with P pieces",
      score: "s, the edge of the polytope; smaller is better",
      validity: VALIDITY,
      scoring: SCORING,
      improvement: IMPROVEMENT,
      nofold:
        "each problem's listing also gives its nofold value (every piece inside one cell, no folding) and the research record's gain over it, as `extra`",
      work_limit: `s is at most ${BOUNDARY_MAX_S}; the check gives up with a reason when one piece crosses more than ${BOUNDARY_MAX_CHAINS} chains of cells (real packings need at most about 80); each component of u and q is at most ${SPACE_MAX_COORD} in absolute value`,
    },
    viewer: "/spaces/boundary.html",
    docs: spaceDocsUrl("BOUNDARY.md"),
  },
  polyhedra: {
    space: "polyhedra",
    title: "Polyhedra",
    summary:
      "3D in 3D: equal polyhedra (Platonic, Archimedean and Catalan solids, prisms and antiprisms, bipyramids and trapezohedra, and the 92 Johnson solids) packed in the smallest scaled copy of a container polyhedron. The problems and research records are those of polyhedrainpolyhedra.wiki, with PolyPack's improvements, and PolyPack's own problems (prisms and antiprisms with 7, 9, 10 and 11 sides; bipyramids and trapezohedra) with its records. Every ordered pair of the 186 solids is a problem (34,596 pairs, 17,263,404 problems with P from 2 to 500); the 34,446 pairs beyond the 150 named problems have no records yet.",
    score: "the scale s of the container solid (its edge length when the container has unit edges); smaller is better",
    problem_id: "polyhedra/<code>/<P>",
    conventions: {
      problems:
        "code is the wiki's <piece>in<container>, e.g. cubintet (cubes in a tetrahedron) or pr3l15incub (triangular prisms of height 1.5 in a cube), or the same for any ordered pair of the 186 solids, the Johnson solids having the codes j01 to j92 (j05inj92: J5 in J92); P from 2 to 500",
      solids:
        "the wiki's canonical solids, centred at the origin: unit edges, except the Catalan solids (polar reciprocals of the unit-edge Archimedean solids about the midsphere) and the elongated prisms (base edges 1, lateral edges 1.5, 2 or 3); PolyPack's bipyramids and trapezohedra are likewise the polar reciprocals of the unit-edge prisms and antiprisms about the midsphere. The 92 Johnson solids (Johnson 1966; Zalgaller 1967 for the completeness of the list) are J1 square_pyramid to J92 triangular_hebesphenorotunda, codes j01 to j92, with unit edges, regular faces and the origin at the vertex centroid; J44 to J48 are chiral and only one handedness is stored. Their coordinates are exact algebraic numbers from python/polyhedra/solids_exact.json, which also holds the other solids",
      container: "s times the canonical container solid, centred at the origin in its canonical orientation",
      pose: `[x, y, z, qw, qx, qy, qz]: the canonical piece turned by the rotation of q / |q| (v -> q v q*) and centred at (x, y, z); x, y and z at most ${POLYHEDRA_MAX_COORD} and quaternion components at most ${POLYHEDRA_MAX_QUATERNION} in absolute value, |q| at least ${POLYHEDRA_MIN_QUATERNION_NORM.toExponential()}`,
      configuration: "{s, pieces: [[x, y, z, qw, qx, qy, qz], ...]} with P pieces",
      score: "s; smaller is better",
      validity:
        VALIDITY +
        "; the overlap of two pieces is their penetration depth, found by the separating-axis test over the face normals of both pieces and the cross products of their edges",
      scoring: SCORING,
      improvement: `an entry is kept only when its score is below the site leader's by more than a relative ${SCORE_TIE} and below the research record's certified s by more than a relative ${POLYHEDRA_RECORD_MARGIN.toExponential()}: the records keep the wiki's clearances between pieces and from the walls (up to 1e-7), and removing them is not a better packing; one below the research record must also be valid with overlaps of at most ${SPACE_STRICT_TOL}`,
    },
    viewer: "/spaces/polyhedra.html",
    docs: spaceDocsUrl("POLYHEDRA.md"),
  },
  balls: {
    space: "balls",
    title: "Balls",
    summary:
      "3D in 3D: balls of diameter 1 packed in the smallest ball or in the smallest copy of any of the polyhedra space's 186 solids (the classic sphere-packing problems, and balls in a cube, a prism, a Catalan solid), and each of those solids packed in the smallest ball. The problems have no research records yet; the first valid entry of each is kept.",
    score:
      "the container's size s: the diameter of the container ball, or the scale of the container solid (the edge of the cube); smaller is better",
    problem_id: "balls/<code>/<P>",
    conventions: {
      problems:
        "code is <piece>in<container>, 373 of them: ballinball (balls in a ball), ballin<solid> (balls in a solid: ballincub, ballinpkd, ballinpr3, ...) and <solid>inball (a solid in a ball: tetinball, kttinball, pr3l15inball, ...), with <solid> the polyhedra space's code of one of its 186 solids (GET /api/spaces lists all 373); P from 2 to 100",
      units: `balls have diameter 1 (radius ${BALL_RADIUS}); the solids are the polyhedra space's canonical solids (edge 1 for the Platonic, Archimedean, prism, antiprism and Johnson solids, 1.5, 2 or 3 for the lateral edges of the elongated prisms, the Catalan, bipyramid and trapezohedron solids their duals), centred at their vertex centroid at the origin`,
      container:
        "the ball of diameter s about the origin, or s times a canonical solid of the polyhedra space about its vertex centroid (for the cube the cube [-s/2, s/2]^3 of edge s with its faces normal to the axes): the intersection of the half-spaces N_f . x <= s b_f over its faces, N_f the unit outward normal and b_f the offset of face f",
      pose: `a ball is its centre [x, y, z]; a solid is [x, y, z, qw, qx, qy, qz]: the canonical solid turned by the rotation of q / |q| (v -> q v q*) and centred at (x, y, z); x, y and z at most ${BALLS_MAX_COORD} and quaternion components at most ${POLYHEDRA_MAX_QUATERNION} in absolute value, |q| at least ${POLYHEDRA_MIN_QUATERNION_NORM.toExponential()}`,
      configuration: `{s, pieces: [...]} with P pieces; s positive and at most ${BALLS_MAX_SIZE}`,
      score: "s; smaller is better",
      validity:
        VALIDITY +
        "; two balls overlap by 2 r minus the distance of their centres, a ball sticks out of a ball by |c| + r - s/2, of a cube by |c_k| + r - s/2 and of another solid by the largest over faces of N_f . c + r - s b_f (r the ball radius); a solid sticks out of the ball by the largest vertex distance minus s/2, and two solids overlap by their penetration depth (the polyhedra space's separating-axis test)",
      scoring: SCORING,
      improvement: IMPROVEMENT,
    },
    // no standalone viewer: the board draws every problem (#space=balls opens its first one)
    viewer: "/#space=balls",
    docs: spaceDocsUrl("BALLS.md"),
  },
  ndim: {
    space: "ndim",
    title: "nD in nD",
    summary:
      "4D to 10D: equal convex polytopes (the simplex, hypercube and orthoplex of each dimension, the demicube from 5D, the 24-, 120- and 600-cell in 4D, the Gosset polytopes 2_21 and 1_22 in 6D, 3_21 in 7D and 4_21 in 8D) or balls of diameter 1 packed in the smallest scaled copy of a container polytope or ball. The research records are the regular polytopes in 4D to 6D of polyhedrainpolyhedra.wiki's higher-polytope tab, re-certified; every other problem has none yet and takes its first valid entry.",
    score:
      "the container's size s: the scale of the container polytope (its edge when the container has unit edges), or the diameter of the container ball; smaller is better",
    problem_id: "ndim/<d>/<piece>/<container>/<P>",
    conventions: {
      problems:
        "d from 4 to 10; piece and container are a polytope of that dimension (simplex, cube, ortho, demi from 5D, 24cell, 120cell and 600cell in 4D, 221 and 122 in 6D, 321 in 7D, 421 in 8D) or ball, any ordered pair, e.g. ndim/4/cube/ortho/12 (hypercubes in an orthoplex) or ndim/6/ball/221/9; P from 2 to 40 in 4D, 32 in 5D, 24 in 6D and 20 from 7D (GET /api/spaces lists the ranges)",
      units:
        "polytopes have unit edges and are centred at their vertex centroid; balls have diameter 1 (radius 0.5); the catalogue is docs/spaces/NDIM.md section 2 (the generator proves each polytope in exact arithmetic)",
      container:
        "s times the catalogue polytope about the origin (the intersection of the half-spaces N_f . x <= s b_f, N_f the unit outward normal and b_f the offset of facet f), or the ball of diameter s about the origin",
      pose: `a polytope piece is [t_1..t_d, k_1..k_m, flip] with m = d(d-1)/2 and the flip optional (0 when absent): the canonical piece turned by R = D (I - S)^-1 (I + S), S the skew matrix with S[i][j] = k (i < j, row by row) and D the diagonal matrix with -1 at the set bits of the flip (an even number of them), then centred at t; centre coordinates at most ${SPACE_MAX_COORD}, each k at most 32 in absolute value; a ball is its centre [t_1..t_d]`,
      configuration: "{s, pieces: [pose, ...]} with P poses; s positive and at most 1e6",
      score: "s; smaller is better",
      validity:
        VALIDITY +
        "; two pieces overlap by their penetration depth (GJK and EPA on the Minkowski difference), a polytope sticks out by the largest N_f . x - s b_f over its vertices and facets, a ball piece by N_f . c + 0.5 - s b_f, and a ball container by the farthest point's distance minus s/2",
      scoring: SCORING,
      improvement: `an entry is kept only when its score is below the site leader's by more than a relative ${SCORE_TIE} and below the research record's s by more than a relative ${POLYHEDRA_RECORD_MARGIN.toExponential()}: the records keep the wiki's clearance of 1e-7 between pieces and from the walls, and removing it is not a better packing; an entry of a problem without a record, or one below the record, must also be valid with overlaps of at most ${SPACE_STRICT_TOL}`,
      work_limit:
        "a check is stopped, with a reason, after 4 s of processor time; checks of large containers (the 4_21 polytope has 19,440 facets) or many pieces share the server's queue of heavy checks, one at a time, and are refused with 503 when it is full",
    },
    // no standalone viewer: phase E of the nD plan adds the board and the records page
    viewer: "/#space=ndim",
    docs: spaceDocsUrl("NDIM.md"),
  },
};

/** Research material shown on the site that takes no submissions. */
export const SPACE_EXHIBITS: SpaceExhibit[] = [
  {
    name: "sweep",
    title: "Curvature sweeps",
    summary:
      "How the best packings change as the curvature K changes slowly. The best size never jumps, but it has corners, and the arrangement of the pieces can jump where two arrangements are equally good.",
    viewer: "/spaces/sweep.html",
    docs: spaceDocsUrl("CURVED_SWEEP.md"),
  },
];
