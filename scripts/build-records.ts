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
//
// A source whose file says "role": "gaps" (data/sources/kamp.json) is used only for the problems
// that no other source gives a value for. Its values are not merged digit by digit with the others':
// a general-purpose solver's packings are often worse than the best known, yet close enough to
// "agree" with a value printed to one or two decimals, whose digits they would then replace.
//
// A source whose file says "role": "proof" (data/sources/hosono.json) sets the status of problems
// that other sources already give a value for, and only that: the value stays the one held, which
// must agree with the proven value (the printed value is truncated, so the proven one is at most one
// unit of the printed precision above it), and its coordinates stay. The file may also list
// "not_proven" problems, which stay best_known whatever a refreshed source page says.
//
// data/sources/constructed.json is not a literature source: it holds coordinates that PolyPack's
// solver constructed for records without any (scripts/construct-coordinates.ts). They are
// attached last, only to records that still have no coordinates, and only when they are again
// found valid at a size within the record's tolerance of its value.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { LiteratureRecord, Pose, areaLowerBound, evaluate, isProven } from "@polypack/geometry";
import { ONE_DISK, UNITS_HEADER, sourceTolerance } from "./units";

// --date stamps the build with a given day instead of today, so that a rebuild that changes
// nothing else does not restamp the derived entries
const dateArg = process.argv.indexOf("--date");
const TODAY = dateArg > 0 ? process.argv[dateArg + 1] : new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(TODAY)) throw new Error(`--date must be YYYY-MM-DD, got ${TODAY}`);
const CONSTRUCTED = "constructed.json";
const DERIVED = {
  source_name: "PolyPack (derived here, not from the literature)",
  source_url: "/api#derived-records",
  accessed: TODAY,
};

const key = (r: { N: number; M: number; P: number }) => `${r.N}/${r.M}/${r.P}`;
const groups = new Map<string, LiteratureRecord[]>();
const gaps = new Map<string, LiteratureRecord[]>();
const proofs: { records: LiteratureRecord[]; not_proven?: { N: number; M: number; P: number; why: string }[] }[] = [];
for (const file of readdirSync("data/sources")
  .filter((f) => f.endsWith(".json") && f !== CONSTRUCTED)
  .sort()) {
  const { records, role } = JSON.parse(readFileSync(`data/sources/${file}`, "utf8")) as {
    records: LiteratureRecord[];
    role?: "gaps" | "proof";
  };
  if (role === "proof") {
    proofs.push(JSON.parse(readFileSync(`data/sources/${file}`, "utf8")));
    continue;
  }
  const into = role === "gaps" ? gaps : groups;
  for (const r of records) into.set(key(r), [...(into.get(key(r)) ?? []), r]);
}
for (const [k, list] of gaps) if (!groups.has(k)) groups.set(k, list);

const report: string[] = [];
const tolerance = (r: LiteratureRecord) => sourceTolerance(r.N, r.M, r.display_precision);

// ---------- literature values below a bound [CALC] ----------
// An M-gon of side s lies in its circumcircle, of radius s / (2 sin(π/M)), so P pieces that fit the
// M-gon fit that circle too: s ≥ sin(π/M)·D, where D is the smallest DIAMETER of a circle holding
// the same P pieces (a circle container is scored by its diameter since 2026-10-27; this was
// 2 sin(π/M)·ρ with the radius ρ). With D proven, a source value below this bound is wrong, whatever the source
// says. It is left out and reported, so that the site neither shows an impossible value nor closes
// the problem on it. Printed values are truncated, so both sides are allowed their printed precision.
for (const [k, list] of groups) {
  const [N, M, P] = k.split("/").map(Number);
  if (M === 0) continue;
  const circle = (groups.get(key({ N, M: 0, P })) ?? []).filter((r) => r.status === "proven");
  if (!circle.length) continue;
  const diameter = Math.min(...circle.map((r) => r.value));
  const bound = Math.sin(Math.PI / M) * diameter;
  const kept = list.filter((r) => r.value + 2 * tolerance(r) >= bound);
  for (const r of list.filter((r) => !kept.includes(r))) {
    report.push(
      `${k}: ${r.source_name.split(":")[0]} gives ${r.display} (${r.status}), below ${bound.toFixed(7)}, the bound from ${diameter} for a circle; left out`,
    );
  }
  if (kept.length) groups.set(k, kept);
  else groups.delete(k);
}

