// Attaches circle-in-circle coordinates from a local copy of Packomania's coordinate archive to
// the records already in data/sources/packomania.json. The radius and ratio tables are not needed:
// each record keeps the source's printed radius in its citation. Circles in a square are not touched.
//
// Usage: npx tsx scripts/attach-packomania-coords.ts <directory> <date the archive was read>
// The directory holds cci<n>.txt, unpacked from cci_coords.tar (Eckard Specht, Packomania,
// http://www.packomania.com/cci/). Each line is "index x y": a circle centre in a container of
// radius 1. The archive is not committed; see docs/RECORDS.md.
//
// Rules:
//   - Only n up to MAX_P_WITH_COORDINATES.cci (the site's cap on P) is read.
//   - The file is data: every non-empty line must be "index x y" with the indices 1..n in order,
//     otherwise nothing is taken from it. Nothing is guessed.
//   - Conversion as in import-packomania.ts: coordinates times 1 / (2 radius) (the circles have diameter 1), theta 0, container_phi 0.
//   - Coordinates are stored only if the site's checker accepts them and they reproduce the
//     published value to 1e-8 (coordinatesProblem). The published value and display never change.
//   - A record whose stored coordinates already equal the archive's is left exactly as it is, so
//     a second run changes nothing.
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LiteratureRecord } from "@polypack/geometry";
import { MAX_P_WITH_COORDINATES, coordinatesProblem, readCoordinates } from "./packomania-coords";
import { PACKOMANIA } from "./units";

const [dir, accessed] = process.argv.slice(2);
if (!dir || !/^\d{4}-\d\d-\d\d$/.test(accessed ?? "")) {
  console.error("usage: attach-packomania-coords.ts <cci coordinate directory> <YYYY-MM-DD date the archive was read>");
  process.exit(1);
}
const SOURCE = "data/sources/packomania.json";
/** Lines this script writes into the file's `skipped` list; replaced on every run. */
const PREFIX = "cci coordinate archive, n = ";
const NUMBER = String.raw`-?\d+\.\d+`;
const LINE = new RegExp(String.raw`^[ \t]*(\d+)[ \t]+(${NUMBER})[ \t]+(${NUMBER})[ \t]*$`);

const file = JSON.parse(readFileSync(SOURCE, "utf8")) as { records: LiteratureRecord[]; skipped: string[] };
const problems: string[] = [];
const counts = { unchanged: 0, added: 0, replaced: 0 };
const decimalsOfAdded = new Map<number, number>();

for (const rec of file.records) {
  if (rec.N !== 0 || rec.M !== 0 || rec.P > MAX_P_WITH_COORDINATES.cci) continue;
  const fail = (why: string) => problems.push(`${PREFIX}${rec.P}: ${why}`);

  // the printed radius, as the importer stored it; it must give exactly the stored value (the container
  // diameter, 1 / radius, since circles of diameter 1 are scored by it)
  const radius = /^radius = (\d+\.\d+), ratio = /.exec(rec.citation ?? "")?.[1];
  if (!radius || 1 / Number(radius) !== rec.value) {
    fail("the record's citation does not give the radius behind its value; coordinates not attached");
    continue;
  }
  const path = resolve(dir, `cci${rec.P}.txt`);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    fail(`no regular file cci${rec.P}.txt; coordinates not attached`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "");
  const parsed = lines.map((l) => LINE.exec(l));
  if (lines.length !== rec.P || parsed.some((m, i) => !m || Number(m[1]) !== i + 1)) {
    fail(`file is not ${rec.P} lines "index x y" numbered 1 to ${rec.P}; coordinates not attached`);
    continue;
  }
  const pieces = readCoordinates(text, 1 / (2 * Number(radius)));
  const problem = pieces.length === rec.P ? coordinatesProblem(0, rec.P, pieces, rec.value) : `${pieces.length} centres read`;
  if (problem) {
    fail(`coordinates not attached (${problem})`);
    continue;
  }
  const same =
    rec.pieces?.length === pieces.length &&
    rec.pieces.every((p, i) => p.x === pieces[i].x && p.y === pieces[i].y && p.theta === 0) &&
    (rec.container_phi ?? 0) === 0;
  if (same) {
    counts.unchanged++;
    continue;
  }
  counts[rec.pieces ? "replaced" : "added"]++;
  // the fewest decimals on any coordinate of the file: what the source prints for this n
  const decimals = Math.min(...parsed.flatMap((m) => [m![2], m![3]]).map((s) => s.split(".")[1].length));
  decimalsOfAdded.set(decimals, (decimalsOfAdded.get(decimals) ?? 0) + 1);
  rec.pieces = pieces;
  rec.container_phi = 0;
  rec.coordinates_note =
    `Coordinates from the source's coordinate archive cci_coords.tar (local copy, read ${accessed}), ` +
    `printed there to ${decimals}${PACKOMANIA.attached.neu}`;
}

file.skipped = [...file.skipped.filter((s) => !s.startsWith(PREFIX)), ...problems];
writeFileSync(SOURCE, JSON.stringify(file, null, 1) + "\n");
const cci = file.records.filter((r) => r.N === 0 && r.M === 0);
console.log(
  `circles in a circle: ${cci.length} records, ${cci.filter((r) => r.pieces).length} with coordinates ` +
    `(${counts.unchanged} already equal to the archive, ${counts.added} added, ${counts.replaced} replaced).`,
);
if (decimalsOfAdded.size) {
  console.log("decimals printed by the archive for the attached files: " + [...decimalsOfAdded].sort((a, b) => a[0] - b[0]).map(([d, n]) => `${d}: ${n}`).join(", "));
}
console.log(`${problems.length} not attached:\n` + problems.join("\n"));
