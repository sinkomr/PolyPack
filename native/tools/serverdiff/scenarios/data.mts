// Real data for the scenarios: the research records of the spaces (data/<space>/), the site's
// leading entries of the nightly snapshot (flat boards in n-*.json.gz, space entries in
// space-*.json.gz). The snapshot directories are outside the repository; SERVERDIFF_SNAP and
// SERVERDIFF_SPACESNAP name them. Scenarios that need a file that is not there are left out.
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { SPACE_NAMES, SpaceName, SpacesIndex, parseSpaceId } from "@polypack/spaces";
import { loadSpacesIndex, readEntryConfigSync } from "@polypack/spaces/load";
import { REPO } from "../lib/runner.mts";
import { rng } from "./dsl.mts";

export const SNAP_DIR = process.env.SERVERDIFF_SNAP ?? "";
export const SPACESNAP_DIR = process.env.SERVERDIFF_SPACESNAP ?? "";

let loaded: SpacesIndex | null = null;
/** The catalogues of the repository's data, as the server loads them. */
export function index(): SpacesIndex {
  return (loaded ??= loadSpacesIndex(REPO));
}

/** A research record with its configuration. */
export interface Record_ {
  space: SpaceName;
  id: string;
  P: number;
  score: number;
  config: Record<string, unknown>;
}

/** Research records of a space that have a configuration, smallest P first, at most `count`, P at most `maxP`. */
export function researchRecords(space: SpaceName, count: number, maxP = 40, seed = 1): Record_[] {
  const cat = index()[space];
  if (!cat) return [];
  const random = rng(seed);
  const pool = cat.problems.filter((p) => p.certified && p.P <= maxP).map((p) => [random(), p] as const);
  pool.sort((a, b) => a[0] - b[0]);
  const out: Record_[] = [];
  for (const [, p] of pool) {
    if (out.length >= count) break;
    const text = p.configApart ? readEntryConfigSync(REPO, cat, p) : p.config;
    if (!text) continue;
    out.push({ space, id: p.id, P: p.P, score: p.certified!.score, config: JSON.parse(text) as Record<string, unknown> });
  }
  return out.sort((a, b) => a.P - b.P || (a.id < b.id ? -1 : 1));
}

/** One research record by its id; null when the catalogue has no configuration for it. */
export function recordById(space: SpaceName, id: string): Record_ | null {
  const cat = index()[space];
  const p = cat?.byId.get(id);
  if (!cat || !p || !p.certified) return null;
  const text = p.configApart ? readEntryConfigSync(REPO, cat, p) : p.config;
  return text ? { space, id, P: p.P, score: p.certified.score, config: JSON.parse(text) as Record<string, unknown> } : null;
}

/** The lines of a gzipped file, at most `max` of them (the file is not read further). */
export async function gzLines(file: string, max: number): Promise<string[]> {
  const lines: string[] = [];
  const input = createReadStream(file);
  const rl = createInterface({ input: input.pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    lines.push(line);
    if (lines.length >= max) break;
  }
  rl.close();
  input.destroy();
  return lines;
}

/** A record line of a snapshot file, which ends with a comma or with the brackets that close the file. */
export function parseLine(line: string): Record<string, unknown> | null {
  let text = line.trim();
  for (let k = 0; k < 5; k++) {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      text = text.slice(0, -1);
    }
  }
  return null;
}

/** A leading entry of a space, from the snapshot. */
export interface SiteEntry {
  space: SpaceName;
  problem: string;
  P: number;
  score: number;
  name: string;
  software: string | null;
  method: string | null;
  config: Record<string, unknown>;
}

const snapCache = new Map<string, SiteEntry[]>();
/** The first `lines` leading entries of a space in the snapshot; [] when the file is not there. */
export async function siteEntries(space: SpaceName, lines = 4000): Promise<SiteEntry[]> {
  const key = `${space}:${lines}`;
  const hit = snapCache.get(key);
  if (hit) return hit;
  const file = join(SPACESNAP_DIR, `space-${space}.json.gz`);
  const out: SiteEntry[] = [];
  if (SPACESNAP_DIR && existsSync(file))
    for (const line of await gzLines(file, lines + 1)) {
      if (!line.startsWith('{"problem":')) continue;
      const r = parseLine(line);
      if (r && typeof r.problem === "string" && r.config && typeof r.config === "object")
        out.push({
          space,
          problem: r.problem,
          P: r.P as number,
          score: r.score as number,
          name: String(r.name ?? "someone"),
          software: (r.software as string | null) ?? null,
          method: (r.method as string | null) ?? null,
          config: r.config as Record<string, unknown>,
        });
    }
  snapCache.set(key, out);
  return out;
}

