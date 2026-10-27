/**
 * data/surface/records.json in site units. Disk pieces (N = 0) have diameter 1 since 2026-10-27
 * (they had radius 1, and every disk edge s was twice as large). Until the data file is converted
 * (its header says `units: "diameter"` once it is), the records of disks are the radius-1 ones and
 * this converts them by exact halving of lengths, as scripts/convert-units.ts does: the edge
 * (s, score_float, score_cert, nofold_score_cert), the centres of the pieces and the bounds;
 * `display` is recomputed. Faces, angles and the relative quantities (gap_rel, eps, gap_to_bound,
 * fold_gain) do not change. Polygon records are unchanged. The certificates
 * (data/surface/certificates) are not converted here.
 */
export interface SurfaceRecordsFile {
  units?: string;
  records: any[];
  [key: string]: unknown;
}

const half = (v: number) => v / 2;

function halvedRecord(r: any): any {
  return {
    ...r,
    s: half(r.s),
    score_float: half(r.score_float),
    score_cert: half(r.score_cert),
    display: half(r.score_cert).toFixed(6),
    nofold_score_cert: typeof r.nofold_score_cert === "number" ? half(r.nofold_score_cert) : r.nofold_score_cert,
    pieces: r.pieces.map((p: any) => ({ ...p, x: half(p.x), y: half(p.y) })),
    bound: r.bound && {
      ...r.bound,
      value: half(r.bound.value),
      area: half(r.bound.area),
      one_piece: half(r.bound.one_piece),
    },
  };
}

export function surfaceRecordsInSiteUnits(file: SurfaceRecordsFile): SurfaceRecordsFile {
  if (file.units === "diameter") return file;
  return { ...file, records: file.records.map((r) => (r.N === 0 ? halvedRecord(r) : r)) };
}
