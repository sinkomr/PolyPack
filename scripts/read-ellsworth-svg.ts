// Reads coordinates for squares in a square from the SVG drawings on David Ellsworth's "Squares in
// Squares" page, with credit, into data/sources/svg-ellsworth.json. Then run build-records.ts.
//
//   npx tsx scripts/read-ellsworth-svg.ts [--cache DIR]
//
// The drawings are hand-written SVG: a filled shape stands for a group of unit squares (a 5 x 5
// block, a staircase), placed by exact transforms, with the container side as a 30-digit entity.
// read-ellsworth-svg/lib.ts splits each filled shape into unit squares. A drawing is used only
// when every check holds: the reader accepts every element, path command, transform and number
// in it, each shape is a union of whole unit cells, the transforms are rigid motions, the count
// is P, the site's checker finds no overlap, and the container it implies is within 1e-9 of the
// published value. Anything else is reported and skipped, never guessed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type LiteratureRecord, evaluate } from "@polypack/geometry";
import { Unreadable, readSquares } from "./read-ellsworth-svg/lib";
import { trimTo } from "./trim-down/lib";

const cacheArg = process.argv.indexOf("--cache");
const CACHE = cacheArg > 0 ? process.argv[cacheArg + 1] : join(process.env.TMPDIR ?? "/tmp", "polypack-ellsworth-svg");
const TODAY = new Date().toISOString().slice(0, 10);
const OUT = "data/sources/svg-ellsworth.json";

// ---------- read every drawing of a published record ----------

const { records } = JSON.parse(readFileSync("data/sources/ellsworth.json", "utf8")) as { records: LiteratureRecord[] };
const wanted = records.filter((r) => r.N === 4 && r.M === 4 && /\.svg$/.test(r.picture_url ?? ""));
mkdirSync(CACHE, { recursive: true });
const read: LiteratureRecord[] = [];
const skipped: string[] = [];
for (const r of wanted) {
  const file = join(CACHE, `square-${r.P}.svg`);
  if (!existsSync(file)) {
    const res = await fetch(r.picture_url!);
    if (!res.ok) {
      skipped.push(`P=${r.P}: HTTP ${res.status}`);
      continue;
    }
    writeFileSync(file, await res.text());
    await sleep(300); // one small file at a time, gently
  }
  try {
    const drawn = readSquares(readFileSync(file, "utf8")).squares;
    // Some drawings show a packing of more squares in the same side (14 and 15 both need side 4);
    // without the extra squares it is still a valid packing of P, in a container no larger.
    if (drawn.length < r.P) throw new Unreadable(`${drawn.length} squares for P = ${r.P}`);
    const pieces = drawn.length > r.P ? trimTo(4, 4, drawn, 0, r.P).pieces : drawn;
    const extra = drawn.length - r.P;
    const e = evaluate({ N: 4, M: 4, P: r.P, pieces, container_phi: 0 }, { autoOrient: true });
    if (!e.valid) throw new Unreadable(`not valid: ${e.reasons.join("; ")}`);
    if (Math.abs(e.score! - r.value) > 1e-9 * r.value)
      throw new Unreadable(`a container of ${e.score} for the published ${r.display}`);
    read.push(<LiteratureRecord & { reading_note: string }>{
      ...r,
      source_name: `${r.source_name}: drawing of the packing`,
      source_url: r.picture_url!,
      accessed: TODAY,
      pieces: pieces.map((p) => ({ x: p.x, y: p.y, theta: p.theta })),
      container_phi: e.container!.phi,
      // build-records.ts adds this to the record's coordinates note
      reading_note:
        `Coordinates read from the source's SVG drawing (filled shapes split into unit squares` +
        (extra
          ? `; it shows ${drawn.length} squares in the same side, and the ${extra === 1 ? "outermost one was" : `${extra} outermost were`} left out`
          : "") +
        `) and checked here: ` +
        `${r.P} squares, no overlap, container side ${e.score!.toPrecision(15)} for the published ${r.display}.`,
    });
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    skipped.push(`P=${r.P}: ${error.message}`);
  }
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      description:
        "Coordinates for squares in a square read from the SVG drawings on David Ellsworth's Squares in Squares page " +
        "(https://kingbird.myphotos.cc/packing/squares_in_squares.html), with credit; values as in ellsworth.json. " +
        "Produced by scripts/read-ellsworth-svg.ts; a drawing is used only when its reading reproduces the published value.",
      records: read,
      skipped,
    },
    null,
    1,
  ) + "\n",
);
console.log(`${read.length} of ${wanted.length} drawings read into ${OUT}; ${skipped.length} skipped`);
for (const s of skipped) console.log(`  skipped ${s}`);
