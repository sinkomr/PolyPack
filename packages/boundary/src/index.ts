/** The boundary space: (d-1)-dimensional pieces on the boundary of a convex d-polytope ("3D on 4D"). */
export * from "./types";
export { ISO_IDENTITY, isoApply, isoCompose, isoFromAffine, isoInverse, isoLinear, isoToAffine, quaternionToMatrix } from "./linalg";
export type { Iso3, V3 } from "./linalg";
export { convexHull } from "./hull";
export type { HullFacet, HullRidge } from "./hull";
export { boundaryVolume, buildPolytope, cellExcess, compareNormals, facetPlane, fromAmbient, getPolytope, isPolytopeName, tesseractVertices, toAmbient } from "./polytope";
export { MAX_P, formatBoundaryId, isPieceCount, isPieceName, parseBoundaryId, standardPiece } from "./ids";
export {
  ChainLimitError,
  MIN_WINDOW_ANGLE,
  RIDGE_SNAP,
  clampToCell,
  clipSegmentToWindow,
  enumerateChains,
  geodesicDistance,
  geodesicLoop,
  hingeClearance,
  inWindow,
  pathLengths,
  traceGeodesic,
} from "./chains";
export type { BoundaryPoint, ChainNode, ChainOptions } from "./chains";
export { CUBE_FACES, CUBE_VERTICES, PART_CLIP_EPS, PART_EPS, developPiece, partMesh, partPolyhedron, pieceParts, piecePose, pieceReach, windowInCell } from "./parts";
export type { Development } from "./parts";
export { clipPolyhedron, polyhedronFrom, polyhedronThickness, polyhedronVertices, polyhedronVolume, satDepth, satShape } from "./polyhedron";
export type { Polyhedron, SatShape } from "./polyhedron";
export { bfsNet, defaultNet, netFromTree } from "./net";
export { MAX_S, validateBoundary, validateOn } from "./validate";
export type { ValidateOptions } from "./validate";
export { TesseractWords, embed as tesseractEmbed, tesseractClearance } from "./tesseract";
export * from "./search";
