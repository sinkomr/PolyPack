// Writes the tables of packages/spaces that the Rust port reads with include_str! (native/PORTING.md,
// rule 6): what GET /api/spaces says about each space (SPACE_INFO and SPACE_EXHIBITS of info.ts, whose
// sentences are written from the limits of the packages) and the list of the surface space's solids as
// ids.ts writes it out (SURFACE_SOLIDS). The tables are not retyped: this tool is the only way
// native/spaces/data/tables.json changes.
//
//   node --import tsx native/tools/spaces-tables.mts            writes native/spaces/data/tables.json
//   node --import tsx native/tools/spaces-tables.mts --check    fails when that file is out of date
//
// The JSON keeps the order of the source's keys (SPACE_INFO by space, each space's fields and its
// conventions in the order info.ts writes them), which is the order /api/spaces sends them in.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SURFACE_SOLIDS } from "../../packages/spaces/src/ids.ts";
import { SPACE_EXHIBITS, SPACE_INFO } from "../../packages/spaces/src/info.ts";
import { SPACE_NAMES } from "../../packages/spaces/src/types.ts";

const target = fileURLToPath(new URL("../spaces/data/tables.json", import.meta.url));

const tables = {
  surface_solids: SURFACE_SOLIDS,
  // in the order of SPACE_NAMES, each with the keys of info.ts
  info: SPACE_NAMES.map((s) => SPACE_INFO[s]),
  exhibits: SPACE_EXHIBITS,
};
for (const [k, i] of tables.info.entries())
  if (i.space !== SPACE_NAMES[k]) throw new Error(`SPACE_INFO.${SPACE_NAMES[k]} names the space ${i.space}`);
const text = JSON.stringify(tables, null, 1) + "\n";
if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(tables)) throw new Error("the JSON does not read back as the tables");

if (process.argv.includes("--check")) {
  let have = "";
  try {
    have = readFileSync(target, "utf8");
  } catch {
    // a missing file is out of date
  }
  if (have !== text) {
    console.error(`${target} is out of date: run node --import tsx native/tools/spaces-tables.mts`);
    process.exit(1);
  }
  console.log(`${target} is up to date (${tables.info.length} spaces, ${text.length} bytes)`);
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  console.log(`wrote ${target} (${tables.info.length} spaces, ${text.length} bytes)`);
}
