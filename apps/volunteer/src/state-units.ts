/**
 * The state directory across the unit change. Before 0.2.0 the saved packings and history were in the old units (disks and balls
 * of radius 1, circle and ball containers scored by radius); read as they are in the new ones they would be valid but poor, and
 * their scores would be compared with leaders of the other units. `state.json` ({"state_version": 2, "units": "diameter"})
 * says which units a directory is in; a directory without it is converted once, when the client with the lock opens it:
 *
 *  - best/N-M-P.json of a flat problem of the change: its score and the x and y of its disks are multiplied by the exact factors
 *    of units.ts (the file is rewritten atomically); a file that cannot be read as a best file is moved aside;
 *  - best/spaces/*.json: the same for the space problems whose configuration this client can convert exactly (every flat
 *    kind but curved disks at K other than 0, whose problem has no equivalent at the same K); those files, and any it cannot
 *    read, are moved to best-old-units/ (kept, never read again);
 *  - history.jsonl: the scores of the lines of those problems are converted (they are only shown and compared with
 *    each other), unreadable lines are left as they are;
 *  - memory.json holds shares and rates, which have no length in them: kept.
 *
 * Nothing is deleted: what is set aside is in best-old-units/. The marker is written last, so an interrupted conversion is
 * done again, and converting a file twice cannot happen because the files of a half-done run are rewritten atomically and
 * the marker is only set after all of them (a re-run skips files whose "units" field says "diameter").
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { type SpaceName, parseSpaceId } from "@polypack/spaces";
import { planarFactors, spaceScoreFactor } from "./units";
import { writeFileAtomic } from "./atomic";
import { STATE_VERSION, UNITS } from "./version";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export interface StateUnitsReport {
  /** True when the directory was already in the new units, or new. */
  already: boolean;
  convertedBest: number;
  convertedSpaceBest: number;
  setAside: number;
  historyLines: number;
}

function scaleScore(o: Json, key: string, f: number): number {
  if (typeof o[key] === "number") {
    o[key] = (o[key] as number) * f;
    return 1;
  }
  return 0;
}

/** A configuration of the old units, converted; null when the shape is not one this knows. */
export function convertSpaceConfig(space: string, id: string, config: unknown): Json | null {
  if (!isObject(config)) return null;
  const c = JSON.parse(JSON.stringify(config)) as Json;
  const parsedId = parseSpaceId(space as SpaceName, id);
  if (typeof parsedId === "string") return null;
  const fields = parsedId.fields as Record<string, string | number>;
  const half = (v: unknown) => (typeof v === "number" ? v * 0.5 : v);
  const pieces = Array.isArray(c.pieces) ? (c.pieces as unknown[]) : null;
  const factor = spaceScoreFactor(space, id);
  if (factor === null || factor === "set-aside") return null;
  const eachObject = (list: unknown[] | null, fn: (p: Json) => void) => {
    for (const p of list ?? []) if (isObject(p)) fn(p);
  };
  switch (space) {
    case "surface":
      scaleScore(c, "s", 0.5);
      eachObject(pieces, (p) => {
        p.x = half(p.x);
        p.y = half(p.y);
      });
      return c;
    case "sphere":
      scaleScore(c, "rho", 0.5);
      return c;
    case "torus": {
      if (isObject(c.lattice)) {
        const l = c.lattice;
        scaleScore(l, "L", 0.5);
        for (const k of ["b1", "b2"]) if (Array.isArray(l[k])) l[k] = (l[k] as unknown[]).map(half);
      }
      if (Array.isArray(c.poses)) c.poses = (c.poses as unknown[]).map((p) => (Array.isArray(p) ? [half(p[0]), half(p[1]), ...p.slice(2)] : p));
      return c;
    }
    case "boundary":
      scaleScore(c, "s", 0.5);
      eachObject(pieces, (p) => {
        if (Array.isArray(p.u)) p.u = p.u.map(half);
      });
      return c;
    case "balls": {
      scaleScore(c, "s", factor);
      if (fields.piece === "ball" && pieces)
        c.pieces = pieces.map((p) => (Array.isArray(p) ? [half(p[0]), half(p[1]), half(p[2]), ...p.slice(3)] : p));
      return c;
    }
    case "curved":
      scaleScore(c, "size", factor);
      if (fields.N === 0)
        eachObject(pieces, (p) => {
          p.x = half(p.x);
          p.y = half(p.y);
        });
      return c;
    default:
      return null;
  }
}

function convertHistoryLine(line: Json): boolean {
  let factor: number | "set-aside" | null;
  if (typeof line.space === "string" && typeof line.id === "string") factor = spaceScoreFactor(line.space, line.id);
  else {
    const f = planarFactors(Number(line.N), Number(line.M));
    factor = f ? f.score : null;
  }
  if (factor === null || factor === 1) return false;
  if (factor === "set-aside") return false;
  for (const key of ["leader_before", "leader_after", "best", "response"]) {
    const part = line[key];
    if (!isObject(part)) continue;
    for (const k of ["score", "leader_score", "best_score"]) scaleScore(part, k, factor);
  }
  scaleScore(line, "bound", factor);
  return true;
}

