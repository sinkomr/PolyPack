/**
 * data/sphere/records.json in site units. Disk pieces (N = 0) have diameter 1 since 2026-10-27
 * (they had radius 1, and every disk score was twice as large). Until the data file is converted
 * (its header says `units: "diameter"` once it is), the records of disks are the radius-1 ones,
 * and this converts them by exact halving of lengths, as scripts/convert-units.ts does: score_float,
 * score_cert, config.rho, the bounds and the literature value, and the certificate's clearance;
 * K_cert = 1/rho^2 is four times larger; `display` is recomputed. The poses (quaternions), the
 * density, the gap (relative) and eps are unchanged. Polygon records are unchanged.
 */
export interface SphereRecordsFile {
  units?: string;
  records: any[];
  [key: string]: unknown;
}

const half = (v: number) => v / 2;
const halfValue = (b: any) => (b && typeof b.value === "number" ? { ...b, value: half(b.value) } : b);

function halvedRecord(r: any): any {
  return {
    ...r,
    score_float: half(r.score_float),
    score_cert: half(r.score_cert),
    display: half(r.score_cert).toFixed(6),
    K_cert: r.K_cert === undefined ? undefined : r.K_cert * 4,
    config: { ...r.config, rho: half(r.config.rho) },
    certificate:
      r.certificate && typeof r.certificate.min_clearance === "number"
        ? { ...r.certificate, min_clearance: half(r.certificate.min_clearance) }
        : r.certificate,
    bound: halfValue(r.bound),
    bounds: r.bounds?.map(halfValue),
    literature:
      r.literature && typeof r.literature.rho === "number" ? { ...r.literature, rho: half(r.literature.rho) } : r.literature,
  };
}

export function recordsInSiteUnits(file: SphereRecordsFile): SphereRecordsFile {
  if (file.units === "diameter") return file;
  return { ...file, records: file.records.map((r) => (r.N === 0 ? halvedRecord(r) : r)) };
}
