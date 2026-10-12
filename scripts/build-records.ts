// Builds data/records.json from the per-source imports in data/sources/ plus the few entries
// this project derives itself. Run after any importer:  npx tsx scripts/build-records.ts
//
// Merge rule for one (N, M, P):
//   1. A proven entry wins over an unproven one.
//   2. Otherwise the smallest value wins.
//   3. If another source gives the same value (within the winner's printed precision) with more
//      digits or with coordinates, those are attached and the note says where they come from.
// Every kept entry is checked: value not below the area bound, coordinates accepted by the
// site's own checker and reproducing the value. Disagreements between sources are reported.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { LiteratureRecord, Pose, areaLowerBound, evaluate, isProven } from "@polypack/geometry";

const TODAY = new Date().toISOString().slice(0, 10);
const DERIVED = {
  source_name: "PolyPack (derived here, not from the literature)",
  source_url: "/api#derived-records",
  accessed: TODAY,
};

const key = (r: { N: number; M: number; P: number }) => `${r.N}/${r.M}/${r.P}`;
const groups = new Map<string, LiteratureRecord[]>();
for (const file of readdirSync("data/sources").filter((f) => f.endsWith(".json")).sort()) {
  const { records } = JSON.parse(readFileSync(`data/sources/${file}`, "utf8")) as { records: LiteratureRecord[] };
  for (const r of records) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
}

const report: string[] = [];
const tolerance = (r: LiteratureRecord) => 10 ** -r.display_precision;

const merged = new Map<string, LiteratureRecord>();
for (const [k, list] of groups) {
  const ranked = [...list].sort(
    (a, b) => Number(isProven(b.status)) - Number(isProven(a.status)) || a.value - b.value || b.display_precision - a.display_precision,
  );
  const winner = { ...ranked[0] };
  for (const other of ranked.slice(1)) {
    const agree = Math.abs(other.value - winner.value) <= 2 * Math.max(tolerance(winner), tolerance(other));
    if (!agree) {
      report.push(
        `${k}: ${other.source_name.split(":")[0]} gives ${other.display}, kept ${winner.display} (${winner.status}) from ${winner.source_name.split(":")[0]}`,
      );
      continue;
    }
    if (other.display_precision > winner.display_precision) {
      winner.conversion_note += ` More digits (${other.display}) from ${other.source_name}, ${other.source_url}: ${other.conversion_note}`;
      winner.value = other.value;
      winner.display = other.display;
      winner.display_precision = other.display_precision;
    }
    if (other.pieces && !winner.pieces) {
      winner.pieces = other.pieces;
      winner.container_phi = other.container_phi;
      winner.coordinates_note = `Coordinates from ${other.source_name}, ${other.source_url} (read ${other.accessed}).`;
    }
  }
  merged.set(k, winner);
}

// ---------- entries derived here [CALC] ----------

/** Unit squares on a k x k grid, row by row from the bottom left. */
function gridSquares(P: number, k: number): Pose[] {
  const out: Pose[] = [];
  for (let i = 0; i < P; i++) out.push({ x: (i % k) + 0.5, y: Math.floor(i / k) + 0.5, theta: Math.PI / 4 });
  return out;
}

/** k^2 unit triangles tiling a triangle of side k: rows of upright triangles with inverted ones between. */
function triangleTiling(k: number): Pose[] {
  const h = Math.sqrt(3) / 2;
  const out: Pose[] = [];
  for (let row = 0; row < k; row++) {
    for (let i = 0; i < k - row; i++) out.push({ x: row / 2 + i + 0.5, y: row * h + h / 3, theta: 0 });
    for (let i = 0; i < k - row - 1; i++) out.push({ x: row / 2 + i + 1, y: row * h + (2 * h) / 3, theta: Math.PI });
  }
  return out;
}