/** A leading polygon board of the snapshot. */
export interface Board {
  N: number;
  M: number;
  P: number;
  name: string;
  found_with: string | null;
  container_phi: number;
  pieces: number[][];
}

/**
 * `count` leading boards drawn from every n-*.json.gz, each with the same chance (one pass, a
 * reservoir), with the pieces of all of them together at most `maxPieces`. Kept in `cacheDir`.
 */
export async function boards(count: number, seed: number, cacheDir: string, maxP = 500): Promise<Board[]> {
  if (!SNAP_DIR || !existsSync(SNAP_DIR)) return [];
  const files = readdirSync(SNAP_DIR).filter((f) => /^n-\d+\.json\.gz$/.test(f)).sort();
  if (!files.length) return [];
  const cache = cacheDir ? join(cacheDir, `boards-${count}-${seed}-${maxP}.json`) : "";
  if (cache && existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8")) as Board[];
  const random = rng(seed);
  const kept: { N: number; M: number; line: string }[] = [];
  let seen = 0;
  for (const f of files) {
    let N = 0;
    let M = 0;
    const input = createReadStream(join(SNAP_DIR, f));
    for await (const line of createInterface({ input: input.pipe(createGunzip()), crlfDelay: Infinity })) {
      if (!line.startsWith('{"P":')) {
        const n = /^\{"format":\d+,"N":(\d+)/.exec(line);
        if (n) N = Number(n[1]);
        const m = /"M":(\d+),"records"/.exec(line);
        if (m) M = Number(m[1]);
        continue;
      }
      if (maxP < 500 && Number(/^\{"P":(\d+)/.exec(line)![1]) > maxP) continue;
      seen++;
      if (kept.length < count) kept.push({ N, M, line });
      else {
        const at = Math.floor(random() * seen);
        if (at < count) kept[at] = { N, M, line };
      }
    }
  }
  const out: Board[] = [];
  for (const k of kept) {
    const r = parseLine(k.line);
    if (!r) continue;
    out.push({
      N: k.N,
      M: k.M,
      P: r.P as number,
      name: String(r.name ?? "someone"),
      found_with: (r.found_with as string | null) ?? null,
      container_phi: (r.container_phi as number) ?? 0,
      pieces: r.pieces as number[][],
    });
  }
  if (cache) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cache, JSON.stringify(out));
  }
  return out;
}

/** A configuration scaled by `f` about the origin, its size included: a shrunk one is the usual invalid mutant. */
export function scaled(space: SpaceName, id: string, c: any, f: number): any {
  const pts = (list: any, n: number) =>
    Array.isArray(list) ? list.map((p: any) => (Array.isArray(p) ? p.map((v: any, i: number) => (i < n && typeof v === "number" ? v * f : v)) : p)) : list;
  const xy = (list: any) =>
    Array.isArray(list) ? list.map((p: any) => (p && typeof p === "object" ? { ...p, x: p.x * f, y: p.y * f } : p)) : list;
  switch (space) {
    case "surface":
      return { ...c, s: c.s * f, pieces: xy(c.pieces) };
    case "curved":
      return { ...c, size: c.size * f, pieces: xy(c.pieces) };
    case "sphere":
      return { ...c, rho: c.rho * f };
    case "torus": {
      const L = c.lattice ?? {};
      const lattice = "L" in L ? { L: L.L * f } : { b1: L.b1.map((x: number) => x * f), b2: L.b2.map((x: number) => x * f) };
      return { ...c, lattice, poses: pts(c.poses, 2) };
    }
    case "boundary":
      return { ...c, s: c.s * f, pieces: c.pieces.map((q: any) => ({ ...q, u: q.u.map((x: number) => x * f) })) };
    case "polyhedra":
    case "balls":
      return { ...c, s: c.s * f, pieces: pts(c.pieces, 3) };
    case "ndim": {
      const parsed = parseSpaceId("ndim", id);
      const d = typeof parsed === "string" ? 4 : Number(parsed.fields.d);
      return { ...c, s: c.s * f, pieces: pts(c.pieces, d) };
    }
  }
}

/** The key of a configuration that holds its pieces. */
export const piecesKey = (space: SpaceName) => (space === "torus" ? "poses" : "pieces");
export { SPACE_NAMES };
export type { SpaceName };
