/**
 * data/sphere/records.json is in site units: polygon pieces have side 1, disk pieces (N = 0) diameter 1 (radius 1
 * until 2026-10-27; scripts/convert-units.ts converted the file exactly, its header says `units: "diameter"`).
 * rho is the sphere radius in those units, so K_cert = 1/rho^2 is four times what it was; the poses (quaternions),
 * the density, the relative gap and eps did not change.
 */
export interface SphereRecordsFile {
  units?: string;
  records: any[];
  [key: string]: unknown;
}
