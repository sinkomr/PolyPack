/**
 * Node-only: reads data/<space>/records.json into the compact catalogues. Kept out of the main
 * entry so that pages never import node:fs; import it as "@polypack/spaces/load".
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SpaceCatalogue, SpacesIndex, buildSpaceCatalogue } from "./records";
import { SPACE_NAMES, SpaceName } from "./types";

/** The records file of a space below the repository root. */
export function spaceRecordsPath(root: string, space: SpaceName): string {
  return join(root, "data", space, "records.json");
}

function catalogueOf(space: SpaceName, file: unknown, log: (msg: string) => void): SpaceCatalogue {
  const catalogue = buildSpaceCatalogue(space, file);
  for (const s of catalogue.skipped) log(`[spaces] ${space} record left out: ${s}`);
  log(`[spaces] ${space}: ${catalogue.problems.length} problems (records of ${catalogue.generated ?? "unknown date"})`);
  return catalogue;
}

/**
 * The catalogues of every space whose records file exists below `root`, read in this thread.
 * Each file is parsed once and only the compact catalogue is kept; `log` receives one line per
 * space and one per record left out.
 */
export function loadSpacesIndex(root: string, log: (msg: string) => void = () => {}): SpacesIndex {
  const index: SpacesIndex = {};
  for (const space of SPACE_NAMES) {
    const path = spaceRecordsPath(root, space);
    if (!existsSync(path)) {
      log(`[spaces] no ${space} records (${join("data", space, "records.json")} is missing)`);
      continue;
    }
    try {
      index[space] = catalogueOf(space, JSON.parse(readFileSync(path, "utf8")), log);
    } catch (e) {
      log(`[spaces] ${space} records not loaded: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return index;
}
