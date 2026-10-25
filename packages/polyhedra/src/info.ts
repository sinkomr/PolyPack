/**
 * What a listing of spaces says about the polyhedra space, and the limits a server applies. Pure data, in the
 * shape of packages/spaces' SpaceInfo (without its problem count), so that the registry can take it as it is.
 */
import { POLYHEDRA_MAX_COORD, POLYHEDRA_MAX_QUATERNION, POLYHEDRA_MIN_QUATERNION_NORM, POLYHEDRA_TOL } from "./validate";

/** Largest P of the catalogue (data/polyhedra/records.json covers P = 2 to 30). */
export const POLYHEDRA_MAX_P = 30;

/**
 * Relative margin by which an entry must beat a research record's certified scale to count as better. The
 * records keep the wiki's clearances between pieces and from the walls (1e-7, or less after certified
 * refinements), which cost at most 2.6e-7 relative in s where upstream gives the touching limit s_tight;
 * removing them is not a better packing. (Site entries compete with each other by the usual tie
 * rule.)
 */
export const POLYHEDRA_RECORD_MARGIN = 1e-6;

export const POLYHEDRA_INFO = {
  space: "polyhedra",
  title: "3D in 3D",
  summary:
    "Polyhedra packed in polyhedra: equal solids (Platonic, Archimedean and Catalan solids, prisms and antiprisms) in the smallest scaled copy of a container solid. The problems and records are those of polyhedrainpolyhedra.wiki, with PolyPack's own prism and antiprism problems (7, 9 and 10 sides).",
  score: "the scale s of the container (its edge length for a unit-edge container); smaller is better",
  problem_id: "polyhedra/<code>/<P>",
  conventions: {
    problems:
      "code is the wiki's <piece>in<container>, e.g. cubintet (cubes in a tetrahedron), pr3l15incub (triangular prisms of height 1.5 in a cube); P pieces",
    solids:
      "the wiki's canonical solids, centred at the origin: unit edges, except Catalan solids (the polar reciprocals of the unit-edge Archimedean solids about the midsphere) and elongated prisms (base edges 1, lateral edges 1.5, 2 or 3)",
    container: "s times the canonical container solid, centred at the origin in its canonical orientation",
    pose: `[x, y, z, qw, qx, qy, qz]: the canonical piece turned by the rotation of q / |q| (v -> q v q*, i.e. H(q) / |q|^2) and centred at (x, y, z); x, y, z at most ${POLYHEDRA_MAX_COORD} and quaternion components at most ${POLYHEDRA_MAX_QUATERNION} in absolute value, |q| at least ${POLYHEDRA_MIN_QUATERNION_NORM}`,
    configuration: "{s, pieces: [[x, y, z, qw, qx, qy, qz], ...]} with P pieces",
    score: "s; smaller is better",
    validity: `pieces may touch; the server rejects overlaps (penetration depth) and protrusions deeper than ${POLYHEDRA_TOL} with its floating-point separating-axis validator`,
    scoring: "the score is the s stated in the configuration; the server checks the configuration at that s and does not shrink it",
    improvement: `an entry beats a research record only when its s is below the record's certified s by more than a relative ${POLYHEDRA_RECORD_MARGIN} (the records keep the wiki's clearances between pieces and from the walls, up to 1e-7, and removing them is not a better packing)`,
  },
  viewer: "/spaces/polyhedra.html",
  docs: "https://github.com/sinkomr/PolyPack/blob/main/docs/spaces/POLYHEDRA.md",
} as const;