function derive(N: number, M: number, P: number, value: number, status: LiteratureRecord["status"], why: string, pieces: Pose[]): void {
  const k = key({ N, M, P });
  const existing = merged.get(k);
  if (existing) {
    if (Math.abs(existing.value - value) > 2 * tolerance(existing)) {
      report.push(`${k}: derived value ${value} disagrees with ${existing.display} from the literature; literature kept`);
      return;
    }
    // keep the literature entry and its source; add what is derived here
    if (!existing.pieces) {
      existing.pieces = pieces;
      existing.container_phi = 0;
      existing.coordinates_note = "Coordinates constructed by PolyPack, not taken from the source.";
    }
    if (status === "trivial_tiling") {
      existing.status = "trivial_tiling";
      existing.note = [existing.note, `[CALC] ${why}`].filter(Boolean).join(" ");
    }
    return;
  }
  merged.set(k, {
    N, M, P, value,
    display: String(value),
    display_precision: 12,
    status,
    ...DERIVED,
    conversion_note: "None: computed in this site's units.",
    note: `[CALC] ${why}`,
    pieces,
    container_phi: 0,
  });
}

// One piece in a container of its own shape: the piece is the container.
derive(0, 0, 1, 1, "trivial_tiling", "One circle fills a circle of the same radius, so r = 1.", [{ x: 0, y: 0, theta: 0 }]);
for (let n = 3; n <= 20; n++) {
  // a piece at theta = 0 has a vertex up; for odd n that already gives a horizontal bottom edge
  const theta = n % 2 === 0 ? Math.PI / n : 0;
  derive(n, n, 1, 1, "trivial_tiling", `One ${n}-gon fills a container of the same shape and size, so s = 1.`, [{ x: 0, y: 0, theta }]);
}
// k^2 squares tile a square of side k; other n up to 324 on Ellsworth's page use the same grid.
for (const r of [...merged.values()]) {
  if (r.N !== 4 || r.M !== 4) continue;
  const k = Math.ceil(Math.sqrt(r.P));
  if (r.value !== k) continue;
  if (k * k === r.P) {
    derive(4, 4, r.P, k, "trivial_tiling", `${r.P} = ${k}² unit squares tile a square of side ${k} with no waste, so s = ${k} is optimal by area.`, gridSquares(r.P, k));
  } else {
    derive(4, 4, r.P, k, r.status, "", gridSquares(r.P, k));
  }
}
// k^2 unit triangles tile a triangle of side k.
for (let k = 1; k * k <= 500; k++) {
  derive(3, 3, k * k, k, "trivial_tiling", `${k * k} = ${k}² unit triangles tile a triangle of side ${k} with no waste, so s = ${k} is optimal by area.`, triangleTiling(k));
}

// ---------- checks ----------

const records = [...merged.values()].sort((a, b) => a.N - b.N || a.M - b.M || a.P - b.P);
for (const r of records) {
  if (r.value < areaLowerBound(r.N, r.M, r.P) - 2 * tolerance(r)) {
    throw new Error(`${key(r)}: value ${r.value} is below the area bound`);
  }
  if (r.pieces) {
    const e = evaluate({ N: r.N, M: r.M, P: r.P, pieces: r.pieces, container_phi: r.container_phi ?? 0 });
    if (!e.valid || Math.abs(e.score! - r.value) > Math.max(1e-8, 2 * tolerance(r))) {
      throw new Error(`${key(r)}: stored coordinates give ${e.valid ? e.score : e.reasons.join("; ")}, expected ${r.value}`);
    }
  }
}

writeFileSync("data/records.json", JSON.stringify({ generated: TODAY, records }) + "\n");
const count = (f: (r: LiteratureRecord) => boolean) => records.filter(f).length;
console.log(
  `${records.length} records: ${count((r) => r.status === "proven")} proven, ${count((r) => r.status === "proven_unrefereed")} proven (unrefereed), ` +
    `${count((r) => r.status === "trivial_tiling")} trivial tilings, ${count((r) => r.status === "best_known")} best known; ` +
    `${count((r) => !!r.pieces)} with coordinates.`,
);
const pairs = new Map<string, number>();
for (const r of records) pairs.set(`${r.N} in ${r.M}`, (pairs.get(`${r.N} in ${r.M}`) ?? 0) + 1);
console.log([...pairs].map(([p, n]) => `${p}: ${n}`).join(" | "));
console.log(`${report.length} source disagreements:\n` + report.join("\n"));
