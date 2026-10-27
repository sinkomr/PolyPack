import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SPACE_NAMES, isSpaceName, parseSpaceId, type SpaceName } from "@polypack/spaces";
import { blobFromJson, decodePieces, encodePieces } from "./pieces";

/**
 * The unit change of 2026-10-27: disk and ball pieces have DIAMETER 1 (they had radius 1), and circle and ball
 * containers are scored by their DIAMETER (they were scored by radius). A problem affected by it is the old one scaled
 * exactly by 1/2 (and, for a container that changes from radius to diameter, its score then doubled), so every length
 * of a stored entry is multiplied by a power of two, which binary64 holds exactly and which reverses exactly.
 *
 * The state of a database is `meta.units_epoch`: absent or below 2, the old units; 2, the new. The conversion and the
 * marker are one transaction, so a crash leaves all old or all new, and a second start does nothing. A new database
 * starts at 2. `migrateUnits(db, true)` is the exact reverse (for a rollback), which sets the marker to 1.
 *
 * Per entry (the lengths of the pieces of a 2D row are x and y; theta is untouched):
 *  - 2D, N = 0, M = 0:  score x 1, pieces x 1/2   (a disk container's diameter is the old radius, in the new disks);
 *  - 2D, N = 0, M >= 3: score x 1/2, pieces x 1/2;
 *  - 2D, N >= 3, M = 0: score x 2, pieces x 1 (polygons keep side 1; the container's diameter is twice its radius);
 *  - literature_value and strict_check.certifiedSize follow the score rule of their row.
 * Spaces (the config JSON, `score` and the score field of the config move together):
 *  - surface (N = 0): s, x, y x 1/2;  sphere (N = 0): rho x 1/2;  torus (N = 0): lattice, x, y x 1/2;
 *  - boundary (piece ball): s, u x 1/2;
 *  - balls: ball pieces in a ball: s x 1, centres x 1/2; ball pieces in a solid: s, centres x 1/2; solids in a ball:
 *    s x 2, poses x 1;
 *  - curved: K = 0, N = 0: size x 1 (M = 0) or 1/2 (M >= 3), x, y x 1/2; N >= 3, M = 0: size x 2 (any K). A disk
 *    problem at K != 0 has no equivalent at the same K (the old radius-1 disks at K are diameter-1 disks at 4K), so
 *    those entries are moved to `space_entries_units_archive` (not served), and moved back by the reverse.
 */
export const UNITS_EPOCH = "units_epoch";
/** The epoch of diameter-1 disks and balls. */
export const EPOCH_DIAMETER = 2;
/** The epoch of the radius-1 disks and balls; what the reverse sets. */
export const EPOCH_RADIUS = 1;

const ARCHIVE = `
CREATE TABLE IF NOT EXISTS space_entries_units_archive (
  id INTEGER PRIMARY KEY,
  space TEXT NOT NULL,
  problem TEXT NOT NULL,
  score REAL NOT NULL,
  name TEXT NOT NULL,
  agent_note TEXT NOT NULL,
  software TEXT,
  method TEXT,
  seed INTEGER,
  created_at TEXT NOT NULL,
  config TEXT NOT NULL,
  epoch INTEGER NOT NULL
);`;

type Row = Record<string, unknown>;

export interface UnitsReport {
  /** "forward" or "reverse"; "none" when the database was already in the target epoch. */
  action: "forward" | "reverse" | "none";
  submissions: Record<string, number>;
  spaceEntries: Record<string, number>;
  /** Entries moved to the archive (forward) or out of it (reverse, returned in `restored`). */
  archived: number;
  restored: number;
  /** Rows left as they were because their stored pieces or config could not be read. */
  unreadable: number;
  ms: number;
}

/** The epoch a database is in: 2 for diameter units. A database with no marker is in the old units. */
export function unitsEpoch(db: DatabaseSync): number {
  const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(UNITS_EPOCH) as Row | undefined;
  return r ? (r.value as number) : 0;
}

export function setUnitsEpoch(db: DatabaseSync, value: number): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
    UNITS_EPOCH,
    value,
  );
}

/** Factors for a 2D problem (a length factor for the pieces, a factor for the score), or null when unaffected. */
export function planarFactors(N: number, M: number): { len: number; score: number } | null {
  if (N === 0) return { len: 0.5, score: M === 0 ? 1 : 0.5 };
  if (M === 0) return { len: 1, score: 2 };
  return null;
}

