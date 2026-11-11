// Writes the table of the 186 solids (packages/polyhedra/src/solids.data.ts, SOLID_DATA) as JSON for the Rust
// port, which reads it with include_str! (native/PORTING.md, rule 6). The table is not retyped: this tool is the
// only way native/polyhedra/data/solids.json changes.
//
//   node --import tsx native/tools/polyhedra-solids.mts            writes native/polyhedra/data/solids.json
//   node --import tsx native/tools/polyhedra-solids.mts --check    fails when that file is out of date
//
// The JSON is JSON.stringify of SOLID_DATA, one solid per line, fields in the table's order. Every number is
// written as the shortest decimal that reads back as the same double, so the Rust side (serde_json with
// float_roundtrip) holds the same bits. JSON cannot write -0 (it prints 0), so the tool refuses a table with one.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SOLID_DATA } from "../../packages/polyhedra/src/solids.data.ts";

const target = fileURLToPath(new URL("../polyhedra/data/solids.json", import.meta.url));

function refuseNegativeZero(v: unknown, where: string): void {
  if (typeof v === "number") {
    if (Object.is(v, -0)) throw new Error(`${where} is -0, which JSON cannot write`);
    if (!Number.isFinite(v)) throw new Error(`${where} is not finite`);
  } else if (Array.isArray(v)) v.forEach((x, i) => refuseNegativeZero(x, `${where}[${i}]`));
  else if (typeof v === "object" && v !== null)
    for (const [k, x] of Object.entries(v)) refuseNegativeZero(x, `${where}.${k}`);
}

SOLID_DATA.forEach((d) => refuseNegativeZero(d, d.name));
const text = `[\n${SOLID_DATA.map((d) => JSON.stringify(d)).join(",\n")}\n]\n`;

// the text must read back as the same table
const back = JSON.parse(text) as typeof SOLID_DATA;
if (JSON.stringify(back) !== JSON.stringify(SOLID_DATA)) throw new Error("the JSON does not read back as the table");

if (process.argv.includes("--check")) {
  let have = "";
  try {
    have = readFileSync(target, "utf8");
  } catch {
    // a missing file is out of date
  }
  if (have !== text) {
    console.error(`${target} is out of date: run node --import tsx native/tools/polyhedra-solids.mts`);
    process.exit(1);
  }
  console.log(`${target} is up to date (${SOLID_DATA.length} solids, ${text.length} bytes)`);
} else {
  writeFileSync(target, text);
  console.log(`wrote ${target} (${SOLID_DATA.length} solids, ${text.length} bytes)`);
}
