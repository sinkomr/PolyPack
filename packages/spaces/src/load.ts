/**
 * Node-only: reads data/<space>/records.json into the compact catalogues. Kept out of the main
 * entry so that pages never import node:fs; import it as "@polypack/spaces/load".
 *
 * A space that keeps its configurations apart (polyhedra: data/polyhedra/configs/<code>.jsonl, one
 * file per problem and one line per P, 56.9 MB in all) is loaded without them: each entry keeps the
 * byte offset and length of its line (configAt), and the catalogue gets a `loadConfig` that reads
 * that one line when a configuration is asked for, checks it as the catalogue checks the others,
 * and keeps the last ones read up to CONFIG_CACHE_BYTES. At most CONFIG_READS_AT_ONCE reads run at
 * once, and reads of the same configuration at the same time share one. A failed read is never kept.
 */
import { existsSync, openSync, readFileSync, readSync, closeSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { parseSpaceId } from "./ids";
import { SpaceCatalogue, SpaceProblemEntry, SpacesIndex, buildSpaceCatalogue, configLocation } from "./records";
import { SPACE_NAMES, SpaceName } from "./types";
import { parseSpaceConfig } from "./validate";

/** Bytes of configurations kept in memory at once, per space (the least recently used goes first). */
export const CONFIG_CACHE_BYTES = 4_000_000;
/** Reads of configurations kept apart that run at once, per space; the others wait their turn. */
export const CONFIG_READS_AT_ONCE = 4;

/** The records file of a space below the repository root. */
export function spaceRecordsPath(root: string, space: SpaceName): string {
  return join(root, "data", space, "records.json");
}

/** The file of a space's configurations kept apart, below the repository root. */
export function spaceConfigPath(root: string, space: SpaceName, file: string): string {
  return join(root, "data", space, "configs", `${file}.jsonl`);
}

/**
 * A configuration's line as read from its file, checked: the line is {"P", "config"} with the
 * entry's P, the configuration passes parseSpaceConfig against the entry's id, and its size is the
 * entry's certified score (so that a file and an index that drift apart serve nothing). The checked
 * configuration as JSON text, or why not.
 */
function readLine(space: SpaceName, entry: SpaceProblemEntry, text: string): string | { error: string } {
  let row: unknown;
  try {
    row = JSON.parse(text);
  } catch (e) {
    return { error: `not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = row as { P?: unknown; config?: unknown } | null;
  if (typeof r !== "object" || r === null || r.P !== entry.P || r.config === undefined)
    return { error: `the line at config_at is not the configuration of P = ${entry.P}` };
  const id = parseSpaceId(space, entry.id);
  if (typeof id === "string") return { error: id };
  const parsed = parseSpaceConfig(id, r.config);
  if (!parsed.ok) return { error: parsed.errors.join("; ") };
  if (entry.certified && parsed.score !== entry.certified.score)
    return { error: `its size ${parsed.score} is not the certified ${entry.certified.score} of the index` };
  return JSON.stringify(parsed.config);
}

export interface ConfigLoader {
  /** The entry's configuration as JSON text; null when it cannot be read (then nothing is kept). */
  load: (entry: SpaceProblemEntry) => Promise<string | null>;
  /** Ids of the configurations kept, least recently used first. */
  cached: () => string[];
  /** What the loader has done so far: reads of files, the most at once, the bytes kept now. */
  stats: () => { reads: number; peakAtOnce: number; bytes: number };
}

/** The on-demand reader of a catalogue's configurations kept apart. */
export function configLoader(
  root: string,
  catalogue: SpaceCatalogue,
  log: (msg: string) => void = () => {},
  limitBytes = CONFIG_CACHE_BYTES,
  atOnce = CONFIG_READS_AT_ONCE,
): ConfigLoader {
  const space = catalogue.space;
  // a Map keeps insertion order: the first key is the least recently used
  const cache = new Map<string, string>();
  let bytes = 0;
  const pending = new Map<string, Promise<string | null>>();
  // a problem is logged once, however often it is asked for
  const told = new Set<string>();
  const tell = (id: string, msg: string) => {
    if (told.has(id)) return;
    told.add(id);
    log(msg);
  };
  let reads = 0;
  let running = 0;
  let peakAtOnce = 0;
  const waiting: (() => void)[] = [];
  const slot = async () => {
    while (running >= atOnce) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    peakAtOnce = Math.max(peakAtOnce, running);
  };
  const release = () => {
    running--;
    waiting.shift()?.();
  };
  const read = async (entry: SpaceProblemEntry): Promise<string | null> => {
    const { file, offset, length } = configLocation(entry);
    await slot();
    reads++;
    let text: string;
    try {
      const fh = await open(spaceConfigPath(root, space, file), "r");
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        text = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await fh.close();
      }
    } catch (e) {
      // not "told": a read that failed may succeed next time
      log(`[spaces] ${entry.id}: configuration not read: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      release();
    }
    const checked = readLine(space, entry, text);
    if (typeof checked !== "string") {
      tell(entry.id, `[spaces] ${entry.id}: configuration left out: ${checked.error}`);
      return null;
    }
    cache.set(entry.id, checked);
    bytes += checked.length;
    while (bytes > limitBytes && cache.size > 1) {
      const [oldest, value] = cache.entries().next().value!;
      cache.delete(oldest);
      bytes -= value.length;
    }
    return checked;
  };
  return {
    load: async (entry) => {
      if (!entry.configApart) return entry.config;
      const hit = cache.get(entry.id);
      if (hit !== undefined) {
        cache.delete(entry.id);
        cache.set(entry.id, hit);
        return hit;
      }
      let p = pending.get(entry.id);
      if (!p) {
        p = read(entry).finally(() => pending.delete(entry.id));
        pending.set(entry.id, p);
      }
      return p;
    },
    cached: () => [...cache.keys()],
    stats: () => ({ reads, peakAtOnce, bytes }),
  };
}

/** A configuration kept apart, read at once (tests and tools; the server uses the cached loader). */
export function readEntryConfigSync(root: string, catalogue: SpaceCatalogue, entry: SpaceProblemEntry): string | null {
  if (!entry.configApart) return entry.config;
  const { file, offset, length } = configLocation(entry);
  try {
    const fd = openSync(spaceConfigPath(root, catalogue.space, file), "r");
    try {
      const buf = Buffer.alloc(length);
      const n = readSync(fd, buf, 0, length, offset);
      const checked = readLine(catalogue.space, entry, buf.subarray(0, n).toString("utf8"));
      return typeof checked === "string" ? checked : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function catalogueOf(root: string, space: SpaceName, file: unknown, log: (msg: string) => void): SpaceCatalogue {
  const catalogue = buildSpaceCatalogue(space, file);
  for (const s of catalogue.skipped) log(`[spaces] ${space} record left out: ${s}`);
  const apart = catalogue.problems.filter((p) => p.configApart).length;
  if (apart) catalogue.loadConfig = configLoader(root, catalogue, log).load;
  log(
    `[spaces] ${space}: ${catalogue.problems.length} problems (records of ${catalogue.generated ?? "unknown date"})` +
      (apart ? `, ${apart} configurations read on demand` : ""),
  );
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
      index[space] = catalogueOf(root, space, JSON.parse(readFileSync(path, "utf8")), log);
    } catch (e) {
      log(`[spaces] ${space} records not loaded: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return index;
}