interface SpacePlan {
  /** Factor of the score (and of the config's score field). */
  score: number;
  /** Rewrites the config in place; `f` is `score` and `len` the length factor. */
  apply: (cfg: Record<string, unknown>) => void;
  label: string;
}
/** An entry that is moved aside instead of converted. */
const ARCHIVED = "archive" as const;

function scaleNumber(o: Record<string, unknown>, key: string, f: number): void {
  if (typeof o[key] === "number") o[key] = (o[key] as number) * f;
}
function scaleList(list: unknown, f: number, ...indices: number[]): void {
  if (!Array.isArray(list)) return;
  for (const i of indices) if (typeof list[i] === "number") list[i] = (list[i] as number) * f;
}
function eachPiece(cfg: Record<string, unknown>, key: string, fn: (p: Record<string, unknown>) => void): void {
  const list = cfg[key];
  if (Array.isArray(list)) for (const p of list) if (typeof p === "object" && p !== null) fn(p as Record<string, unknown>);
}

/** What the unit change does to the entries of one space problem; null when it leaves them alone. */
export function spacePlan(space: string, id: string): SpacePlan | typeof ARCHIVED | null {
  if (!isSpaceName(space)) return null;
  const parsed = parseSpaceId(space as SpaceName, id);
  if (typeof parsed === "string") return null;
  const f = parsed.fields as Record<string, string | number>;
  switch (space) {
    case "surface":
      if (f.N !== 0) return null;
      return {
        score: 0.5,
        label: "surface disks",
        apply: (c) => {
          scaleNumber(c, "s", 0.5);
          eachPiece(c, "pieces", (p) => {
            scaleNumber(p, "x", 0.5);
            scaleNumber(p, "y", 0.5);
          });
        },
      };
    case "sphere":
      if (f.N !== 0) return null;
      return { score: 0.5, label: "sphere disks", apply: (c) => scaleNumber(c, "rho", 0.5) };
    case "torus":
      if (f.N !== 0) return null;
      return {
        score: 0.5,
        label: "torus disks",
        apply: (c) => {
          const l = c.lattice;
          if (typeof l === "object" && l !== null) {
            const lat = l as Record<string, unknown>;
            scaleNumber(lat, "L", 0.5);
            scaleList(lat.b1, 0.5, 0, 1);
            scaleList(lat.b2, 0.5, 0, 1);
          }
          if (Array.isArray(c.poses)) for (const p of c.poses) scaleList(p, 0.5, 0, 1);
        },
      };
    case "boundary":
      if (f.piece !== "ball") return null;
      return {
        score: 0.5,
        label: "boundary balls",
        apply: (c) => {
          scaleNumber(c, "s", 0.5);
          eachPiece(c, "pieces", (p) => {
            if (Array.isArray(p.u)) p.u = p.u.map((v) => (typeof v === "number" ? v * 0.5 : v));
          });
        },
      };
    case "balls": {
      const ballPiece = f.piece === "ball";
      const ballBox = f.container === "ball";
      if (ballPiece)
        return {
          score: ballBox ? 1 : 0.5,
          label: ballBox ? "balls in a ball" : "balls in a solid",
          apply: (c) => {
            scaleNumber(c, "s", ballBox ? 1 : 0.5);
            if (Array.isArray(c.pieces)) for (const p of c.pieces) scaleList(p, 0.5, 0, 1, 2);
          },
        };
      if (ballBox) return { score: 2, label: "solids in a ball", apply: (c) => scaleNumber(c, "s", 2) };
      return null;
    }
    case "curved": {
      const N = f.N as number;
      const M = f.M as number;
      const K = f.K as number;
      if (N === 0 && K !== 0) return ARCHIVED;
      if (N === 0) {
        const size = M === 0 ? 1 : 0.5;
        return {
          score: size,
          label: "flat disks",
          apply: (c) => {
            scaleNumber(c, "size", size);
            eachPiece(c, "pieces", (p) => {
              scaleNumber(p, "x", 0.5);
              scaleNumber(p, "y", 0.5);
            });
          },
        };
      }
      if (M === 0) return { score: 2, label: "curved polygons in a disk", apply: (c) => scaleNumber(c, "size", 2) };
      return null;
    }
    case "polyhedra":
      return null;
  }
  return null;
}

