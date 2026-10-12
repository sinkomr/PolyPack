// Imports equal-circle packings from Eckard Specht's Packomania into data/sources/packomania.json.
//
// Usage: npx tsx scripts/import-packomania.ts <directory> <access date>
// The directory must hold, for each family F in {cci, csq}:
//   F-radius.txt, F-ratio.txt   from http://www.packomania.com/F/txt/radius.txt and ratio.txt
//   F-coords/F<n>.txt           from the archive http://www.packomania.com/F/txt/F_coords.tar.gz
// Coordinates are kept for cci to n = 500 and for csq to n = 100 (MAX_P_WITH_COORDINATES).
// To attach cci coordinates to an existing data/sources/packomania.json without the tables, use
// scripts/attach-packomania-coords.ts.
//
// Conversions (the source normalises the container, this site normalises the pieces):
//   cci: circles of radius `radius` in a circle of radius 1. "ratio" = 1 / radius is the
//        container radius for unit circles, which is this site's r. Coordinates are divided by radius.
//   csq: circles of radius `radius` in a square of side 1 centred on the origin. "ratio" = 1 / radius
//        is the container side for unit circles, this site's s. Coordinates are divided by radius.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LiteratureRecord } from "@polypack/geometry";
import { MAX_P_WITH_COORDINATES, coordinatesProblem, readCoordinates } from "./packomania-coords";

const [dir, accessed] = process.argv.slice(2);
if (!dir || !/^\d{4}-\d\d-\d\d$/.test(accessed ?? "")) {
  console.error("usage: import-packomania.ts <directory> <YYYY-MM-DD access date>");
  process.exit(1);
}
const MAX_P = 500;

const FAMILIES = [
  { key: "cci", M: 0, title: "The best known packings of equal circles in a circle", what: "container radius" },
  { key: "csq", M: 4, title: "The best known packings of equal circles in a square", what: "container side" },
];

/** Reads "n value" lines, keeping the value as the printed string. */
function table(path: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+\.\d+)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

const records: LiteratureRecord[] = [];
const skipped: string[] = [];
for (const fam of FAMILIES) {
  const radius = table(resolve(dir, `${fam.key}-radius.txt`));
  const ratio = table(resolve(dir, `${fam.key}-ratio.txt`));
  const url = `http://www.packomania.com/${fam.key}/`;
  for (let P = 1; P <= MAX_P; P++) {
    const rad = radius.get(P);
    const rat = ratio.get(P);
    if (!rad || !rat) {
      skipped.push(`${fam.key} n = ${P}: not in the radius or ratio table`);
      continue;
    }
    // The radius has more digits than the ratio in the csq tables, so the value is 1 / radius;
    // the two columns must agree to the digits the ratio prints.
    const value = 1 / Number(rad);
    const ratioDecimals = rat.split(".")[1].length;
    if (Math.abs(value - Number(rat)) > 2 * 10 ** -Math.min(ratioDecimals, 9)) {
      skipped.push(`${fam.key} n = ${P}: radius ${rad} and ratio ${rat} disagree`);
      continue;
    }
    const precision = Math.min(ratioDecimals, 12);
    const rec: LiteratureRecord = {
      N: 0,
      M: fam.M,
      P,
      value,
      display: Number(rat).toFixed(precision),
      display_precision: precision,
      status: "best_known",
      source_name: `Eckard Specht, Packomania: ${fam.title}`,
      source_url: url,
      picture_url: `${url}${fam.key}${P}.html`,
      accessed,
      citation: `radius = ${rad}, ratio = ${rat} (tables radius.txt and ratio.txt)`,
      conversion_note:
        `The source fixes the container (${fam.M === 0 ? "radius 1" : "side 1"}) and lists the circle radius. ` +
        `This site fixes the circle radius at 1, so the ${fam.what} is 1 / radius, the source's "ratio" column.`,
    };
    const coords = resolve(dir, `${fam.key}-coords`, `${fam.key}${P}.txt`);
    if (P <= MAX_P_WITH_COORDINATES[fam.key] && existsSync(coords)) {
      const pieces = readCoordinates(readFileSync(coords, "utf8"), 1 / Number(rad));
      // the one-circle file of csq has no coordinates; the circle sits at the centre
      if (P === 1 && pieces.length === 0) pieces.push({ x: 0, y: 0, theta: 0 });
      // coordinates are only kept when this site's own checker accepts them and reproduces the value
      const problem = coordinatesProblem(fam.M, P, pieces, value);
      if (!problem) {
        rec.pieces = pieces;
        rec.container_phi = 0;
        rec.conversion_note += " Coordinates are the source's, divided by the circle radius.";
      } else {
        skipped.push(`${fam.key} n = ${P}: coordinates not kept (${problem})`);
      }
    }
    records.push(rec);
  }
}
writeFileSync("data/sources/packomania.json", JSON.stringify({ records, skipped }, null, 1) + "\n");
console.log(`${records.length} records, ${records.filter((r) => r.pieces).length} with coordinates`);
console.log(`${skipped.length} skipped:\n` + skipped.join("\n"));
