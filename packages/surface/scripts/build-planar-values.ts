/** Refresh the small browser index after data/records.json changes. No packing search is run. */
import { readFileSync, writeFileSync } from "node:fs";
import { planarValues } from "./planar-values";

const records = JSON.parse(readFileSync(new URL("../../../data/records.json", import.meta.url), "utf8")).records;
writeFileSync(new URL("../src/planar-values.data.json", import.meta.url), JSON.stringify(planarValues(records)) + "\n");
