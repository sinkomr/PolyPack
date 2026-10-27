/**
 * data/surface/records.json is in site units: polygon pieces have side 1, disk pieces (N = 0) diameter 1 (they had
 * radius 1 until 2026-10-27; scripts/convert-units.ts converted the file exactly, its header says `units: "diameter"`).
 */
export interface SurfaceRecordsFile {
  units?: string;
  records: any[];
  [key: string]: unknown;
}
