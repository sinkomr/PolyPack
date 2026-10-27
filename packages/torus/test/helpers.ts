import { existsSync, readFileSync } from "node:fs";
import { type TorusRecordsFile, recordsInSiteUnits } from "../src";

/** data/torus/records.json in site units (converted by exact halving while the data is not). */
export function loadSiteRecords(): TorusRecordsFile | undefined {
  const url = new URL("../../../data/torus/records.json", import.meta.url);
  return existsSync(url) ? recordsInSiteUnits(JSON.parse(readFileSync(url, "utf8"))) : undefined;
}
