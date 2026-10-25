/**
 * What GET /api/spaces says about each space, apart from its problem count, which comes from the
 * loaded catalogue. Pure data.
 */
import { SCORE_TIE } from "@polypack/geometry";
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
/** Most chains of faces one piece may cross in the fold check; real packings need at most about 35. */
export const SURFACE_MAX_CHAINS = 200;
/** Most lattice translates checked per pair of torus pieces; a reduced basis needs at most about 60. */
export const TORUS_MAX_TRANSLATES = 1000;

/** The space's notes on GitHub. */
export function spaceDocsUrl(file: string): string {
  return `${NOTES}/${file}`;
}

/** The common rule of every space, as the conventions state it. */
const VALIDITY = `pieces may touch; the server rejects overlaps deeper than ${SPACE_TOL} (in piece units) with its floating-point validator of the space`;
const SCORING =
  "the score is the size stated in the configuration; the server checks the configuration at that size and does not shrink it";
const IMPROVEMENT = `an entry is kept only when its score is below the problem's best value (the research record or the site leader, whichever is smaller) by more than a relative ${SCORE_TIE}; one below the research record must also be valid with overlaps of at most ${SPACE_STRICT_TOL}`;

export const SPACE_INFO: Record<SpaceName, Omit<SpaceInfo, "problems">> = {
  surface: {
    space: "surface",
    title: "Platonic surfaces",
    summary:
      "Unit pieces packed on the surface of a regular tetrahedron, cube, octahedron, dodecahedron or icosahedron, as small as possible. In fold mode a piece may bend over edges onto the neighbouring faces; in nofold mode each piece stays inside one face.",
    score: "the edge length s of the solid; smaller is better",
    problem_id: "surface/<solid>/<mode>/<N>/<P>",
    conventions: {
      units: "polygon pieces have side 1, disks (N = 0) radius 1; angles in radians",
      solid:
        "solid is tetrahedron, cube, octahedron, dodecahedron or icosahedron, of edge s; face f is a regular M-gon of side s centred at the origin of its own frame with a horizontal bottom edge, frame vertex k at angle -pi/2 + pi/M + 2 pi k/M; data/surface/solids.json lists the faces and how their edges are glued",
      pose: "{face, x, y, theta}: the piece centre (x, y) lies in the closed face `face`, in that face's frame; piece vertex k is at angle theta + pi/2 + 2 pi k/N about the centre",
      modes:
        "nofold: every piece lies in one closed face; fold: a rigid flat piece is laid out from its centre and continues across edges onto the next faces, no vertex of the solid may lie inside a piece and a piece may not overlap itself",
      configuration: "{s, pieces: [{face, x, y, theta}, ...]} with P pieces",
      score: "s, the edge of the solid; smaller is better",
      validity: VALIDITY,
      scoring: SCORING,
      improvement: IMPROVEMENT,
      work_limit: `the fold check gives up with an error when one piece crosses more than ${SURFACE_MAX_CHAINS} chains of faces (real packings need at most about 35); x, y and theta are each at most ${SPACE_MAX_COORD} in absolute value`,
    },
    viewer: "/spaces/surface.html",
    docs: spaceDocsUrl("SURFACE.md"),
  },
  curved: {
    space: "curved",
    title: "Constant curvature",
    summary:
      "Unit pieces in the smallest regular polygon or disk on a surface of constant curvature K: the hyperbolic plane (K < 0), the flat plane (K = 0) or a sphere of radius 1/sqrt(K) (K > 0). Some problems have no packing at all, because the pieces do not fit in any container.",
    score: "the container's side s (polygon) or radius r (disk) as a geodesic length at curvature K; smaller is better",
    problem_id: "curved/<K>/<N>/<M>/<P>",
    conventions: {
      space:
        "the complete surface of constant curvature K: hyperbolic plane for K < 0, Euclidean plane for K = 0, sphere of radius 1/sqrt(K) for K > 0",
      units: "geodesic lengths at curvature K; polygon pieces have side 1, disks (N = 0) radius 1; angles in radians",
      container:
        "centred at the origin O with a horizontal bottom edge: a regular M-gon of geodesic side s, or a disk of radius r (M = 0); for K > 0 the container lies in the open hemisphere around O",
      pose: "{x, y, theta}: the centre is the point at geodesic distance sqrt(x^2 + y^2) from O in direction (x, y); theta is the piece's angle relative to the frame carried from O along that geodesic, and a vertex points up at theta = 0; at K = 0 this is PolyPack's usual pose",
      configuration: "{size, pieces: [{x, y, theta}, ...]} with P pieces; size is s, or r for a disk container",
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
        "disks (N = 0) of geodesic radius 1, or regular spherical N-gons of geodesic side 1, on the sphere of radius rho",
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
      units: "polygon pieces have side 1, disks (N = 0) radius 1; angles in radians",
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
