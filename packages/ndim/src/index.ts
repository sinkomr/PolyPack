export {
  BALL,
  BALL_RADIUS,
  MAX_DIM,
  MIN_DIM,
  problemErrors,
  shapePolytope,
  type NdConfig,
  type NdProblem,
} from "./problem";
export {
  LAZY_CODES,
  POLYTOPE_CODES,
  POLYTOPE_INFO,
  getPolytope,
  isLoaded,
  loadPolytope,
  polytopeInfo,
  polytopesOfDimension,
  type Polytope,
  type PolytopeData,
  type PolytopeInfo,
} from "./polytope";
export {
  MAX_CAYLEY,
  MAX_COORD,
  MAX_SIZE,
  cayleyMatrix,
  cayleyOfMatrix,
  nParams,
  placeFacets,
  placeVertices,
  poseLength,
  poseOfMatrix,
  readPose,
  type ReadPose,
} from "./pose";
export {
  closestPoints,
  gapAlong,
  penetrationDepth,
  signedSeparation,
  type ClosestResult,
  type PenetrationResult,
  type Separation,
} from "./gjk";
export {
  NDIM_TOL,
  configErrors,
  pairSeparation,
  pieceWallGap,
  tightScale,
  validateNd,
  validateNdSteps,
  type NdValidation,
  type ValidateOptions,
} from "./validate";
export {
  ballVolume,
  inradiusBound,
  lowerBound,
  maxPiecesByVolume,
  unitCircumradius,
  unitInradius,
  unitVolume,
  volumeBound,
} from "./bounds";
export { ballFacetGap, ballInBallGap, ballPairGap, ballWallGap } from "./ball";
