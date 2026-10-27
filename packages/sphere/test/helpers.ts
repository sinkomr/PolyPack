import { existsSync, readFileSync } from "node:fs";
import { recordsInSiteUnits } from "../src";

/** data/sphere/records.json in site units (converted by exact halving while the data is not). */
export function loadSiteRecords(): any[] {
  const url = new URL("../../../data/sphere/records.json", import.meta.url);
  return existsSync(url) ? recordsInSiteUnits(JSON.parse(readFileSync(url, "utf8"))).records : [];
}
