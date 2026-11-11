// Writes the tables of the surface family for the Rust port, which reads them with include_str!
// (native/PORTING.md, rule 6):
//   native/surface/data/general.json   the 136 solids that are not Platonic, with their canonical vertices and
//                                      faces (packages/surface/src/general.data.ts), one solid per line;
//   native/surface/data/names.json     the names of the 141 solids by family, in catalogue order
//                                      (the lists of packages/surface/src/solids.ts; ALL_SOLID_NAMES is
//                                      their concatenation in the order of the keys).
// The numbers are the shortest text of each double (JSON.stringify), which serde_json reads back bit for bit.
//
//   node --import tsx native/tools/surface-export.mts            writes the files
//   node --import tsx native/tools/surface-export.mts --check    fails when one is out of date
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERAL_SOLID_DATA } from "../../packages/surface/src/general.data.ts";
import {
  ALL_SOLID_NAMES,
  ANTIPRISM_NAMES,
  ARCHIMEDEAN_NAMES,
  CATALAN_NAMES,
  JOHNSON_NAMES,
  PRISM_NAMES,
  SOLID_NAMES,
} from "../../packages/surface/src/solids.ts";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../surface/data");
const names = {
  platonic: SOLID_NAMES,
  archimedean: ARCHIMEDEAN_NAMES,
  catalan: CATALAN_NAMES,
  prism: PRISM_NAMES,
  antiprism: ANTIPRISM_NAMES,
  johnson: JOHNSON_NAMES,
};
if (JSON.stringify(Object.values(names).flat()) !== JSON.stringify(ALL_SOLID_NAMES))
  throw new Error("ALL_SOLID_NAMES is no longer the six families in order: the Rust port (solids.rs) must follow");
const files: Record<string, string> = {
  "general.json":
    "[\n" +
    GENERAL_SOLID_DATA.map((d) => JSON.stringify({ name: d.name, family: d.family, title: d.title, V: d.V, faces: d.faces })).join(",\n") +
    "\n]\n",
  "names.json": JSON.stringify(names, null, 1) + "\n",
};
let stale = 0;
for (const [name, text] of Object.entries(files)) {
  const file = resolve(dir, name);
  if (process.argv.includes("--check")) {
    let have = "";
    try {
      have = readFileSync(file, "utf8");
    } catch {
      // a missing file is out of date
    }
    if (have !== text) {
      console.error(`${file} is out of date: run node --import tsx native/tools/surface-export.mts`);
      stale++;
    } else console.log(`${file} is up to date`);
  } else {
    writeFileSync(file, text);
    console.log(`${file}: ${text.length} bytes`);
  }
}
if (stale) process.exit(1);
