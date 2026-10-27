import { enclose, type LiteratureRecord } from "@polypack/geometry";

/** Only the values and missing-coordinate sources needed by the surface notes, never poses. */
export function planarValues(records: readonly LiteratureRecord[]) {
  return records
    .filter((r) => r.M >= 3)
    .map((r) => ({
      N: r.N,
      M: r.M,
      k: r.P,
      // Score the stored poses at their stored orientation; printed decimals can be truncated.
      // This only reads an existing packing. It does not search or move any piece.
      value: r.pieces?.length ? enclose(r.N, r.pieces, r.M, r.container_phi ?? 0).size : r.value,
      ...(!r.pieces?.length
        ? { printed: { display: r.display, precision: r.display_precision, name: r.source_name, href: r.source_url } }
        : {}),
    }));
}