/** The reverse rewrites, written out beside the forward ones above so that the two are easy to compare (all factors are powers of two). */
function inversePasses(space: string, id: string, c: Record<string, unknown>): void {
  const parsed = parseSpaceId(space as SpaceName, id);
  if (typeof parsed === "string") return;
  const f = parsed.fields as Record<string, string | number>;
  switch (space) {
    case "surface":
      scaleNumber(c, "s", 2);
      eachPiece(c, "pieces", (p) => {
        scaleNumber(p, "x", 2);
        scaleNumber(p, "y", 2);
      });
      return;
    case "sphere":
      scaleNumber(c, "rho", 2);
      return;
    case "torus": {
      const l = c.lattice;
      if (typeof l === "object" && l !== null) {
        const lat = l as Record<string, unknown>;
        scaleNumber(lat, "L", 2);
        scaleList(lat.b1, 2, 0, 1);
        scaleList(lat.b2, 2, 0, 1);
      }
      if (Array.isArray(c.poses)) for (const p of c.poses) scaleList(p, 2, 0, 1);
      return;
    }
    case "boundary":
      scaleNumber(c, "s", 2);
      eachPiece(c, "pieces", (p) => {
        if (Array.isArray(p.u)) p.u = p.u.map((v) => (typeof v === "number" ? v * 2 : v));
      });
      return;
    case "balls":
      if (f.piece === "ball") {
        scaleNumber(c, "s", f.container === "ball" ? 1 : 2);
        if (Array.isArray(c.pieces)) for (const p of c.pieces) scaleList(p, 2, 0, 1, 2);
      } else scaleNumber(c, "s", 0.5);
      return;
    case "curved": {
      const N = f.N as number;
      const M = f.M as number;
      if (N === 0) {
        scaleNumber(c, "size", M === 0 ? 1 : 2);
        eachPiece(c, "pieces", (p) => {
          scaleNumber(p, "x", 2);
          scaleNumber(p, "y", 2);
        });
      } else scaleNumber(c, "size", 0.5);
      return;
    }
  }
}
function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Converts the entries of `db` between the two units, WITHOUT a transaction of its own (the caller holds one, so that
 * the conversion and the marker commit together). `reverse` converts from diameter units back to radius units.
 * Returns what it did; a database already in the target epoch is left alone.
 */
