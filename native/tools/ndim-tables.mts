// Writes the tables of the ndim family for the Rust crate (native/PORTING.md, rule 6): the facts of the 34 catalogue
// polytopes (packages/ndim/src/data/info.ts) and the coordinates of the six that are shipped as tables and loaded on
// demand (data/d4.ts, d6.ts, d7.ts), as JSON in native/ndim/data/. The other polytopes are computed by formulas, which
// are ported (native/ndim/src/generate.rs), not exported.
//   node --import tsx native/tools/ndim-tables.mts            writes the files
//   node --import tsx native/tools/ndim-tables.mts --check    fails when a file is out of date
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INFO } from "../../packages/ndim/src/data/info.ts";
import { D4 } from "../../packages/ndim/src/data/d4.ts";
import { D6 } from "../../packages/ndim/src/data/d6.ts";
import { D7 } from "../../packages/ndim/src/data/d7.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "ndim", "data");
const check = process.argv.includes("--check");

// JSON.stringify writes each double in its shortest form that reads back as the same double, and -0 as 0: a table
// with a negative zero would lose it, so that is refused here.
const numbers = (list: readonly number[], what: string): number[] => {
  for (const x of list) {
    if (typeof x !== "number" || !Number.isFinite(x)) throw new Error(`${what}: not a finite number`);
    if (Object.is(x, -0)) throw new Error(`${what}: a negative zero would be written as 0`);
  }
  return Array.from(list);
};
const table = (t: { code: string; V: number[]; N: number[]; b: number[] }[]): string =>
  "[\n" +
  t
    .map((e) =>
      JSON.stringify({
        code: e.code,
        V: numbers(e.V, `${e.code} V`),
        N: numbers(e.N, `${e.code} N`),
        b: numbers(e.b, `${e.code} b`),
      }),
    )
    .join(",\n") +
  "\n]\n";
const info =
  "[\n" +
  INFO.map((i) =>
    JSON.stringify({
      code: i.code,
      d: i.d,
      name: i.name,
      title: i.title,
      nV: i.nV,
      nE: i.nE,
      nF: i.nF,
      inradius: i.inradius,
      circumradius: i.circumradius,
      volume: i.volume,
    }),
  ).join(",\n") +
  "\n]\n";

const files: [string, string][] = [
  ["info.json", info],
  ["d4.json", table(D4)],
  ["d6.json", table(D6)],
  ["d7.json", table(D7)],
];
let stale = 0;
for (const [name, text] of files) {
  const path = join(dir, name);
  if (check) {
    const same = existsSync(path) && readFileSync(path, "utf8") === text;
    console.log(`${same ? "up to date" : "OUT OF DATE"}  ${name}`);
    if (!same) stale++;
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${name} (${text.length} bytes)`);
  }
}
if (stale) process.exit(1);