export function stateMarkerPath(dir: string): string {
  return join(dir, "state.json");
}

function readMarker(dir: string): number {
  try {
    const v = JSON.parse(readFileSync(stateMarkerPath(dir), "utf8"));
    return isObject(v) && typeof v.state_version === "number" ? v.state_version : 1;
  } catch {
    return 1;
  }
}

function listJson(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
}

function setAside(stateDir: string, path: string, rel: string[]): void {
  const target = join(stateDir, "best-old-units", ...rel.slice(0, -1));
  mkdirSync(target, { recursive: true });
  renameSync(path, join(target, rel[rel.length - 1]));
}

/**
 * Brings `dir` to the current units; the caller holds the directory's lock. A directory with nothing in it is only marked.
 * `log` receives one line when something was converted or set aside.
 */
export function migrateStateUnits(dir: string, log: (message: string) => void = () => {}): StateUnitsReport {
  const report: StateUnitsReport = { already: true, convertedBest: 0, convertedSpaceBest: 0, setAside: 0, historyLines: 0 };
  if (readMarker(dir) >= STATE_VERSION) return report;
  report.already = false;

  for (const name of listJson(join(dir, "best"))) {
    const path = join(dir, "best", name);
    const m = /^(\d+)-(\d+)-(\d+)\.json$/.exec(name);
    let file: Json;
    try {
      file = JSON.parse(readFileSync(path, "utf8")) as Json;
    } catch {
      if (m) {
        setAside(dir, path, [name]);
        report.setAside++;
      }
      continue;
    }
    if (!m || !isObject(file)) continue;
    const f = planarFactors(Number(m[1]), Number(m[2]));
    if (!f) continue;
    const config = file.config;
    if (file.units === UNITS || !isObject(config) || !Array.isArray(config.pieces) || typeof file.score !== "number") {
      setAside(dir, path, [name]);
      report.setAside++;
      continue;
    }
    if (f.len !== 1)
      config.pieces = (config.pieces as unknown[]).map((p) => (isObject(p) ? { ...p, x: Number(p.x) * f.len, y: Number(p.y) * f.len } : p));
    file.score = (file.score as number) * f.score;
    file.units = UNITS;
    writeFileAtomic(path, JSON.stringify(file, null, 1) + "\n");
    report.convertedBest++;
  }

  for (const name of listJson(join(dir, "best", "spaces"))) {
    const path = join(dir, "best", "spaces", name);
    let file: Json | null = null;
    try {
      file = JSON.parse(readFileSync(path, "utf8")) as Json;
    } catch {
      // moved aside below
    }
    if (!file || typeof file.space !== "string" || typeof file.id !== "string") {
      setAside(dir, path, ["spaces", name]);
      report.setAside++;
      continue;
    }
    const factor = spaceScoreFactor(file.space, file.id);
    if (factor === null) continue;
    const converted = factor === "set-aside" || file.units === UNITS ? null : convertSpaceConfig(file.space, file.id, file.config);
    if (!converted || typeof file.score !== "number") {
      setAside(dir, path, ["spaces", name]);
      report.setAside++;
      continue;
    }
    file.config = converted;
    file.score = (file.score as number) * (factor as number);
    file.units = UNITS;
    writeFileAtomic(path, JSON.stringify(file, null, 1) + "\n");
    report.convertedSpaceBest++;
  }

  const historyPath = join(dir, "history.jsonl");
  if (existsSync(historyPath)) {
    let changed = false;
    const out = readFileSync(historyPath, "utf8")
      .split("\n")
      .map((text) => {
        if (!text.trim()) return text;
        try {
          const line = JSON.parse(text) as unknown;
          if (isObject(line) && convertHistoryLine(line)) {
            changed = true;
            report.historyLines++;
            return JSON.stringify(line);
          }
        } catch {
          // a line cut short by a crash stays as it is
        }
        return text;
      })
      .join("\n");
    if (changed) writeFileAtomic(historyPath, out);
  }

  writeFileAtomic(stateMarkerPath(dir), JSON.stringify({ state_version: STATE_VERSION, units: UNITS }) + "\n");
  if (report.convertedBest || report.convertedSpaceBest || report.setAside || report.historyLines)
    log(
      `The state directory was from before the unit change (2026-10-27) and has been converted: ` +
        `${report.convertedBest + report.convertedSpaceBest} saved packing(s) converted, ${report.setAside} set aside in ` +
        `best-old-units/, ${report.historyLines} history line(s) rescaled.`,
    );
  return report;
}
