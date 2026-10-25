/**
 * The searches of the spaces, shared by the volunteer client (apps/volunteer) and the website's
 * board (apps/web/src/space): one job on one problem (run.ts), the check of its results by the
 * server's rule (model.ts), the nofold conversion to a planar problem (nofold.ts) and the
 * volunteer client's job scheduler (engine.ts). Imported as "@polypack/spaces/search", so that the
 * contract entry ("@polypack/spaces") stays free of the search code.
 */
export * from "./seed";
export * from "./model";
export * from "./run";
export * from "./surface-fold";
export * from "./nofold";
export * from "./engine";
