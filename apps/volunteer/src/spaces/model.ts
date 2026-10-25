/**
 * Moved to packages/spaces/src/search/model.ts, which the volunteer client and the website's board
 * share. This module keeps the client's names: a problem is a SpaceProblem and parseSpaceId reads
 * one from its id there called SearchProblem and parseSearchProblem.
 */
export {
  SOLID_FACES,
  SPACE_METHOD,
  SPACE_TOL,
  type SearchProblem as SpaceProblem,
  type SpaceCheck,
  type SpaceRule,
  checkSpaceConfig,
  parseSearchProblem as parseSpaceId,
  readSpaceConfig,
  statedScore,
  torusConfigOf,
  torusPackingOf,
} from "@polypack/spaces/search";
