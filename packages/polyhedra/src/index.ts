export * from "./solids";
export * from "./problems";
export * from "./geom";
export * from "./validate";
export * from "./records";
export * from "./info";
export * from "./polish";
export * from "./search";
export * from "./kernel";
// The kernel's chart rotations and the simulator's signed distance of two cores, for kernels of other spaces with
// these solids as pieces (the balls space's Platonic solids in a ball). sim/geom.ts has its own quatToR, so its
// names are listed rather than re-exported wholesale.
export { chartGradient, expQuat, logQuat, mulQuat, randomQuat, unitQuat } from "./kernel-rotation";
export { GR as SD_GRADIENT, type SimPose, pose as simPose, prepShape, sdCores } from "./sim/geom";
export * from "./domain";
export * from "./start";
