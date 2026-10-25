/**
 * Node only (not exported by the package's entry, so that pages never import node:fs): reads a records file
 * written by python/polyhedra/build_records.py with each record's configuration attached. The records file is
 * an index; the configurations are kept apart, one file per problem in configs/<code>.jsonl beside it, one line
 * {"P", "config": {s, pieces}} per P, and each record's config_at = [offset, length] locates its line.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PolyhedraConfig } from "./validate";
import type { PolyhedraRecordsFile } from "./records";

/** The configurations of one problem by P, from configs/<code>.jsonl beside the records file (none when it is missing). */
export function readProblemConfigs(recordsPath: string, code: string): Map<number, PolyhedraConfig> {
  const path = join(dirname(recordsPath), "configs", `${code}.jsonl`);
  const out = new Map<number, PolyhedraConfig>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line) as { P: number; config: PolyhedraConfig };
    out.set(row.P, row.config);
  }
  return out;
}

/**
 * The records file with every record's `config` attached from its problem's file. Records whose configuration
 * is missing are kept without one when `keepMissing` is true, and otherwise make this throw.
 */
export function readRecordsFile(path: string, keepMissing = false): PolyhedraRecordsFile {
  const doc = JSON.parse(readFileSync(path, "utf8")) as PolyhedraRecordsFile;
  const byCode = new Map<string, Map<number, PolyhedraConfig>>();
  for (const r of doc.records) {
    if (r.config) continue;
    let configs = byCode.get(r.code);
    if (!configs) byCode.set(r.code, (configs = readProblemConfigs(path, r.code)));
    const c = configs.get(r.P);
    if (c) r.config = c;
    else if (!keepMissing) throw new Error(`${r.id}: no configuration in configs/${r.code}.jsonl`);
  }
  return doc;
}