const merged = new Map<string, LiteratureRecord>();
for (const [k, list] of groups) {
  const [N, M, P] = k.split("/").map(Number);
  const ranked = [...list].sort(
    (a, b) =>
      Number(isProven(b.status)) - Number(isProven(a.status)) ||
      a.value - b.value ||
      b.display_precision - a.display_precision,
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
      // another source's coordinates are attached only when they give the kept value to its own
      // tolerance, the rule of the checks below: a source whose value is quoted to fewer digits
      // may hold a packing that agrees with it there but not here
      const e = evaluate({ N, M, P, pieces: other.pieces, container_phi: other.container_phi ?? 0 });
      if (!e.valid || Math.abs(e.score! - winner.value) > Math.max(1e-8, 2 * tolerance(winner))) {
        report.push(
          `${k}: coordinates from ${other.source_name.split(":")[0]} give ${e.valid ? e.score : e.reasons.join("; ")}, ` +
            `not ${winner.display}; not attached`,
        );
        continue;
      }
      winner.pieces = other.pieces;
      winner.container_phi = other.container_phi;
      // a source whose coordinates were read rather than given says how (read-ellsworth-svg.ts)
      const reading = (other as { reading_note?: string }).reading_note;
      winner.coordinates_note =
        `Coordinates from ${other.source_name}, ${other.source_url} (read ${other.accessed}).` +
        (reading ? ` ${reading}` : "");
    }
  }
  merged.set(k, winner);
}

