export * from "./types";
export * from "./ids";
export * from "./info";
export * from "./validate";
export * from "./records";
export * from "./domain";
// 3D on 4D: the check-size estimates the server queues by (the boundary package's, re-exported so that the server needs no dependency of its own)
export { boundaryCheckMs, boundaryIsHeavy } from "@polypack/boundary";
// the curved domain's lists: the board's 16 curvatures, the six tiling curvatures that stay off its menu, and all 22
export { CURVED_KS, CURVED_MENU_KS, CURVED_MENU_K_IDS, CURVED_MS, CURVED_TILING_KS, PIECE_NS } from "./piece-domains";
