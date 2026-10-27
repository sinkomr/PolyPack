import { existsSync, readFileSync } from "node:fs";

/** data/sphere/records.json (site units: disks of diameter 1). */
export function loadSiteRecords(): any[] {
  const url = new URL("../../../data/sphere/records.json", import.meta.url);
  return existsSync(url) ? JSON.parse(readFileSync(url, "utf8")).records : [];
}