// ---------- statuses set by a proof source [CALC] ----------
for (const { records: proved, not_proven } of proofs) {
  for (const p of proved) {
    const r = merged.get(key(p));
    if (!r) throw new Error(`${key(p)}: proof source for a problem without a record`);
    // the held value is printed truncated ("+"), so the proven value lies in [value, value + 10^-precision]
    const gap = p.value - r.value;
    if (gap < -1e-9 || gap > tolerance(r) + 1e-9) {
      throw new Error(`${key(p)}: proven value ${p.value} does not match the held value ${r.display} (${r.value})`);
    }
    r.status = p.status;
    r.citation = [r.citation, p.citation].filter(Boolean).join(" ");
    r.note = [r.note, p.note].filter(Boolean).join(" ");
  }
  for (const n of not_proven ?? []) {
    const r = merged.get(key(n));
    if (r && r.status !== "best_known") {
      report.push(`${key(n)}: ${n.why} Status ${r.status} set back to best_known`);
      r.status = "best_known";
      r.note = n.why;
    }
  }
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

function derive(
  N: number,
  M: number,
  P: number,
  value: number,
  status: LiteratureRecord["status"],
  why: string,
  pieces: Pose[],
  container_phi = 0,
): void {
  const k = key({ N, M, P });
  const existing = merged.get(k);
  if (existing) {
    if (Math.abs(existing.value - value) > 2 * tolerance(existing)) {
      report.push(
        `${k}: derived value ${value} disagrees with ${existing.display} from the literature; literature kept`,
      );
      return;
    }
    // keep the literature entry and its source; add what is derived here
    if (!existing.pieces) {
      existing.pieces = pieces;
      existing.container_phi = container_phi;
      existing.coordinates_note = "Coordinates constructed by PolyPack, not taken from the source.";
    }
    if (status === "trivial_tiling") {
      existing.status = "trivial_tiling";
      // the tiling's value is exact; a source's may carry its solver's rounding (1.00000000000001)
      existing.value = value;
      existing.note = [existing.note, `[CALC] ${why}`].filter(Boolean).join(" ");
    }
    return;
  }
  merged.set(k, {
    N,
    M,
    P,
    value,
    display: Number.isInteger(value) ? String(value) : value.toFixed(12),
    display_precision: 12,
    status,
    ...DERIVED,
    conversion_note: "None: computed in this site's units.",
    note: `[CALC] ${why}`,
    pieces,
    container_phi,
  });
}

// One piece in a container of its own shape: the piece is the container.
derive(0, 0, 1, 1, "trivial_tiling", ONE_DISK.neu.replace("[CALC] ", ""), [
  { x: 0, y: 0, theta: 0 },
]);
for (let n = 3; n <= 20; n++) {
  // a piece at theta = 0 has a vertex up; for odd n that already gives a horizontal bottom edge
  const theta = n % 2 === 0 ? Math.PI / n : 0;
  derive(n, n, 1, 1, "trivial_tiling", `One ${n}-gon fills a container of the same shape and size, so s = 1.`, [
    { x: 0, y: 0, theta },
  ]);
}
// k^2 squares tile a square of side k; other n up to 324 on Ellsworth's page use the same grid.
for (const r of [...merged.values()]) {
  if (r.N !== 4 || r.M !== 4) continue;
  const k = Math.ceil(Math.sqrt(r.P));
  if (r.value !== k) continue;
  if (k * k === r.P) {
    derive(
      4,
      4,
      r.P,
      k,
      "trivial_tiling",
      `${r.P} = ${k}² unit squares tile a square of side ${k} with no waste, so s = ${k} is optimal by area.`,
      gridSquares(r.P, k),
    );
  } else {
    derive(4, 4, r.P, k, r.status, "", gridSquares(r.P, k));
  }
}
// k^2 unit triangles tile a triangle of side k.
for (let k = 1; k * k <= 500; k++) {
  derive(
    3,
    3,
    k * k,
    k,
    "trivial_tiling",
    `${k * k} = ${k}² unit triangles tile a triangle of side ${k} with no waste, so s = ${k} is optimal by area.`,
    triangleTiling(k),
  );
}
// Two pentagons in a hexagon and in an octagon. Friedman's values for these (1.53879+ and 1.17774+)
// fall below the bound above and are left out; these packings, PolyPack's own, take their place.
// The two pentagons meet face to face, so the pair spans r + R from vertex to vertex (r and R the
// pentagon's inradius and circumradius), and the far vertices sit in opposite corners of a
// container of circumradius r + R. A pentagon's corner (108°) fits a hexagon's (120°) and an
// octagon's (135°), and its other vertices lie well inside.
{
  const r = 1 / (2 * Math.tan(Math.PI / 5));
  const R = 1 / (2 * Math.sin(Math.PI / 5));
  // vertex 0 points along θ + π/2: these poses turn it away from the shared face, along the x axis
  const pair: Pose[] = [
    { x: -r, y: 0, theta: Math.PI / 2 },
    { x: r, y: 0, theta: -Math.PI / 2 },
  ];
  const why = (container: string, listed: string, bound: number) =>
    `Two pentagons face to face, with their far vertices in opposite corners of ${container} of circumradius r + R = ${(r + R).toFixed(6)}, ` +
    `r and R being the pentagon's inradius and circumradius. Erich Friedman's page listed ${listed} (read 2026-10-07), ` +
    `below ${bound.toFixed(6)}, the bound from the proven value r + R for two pentagons in a circle; that value is left out. ` +
    `This packing is PolyPack's own and is not claimed optimal.`;
  // at φ = 0 a hexagon has corners on the x axis and its side equals its circumradius; an octagon needs φ = π/8
  derive(5, 6, 2, r + R, "best_known", why("a hexagon", "1.53879+", r + R), pair);
  const octagon = 2 * Math.sin(Math.PI / 8) * (r + R);
  derive(5, 8, 2, octagon, "best_known", why("an octagon", "1.17774+", octagon), pair, Math.PI / 8);
}

// ---------- coordinates constructed here [CALC] ----------

interface Construction {
  N: number;
  M: number;
  P: number;
  published: number;
  score: number;
  method: string;
  params: { kind?: string };
  seed: number;
  pieces: Pose[];
  container_phi: number;
}
let attached = 0;
if (existsSync(`data/sources/${CONSTRUCTED}`)) {
  const { constructions } = JSON.parse(readFileSync(`data/sources/${CONSTRUCTED}`, "utf8")) as {
    constructions: Construction[];
  };
  for (const c of constructions) {
    const r = merged.get(key(c));
    if (!r) {
      report.push(`${key(c)}: constructed coordinates for a record that no longer exists; not used`);
      continue;
    }
    if (r.pieces) continue;
    const e = evaluate({ N: c.N, M: c.M, P: c.P, pieces: c.pieces, container_phi: c.container_phi });
    // the rule of scripts/construct-coordinates.ts: within 10^-display_precision of the value, never above
    if (c.published !== r.value || !e.valid || Math.abs(e.score! - r.value) > tolerance(r)) {
      report.push(
        `${key(c)}: constructed coordinates give ${e.valid ? e.score : e.reasons.join("; ")} for ${r.display}; not used`,
      );
      continue;
    }
    r.pieces = c.pieces;
    r.container_phi = c.container_phi;
    // the seed method's generator is part of the recipe: "seed method, auto" or "seed method, record_plus_one"
    const method = c.method === "seed" ? `seed method, ${c.params.kind ?? "auto"}` : c.method;
    r.coordinates_note = `Coordinates constructed by PolyPack (${method}, seed ${c.seed}): a packing that reaches the published value, not necessarily the source's arrangement.`;
    attached++;
  }
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
      throw new Error(
        `${key(r)}: stored coordinates give ${e.valid ? e.score : e.reasons.join("; ")}, expected ${r.value}`,
      );
    }
  }
}

writeFileSync("data/records.json", JSON.stringify({ generated: TODAY, ...UNITS_HEADER, records }) + "\n");
const count = (f: (r: LiteratureRecord) => boolean) => records.filter(f).length;
console.log(
  `${records.length} records: ${count((r) => r.status === "proven")} proven, ${count((r) => r.status === "proven_unrefereed")} proven (unrefereed), ` +
    `${count((r) => r.status === "trivial_tiling")} trivial tilings, ${count((r) => r.status === "best_known")} best known; ` +
    `${count((r) => !!r.pieces)} with coordinates (${attached} constructed by the solver, data/sources/${CONSTRUCTED}).`,
);
const pairs = new Map<string, number>();
for (const r of records) pairs.set(`${r.N} in ${r.M}`, (pairs.get(`${r.N} in ${r.M}`) ?? 0) + 1);
console.log([...pairs].map(([p, n]) => `${p}: ${n}`).join(" | "));
console.log(`${report.length} source disagreements:\n` + report.join("\n"));