export function applyUnits(db: DatabaseSync, reverse: boolean): UnitsReport {
  const start = performance.now();
  const report: UnitsReport = {
    action: reverse ? "reverse" : "forward",
    submissions: {},
    spaceEntries: {},
    archived: 0,
    restored: 0,
    unreadable: 0,
    ms: 0,
  };
  const epoch = unitsEpoch(db);
  if (reverse ? epoch !== EPOCH_DIAMETER : epoch >= EPOCH_DIAMETER) {
    report.action = "none";
    return report;
  }
  db.exec(ARCHIVE);

  // 2D submissions: only the rows of affected problems are read (n = 0 or m = 0)
  const rows = db
    .prepare(
      "SELECT id, n, m, score, pieces, literature_value, strict_check FROM submissions WHERE n = 0 OR m = 0 ORDER BY id",
    )
    .all() as Row[];
  const update = db.prepare(
    "UPDATE submissions SET score = ?, pieces = ?, literature_value = ?, strict_check = ? WHERE id = ?",
  );
  for (const r of rows) {
    const fac = planarFactors(r.n as number, r.m as number);
    if (!fac) continue;
    const kind = `n=${r.n === 0 ? "0" : ">=3"} m=${r.m === 0 ? "0" : ">=3"}`;
    const lenF = reverse ? 1 / fac.len : fac.len;
    const scoreF = reverse ? 1 / fac.score : fac.score;
    let blob: Uint8Array | null;
    if (r.pieces instanceof Uint8Array) blob = r.pieces;
    else blob = typeof r.pieces === "string" ? blobFromJson(r.pieces) : null;
    if (blob === null) {
      report.unreadable++;
      continue;
    }
    let pieces: Uint8Array = blob;
    if (lenF !== 1) {
      const poses = decodePieces(blob).map((p) => ({ x: p.x * lenF, y: p.y * lenF, theta: p.theta }));
      pieces = encodePieces(poses);
    }
    let strict = r.strict_check as string | null;
    if (strict) {
      try {
        const s = JSON.parse(strict) as Record<string, unknown>;
        scaleNumber(s, "certifiedSize", scoreF);
        strict = JSON.stringify(s);
      } catch {
        // an unreadable certificate stays as it was; the row is counted below
        report.unreadable++;
      }
    }
    update.run(
      (r.score as number) * scoreF,
      pieces,
      r.literature_value === null ? null : (r.literature_value as number) * scoreF,
      strict,
      r.id as number,
    );
    bump(report.submissions, kind);
  }

  // space entries
  const entries = db
    .prepare("SELECT id, space, problem, score, config FROM space_entries WHERE space IN (" + SPACE_NAMES.map(() => "?").join(",") + ") ORDER BY id")
    .all(...SPACE_NAMES) as Row[];
  const updateEntry = db.prepare("UPDATE space_entries SET score = ?, config = ? WHERE id = ?");
  const toArchive = db.prepare(
    `INSERT INTO space_entries_units_archive (id, space, problem, score, name, agent_note, software, method, seed, created_at, config, epoch)
     SELECT id, space, problem, score, name, agent_note, software, method, seed, created_at, config, ? FROM space_entries WHERE id = ?`,
  );
  const dropEntry = db.prepare("DELETE FROM space_entries WHERE id = ?");
  const cache = new Map<string, ReturnType<typeof spacePlan>>();
  for (const r of entries) {
    const key = `${r.space}\u0000${r.problem}`;
    let plan = cache.get(key);
    if (plan === undefined) {
      plan = spacePlan(r.space as string, r.problem as string);
      cache.set(key, plan);
    }
    if (plan === null) continue;
    if (plan === ARCHIVED) {
      toArchive.run(reverse ? EPOCH_DIAMETER : EPOCH_RADIUS, r.id as number);
      dropEntry.run(r.id as number);
      report.archived++;
      continue;
    }
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(r.config as string) as Record<string, unknown>;
      if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) throw new Error("not an object");
    } catch {
      report.unreadable++;
      continue;
    }
    if (reverse) inversePasses(r.space as string, r.problem as string, cfg);
    else plan.apply(cfg);
    updateEntry.run((r.score as number) * (reverse ? 1 / plan.score : plan.score), JSON.stringify(cfg), r.id as number);
    bump(report.spaceEntries, plan.label);
  }
  // entries archived in the other direction come back, in the units of the epoch they were archived from
  const back = db
    .prepare(
      `INSERT INTO space_entries (id, space, problem, score, name, agent_note, software, method, seed, created_at, config)
       SELECT id, space, problem, score, name, agent_note, software, method, seed, created_at, config
       FROM space_entries_units_archive WHERE epoch = ?`,
    )
    .run(reverse ? EPOCH_RADIUS : EPOCH_DIAMETER);
  report.restored = Number(back.changes);
  db.prepare("DELETE FROM space_entries_units_archive WHERE epoch = ?").run(reverse ? EPOCH_RADIUS : EPOCH_DIAMETER);
  setUnitsEpoch(db, reverse ? EPOCH_RADIUS : EPOCH_DIAMETER);
  report.ms = performance.now() - start;
  return report;
}

/** The start-up conversion: one transaction, run once (a database in diameter units is left alone). */
export function migrateUnits(db: DatabaseSync, reverse = false): UnitsReport {
  db.exec("BEGIN IMMEDIATE");
  try {
    const report = applyUnits(db, reverse);
    db.exec("COMMIT");
    return report;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** A digest of every converted table (rows in id order), to compare a database before and after a round trip. */
export function unitsDigest(db: DatabaseSync): string {
  const h = createHash("sha256");
  const feed = (rows: Row[]) => {
    for (const r of rows)
      for (const v of Object.values(r)) {
        if (v instanceof Uint8Array) h.update(v);
        else if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) h.update(JSON.stringify(JSON.parse(v)));
        else h.update(String(v));
        h.update("\u0001");
      }
  };
  feed(db.prepare("SELECT id, n, m, p, score, pieces, literature_value, strict_check FROM submissions ORDER BY id").all() as Row[]);
  feed(db.prepare("SELECT id, space, problem, score, config FROM space_entries ORDER BY id").all() as Row[]);
  return h.digest("hex");
}
