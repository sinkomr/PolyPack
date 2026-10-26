// Imports the polygon packings of Berthold, Kamp, Mexi, Pokutta and Polik (2026) into
// data/sources/kamp.json: n regular m-gons in a regular l-gon for l, m = 3..7 and n = 1..30, each
// with its coordinates. The file has the role "gaps": the records build uses these only for the
// problems no other source gives a value for (every pair with a heptagon, as of 2026-10-25).
//
// Usage: npx tsx scripts/import-kamp.ts <checkout> <access date>
// <checkout> is a checkout of https://github.com/DominikKamp/Packing at commit COMMIT below; only
// polygon/l{l}/m{m}/n{n}/polygon_n{n}_m{m}_l{l}.txt is read. The repository states no licence;
// its data is used with citation (THIRD_PARTY_NOTICES.md).
//
// A file holds "l m n", then R, then one "x y θ" line per piece. Conversion [CALC] (the source fixes
// the pieces' circumradius at 1, this site their side):
//   - Source: an m-gon of circumradius 1 at (x, y) has vertex k at angle −θ − π/2 + π/m + 2πk/m,
//     that is, θ turns it clockwise from a horizontal bottom edge; the l-gon of circumradius R is
//     centred on the origin with vertex k at −π/2 + π/l + 2πk/l, a horizontal bottom edge. The
//     README does not say so: read this way every one of the 750 packings is valid (no overlap or
//     overhang above 1e-14), read with θ anticlockwise most of those with m ≠ l are not.
//   - Here a piece of side 1 has circumradius ρ = 1 / (2 sin(π/m)), so every length is multiplied
//     by ρ. The container at φ = 0 has the same horizontal bottom edge, and its side is
//     2ρR sin(π/l) = R sin(π/l) / sin(π/m).
//   - A piece at θ' has vertex k at θ' + π/2 + 2πk/m (PROMPT.md section 2), so θ' = −θ − π + π/m,
//     taken modulo 2π/m into [0, 2π/m).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LiteratureRecord, Pose, evaluate } from "@polypack/geometry";

const [dir, accessed] = process.argv.slice(2);
if (!dir || !/^\d{4}-\d\d-\d\d$/.test(accessed ?? "")) {
  console.error("usage: import-kamp.ts <checkout of DominikKamp/Packing> <YYYY-MM-DD access date>");
  process.exit(1);
}
const COMMIT = "27f71632d8655ae4b6a049410a401976748b94e3";
const REPO = `https://github.com/DominikKamp/Packing/blob/${COMMIT}`;
const SIDES = [3, 4, 5, 6, 7];
const MAX_P = 30;
/**
 * Decimals the value is quoted to. R is printed to 15 digits, but the source's own table
 * (polygon/results.dat) rounds it up to 5 decimals, and its packings often fit a container
 * slightly smaller than R gives: by up to 1.4e-6 in this site's units [CALC]. At 6 decimals the
 * record's tolerance, 2 × 10^-6, covers that.
 */
const PRECISION = 6;
/** Quoted from the supplement's README, as the site quotes other sources' captions; R is quoted from the file. */
const CITATION =
  "This is the online supplement for the paper T. Berthold, D. Kamp, G. Mexi, S. Pokutta, I. Polik. " +
  "Out-of-the-Box Global Optimization for Packing Problems: New Models and Improved Solutions. " +
  "Submitted to the Journal of Global Optimization (JoGO), 2026.";

const records: LiteratureRecord[] = [];
const skipped: string[] = [];
for (const l of SIDES)
  for (const m of SIDES)
    for (let n = 1; n <= MAX_P; n++) {
      const path = `polygon/l${l}/m${m}/n${n}/polygon_n${n}_m${m}_l${l}`;
      let text: string;
      try {
        text = readFileSync(resolve(dir, `${path}.txt`), "utf8");
      } catch {
        skipped.push(`${path}.txt: missing`);
        continue;
      }
      const rows = text
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/));
      const head = rows[0]?.map(Number) ?? [];
      const R = Number(rows[1]?.[0]);
      const poses = rows.slice(2).map((r) => r.map(Number));
      if (
        head.join(" ") !== `${l} ${m} ${n}` ||
        !(R > 0) ||
        poses.length !== n ||
        poses.some((p) => p.length !== 3 || !p.every(Number.isFinite))
      ) {
        skipped.push(`${path}.txt: not "l m n", R and n lines of "x y theta"`);
        continue;
      }
      const rho = 1 / (2 * Math.sin(Math.PI / m));
      const turn = (2 * Math.PI) / m;
      const pieces: Pose[] = poses.map(([x, y, t]) => {
        const theta = (((-t - Math.PI + Math.PI / m) % turn) + turn) % turn;
        return { x: rho * x, y: rho * y, theta };
      });
      const value = (R * Math.sin(Math.PI / l)) / Math.sin(Math.PI / m);
      // kept only when this site's own checker accepts the coordinates and finds them in a container
      // no larger than the value, and smaller by no more than the record's tolerance (the rule of
      // scripts/build-records.ts)
      const e = evaluate({ N: m, M: l, P: n, pieces, container_phi: 0 });
      if (!e.valid || !(e.score! <= value + 1e-9 && value - e.score! <= 2 * 10 ** -PRECISION)) {
        skipped.push(
          `${path}.txt: ${e.valid ? `the coordinates give ${e.score}, not ${value}` : e.reasons.join("; ")}`,
        );
        continue;
      }
      records.push({
        N: m,
        M: l,
        P: n,
        value,
        display: value.toFixed(PRECISION),
        display_precision: PRECISION,
        status: "best_known",
        // "author, title" begins the name, as the site's list of sources (apps/web/src/sources.ts) reads it
        source_name: "Berthold, Kamp, Mexi, Pokutta and Polik, Packing Solutions: polygon packing",
        source_url: `${REPO}/${path}.txt`,
        picture_url: `${REPO}/${path}.pdf`,
        accessed,
        citation: `${CITATION} R = ${rows[1][0]}.`,
        conversion_note:
          `The source packs pieces of circumradius 1 and gives the container's circumradius R; this site uses pieces of side 1 and the container's side, ` +
          `here R sin(π/${l}) / sin(π/${m}). Coordinates are the source's, scaled by 1 / (2 sin(π/${m})), with each angle θ taken as −θ − π + π/${m} ` +
          `(the source turns its pieces clockwise from a horizontal bottom edge; scripts/import-kamp.ts).` +
          (value - e.score! > 1e-9
            ? ` They fit a container of side ${e.score!.toFixed(9)}, ${(value - e.score!).toExponential(1)} smaller than the source's R gives.`
            : ""),
        pieces,
        container_phi: 0,
      });
    }
// "gaps": these values fill the problems no other source covers (scripts/build-records.ts). Where
// another source has one, it is as good or better for every one of these problems [CALC].
writeFileSync(
  "data/sources/kamp.json",
  JSON.stringify({ role: "gaps", commit: COMMIT, records, skipped }, null, 1) + "\n",
);
console.log(`${records.length} records, all with coordinates; ${skipped.length} skipped`);
if (skipped.length) console.log(skipped.join("\n"));
