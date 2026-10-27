import { existsSync, readFileSync } from "node:fs";
import { type TorusRecordsFile } from "../src";

/** data/torus/records.json (site units: disks of diameter 1). */
export function loadSiteRecords(): TorusRecordsFile | undefined {
  const url = new URL("../../../data/torus/records.json", import.meta.url);
  return existsSync(url) ? (JSON.parse(readFileSync(url, "utf8")) as TorusRecordsFile) : undefined;
}
