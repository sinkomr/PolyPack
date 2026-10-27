import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodePieces, readPieces } from "../src/pieces";
import { SqliteStore } from "../src/sqlite-store";
import {
  applyUnits,
  migrateUnits,
  planarFactors,
  spacePlan,
  unitsDigest,
  unitsEpoch,
} from "../src/units-migration";

const tmp = () => join(mkdtempSync(join(tmpdir(), "polypack-units-")), "db.sqlite");

// awkward doubles: halving and doubling must keep every bit
const A = 0.1 + 0.2;
const B = 1 / 3;

/** A database as it was before the unit change: radius-1 disks and balls, no epoch marker. */
function oldDatabase(): { path: string; db: DatabaseSync } {
  const path = tmp();
  new SqliteStore(path); // creates every table (and, being new, marks the epoch)
  const db = new DatabaseSync(path);
  db.exec("DELETE FROM meta WHERE key = 'units_epoch'");
  const sub = db.prepare(
    `INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at, verification, literature_value, strict_check)
     VALUES (?, ?, ?, ?, 'ann', '', ?, 0, '2026-10-20T00:00:00Z', ?, ?, ?)`,
  );
  const pieces = (xs: number[]) => encodePieces(xs.map((x, i) => ({ x, y: x * B + i, theta: A * i })));
  // disks in a circle: score unchanged, pieces halved
  sub.run(0, 0, 2, 3 + A, pieces([0, 2 + A]), "none", null, null);
  // disks in a square: score and pieces halved; a pending entry with its literature value and certificate
  sub.run(0, 4, 3, 5 + B, pieces([0, 2, 4]), "pending", 5.5, JSON.stringify({ ok: true, certifiedSize: 5.25, eps: 1e-8 }));
  // squares in a circle: pieces unchanged, score doubled
  sub.run(4, 0, 2, 2 + A, pieces([0, 1.5]), "none", null, null);
  // squares in a square: untouched
  sub.run(4, 4, 2, 2 + B, pieces([0, 1]), "none", null, null);
  // a leader and a worse entry of one problem: the order must survive
  sub.run(0, 5, 2, 7, pieces([0, 3]), "none", null, null);
  sub.run(0, 5, 2, 6 + B, pieces([0, 2.9]), "none", null, null);
  // an old entry that still has its pieces as JSON text
  db.prepare(
    `INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at, verification)
     VALUES (0, 6, 1, 4, 'jay', '', ?, 0, '2026-10-01T00:00:00Z', 'none')`,
  ).run(JSON.stringify([{ x: 1, y: 2, theta: 0 }]));
  const ent = db.prepare(
    `INSERT INTO space_entries (space, problem, score, name, agent_note, created_at, config) VALUES (?, ?, ?, 'ann', '', '2026-10-20T00:00:00Z', ?)`,
  );
  const poses = [[0, 0, 0], [A, B, 1]];
  ent.run("torus", "torus/sq/0/2", 4, JSON.stringify({ lattice: { L: 4 }, poses }));
  ent.run("torus", "torus/free/0/2", 3, JSON.stringify({ lattice: { b1: [3, 0], b2: [1, 3] }, poses }));
  ent.run("torus", "torus/sq/4/2", 5, JSON.stringify({ lattice: { L: 5 }, poses }));
  ent.run("sphere", "sphere/0/3", 1.5, JSON.stringify({ rho: 1.5, pieces: [{ q: [1, 0, 0, 0] }] }));
  ent.run("sphere", "sphere/4/3", 1.25, JSON.stringify({ rho: 1.25, pieces: [{ q: [1, 0, 0, 0] }] }));
  ent.run("surface", "surface/cube/fold/0/3", 2 + A, JSON.stringify({ s: 2 + A, pieces: [{ face: 1, x: A, y: B, theta: 2 }] }));
  ent.run("boundary", "boundary/tesseract/ball/3", 6, JSON.stringify({ s: 6, pieces: [{ cell: 2, u: [A, B, 1] }] }));
  ent.run("boundary", "boundary/tesseract/cube/3", 7, JSON.stringify({ s: 7, pieces: [{ cell: 2, u: [A, B, 1], q: [1, 0, 0, 0] }] }));
  ent.run("balls", "balls/ballinball/3", 5, JSON.stringify({ s: 5, pieces: [[A, B, 1]] }));
  ent.run("balls", "balls/ballincub/3", 6, JSON.stringify({ s: 6, pieces: [[A, B, 1]] }));
  ent.run("balls", "balls/cubinball/2", 2.8 / 2, JSON.stringify({ s: 1.4, pieces: [[0.6, 0, 0, 1, 0, 0, 0]] }));
  ent.run("curved", "curved/0/0/4/2", 5, JSON.stringify({ size: 5, pieces: [{ x: A, y: B, theta: 1 }] }));
  ent.run("curved", "curved/0/0/0/2", 3, JSON.stringify({ size: 3, pieces: [{ x: A, y: B, theta: 1 }] }));
  ent.run("curved", "curved/-1/3/0/2", 1.25, JSON.stringify({ size: 1.25, pieces: [{ x: A, y: B, theta: 1 }] }));
  ent.run("curved", "curved/1/0/0/2", 2, JSON.stringify({ size: 2, pieces: [{ x: A, y: B, theta: 1 }] }));
  ent.run("curved", "curved/-1/0/4/2", 6, JSON.stringify({ size: 6, pieces: [{ x: A, y: B, theta: 1 }] }));
  ent.run("curved", "curved/1/3/4/2", 2, JSON.stringify({ size: 2, pieces: [{ x: A, y: B, theta: 1 }] }));
  return { path, db };
}

const sub = (db: DatabaseSync, n: number, m: number, p: number) =>
  db.prepare("SELECT * FROM submissions WHERE n = ? AND m = ? AND p = ? ORDER BY id").all(n, m, p) as Record<string, any>[];
const entry = (db: DatabaseSync, problem: string) => {
  const r = db.prepare("SELECT score, config FROM space_entries WHERE problem = ?").get(problem) as any;
  return r ? { score: r.score as number, config: JSON.parse(r.config) } : null;
};

describe("the unit change's conversion of the database", () => {
  it("has the exact factors of each class", () => {
    expect(planarFactors(0, 0)).toEqual({ len: 0.5, score: 1 });
    expect(planarFactors(0, 7)).toEqual({ len: 0.5, score: 0.5 });
    expect(planarFactors(9, 0)).toEqual({ len: 1, score: 2 });
    expect(planarFactors(4, 4)).toBeNull();
    expect(spacePlan("polyhedra", "polyhedra/cubincub/8")).toBeNull();
    expect(spacePlan("curved", "curved/1/0/0/2")).toBe("archive");
    expect(spacePlan("curved", "curved/0/0/0/2")).toMatchObject({ score: 1 });
    expect(spacePlan("balls", "balls/ballinball/3")).toMatchObject({ score: 1 });
    expect(spacePlan("balls", "balls/ballincub/3")).toMatchObject({ score: 0.5 });
    expect(spacePlan("balls", "balls/cubinball/3")).toMatchObject({ score: 2 });
  });

  it("converts a database at start-up, exactly, in one transaction that marks the epoch", () => {
    const { path, db } = oldDatabase();
    const before = unitsDigest(db);
    expect(unitsEpoch(db)).toBe(0);
    const logs: string[] = [];
    const store = new SqliteStore(path, { log: (m) => logs.push(m) });
    expect(store.unitsReport).toMatchObject({
      action: "forward",
      submissions: { "n=0 m=0": 1, "n=0 m=>=3": 4, "n=>=3 m=0": 1 },
      archived: 2,
      unreadable: 0,
    });
    expect(logs[0]).toMatch(/^units: converted to diameter units/);
    expect(unitsEpoch(db)).toBe(2);
    expect(unitsDigest(db)).not.toBe(before);

    // 2D: disks in a circle keep their score, their pieces halve; theta is untouched
    const [circle] = sub(db, 0, 0, 2);
    expect(circle.score).toBe(3 + A);
    expect(readPieces(circle.pieces)).toEqual([
      { x: 0, y: 0, theta: 0 },
      { x: (2 + A) / 2, y: ((2 + A) * B + 1) / 2, theta: A },
    ]);
    // disks in a square: everything halves, the pending entry's literature value and certificate with it
    const [square] = sub(db, 0, 4, 3);
    expect(square.score).toBe((5 + B) / 2);
    expect(square.literature_value).toBe(2.75);
    expect(JSON.parse(square.strict_check)).toEqual({ ok: true, certifiedSize: 2.625, eps: 1e-8 });
    expect(readPieces(square.pieces).map((p) => p.x)).toEqual([0, 1, 2]);
    // polygons in a circle: the score doubles, the pieces stay
    const [polygon] = sub(db, 4, 0, 2);
    expect(polygon.score).toBe(2 * (2 + A));
    expect(readPieces(polygon.pieces).map((p) => p.x)).toEqual([0, 1.5]);
    // polygons in a polygon: not touched
    expect(sub(db, 4, 4, 2)[0].score).toBe(2 + B);
    // the JSON-text entry came out as a BLOB, halved
    const [text] = sub(db, 0, 6, 1);
    expect(text.pieces).toBeInstanceOf(Uint8Array);
    expect(readPieces(text.pieces)).toEqual([{ x: 0.5, y: 1, theta: 0 }]);
    // leader order of a problem survives, and the store reads it
    const [lead, worse] = sub(db, 0, 5, 2);
    expect(worse.score).toBeLessThan(lead.score);
    expect(readPieces(lead.pieces).map((p) => p.x)).toEqual([0, 1.5]);

    // the spaces
    expect(entry(db, "torus/sq/0/2")).toEqual({ score: 2, config: { lattice: { L: 2 }, poses: [[0, 0, 0], [A / 2, B / 2, 1]] } });
    expect(entry(db, "torus/free/0/2")!.config.lattice).toEqual({ b1: [1.5, 0], b2: [0.5, 1.5] });
    expect(entry(db, "torus/sq/4/2")).toEqual({ score: 5, config: { lattice: { L: 5 }, poses: [[0, 0, 0], [A, B, 1]] } });
    expect(entry(db, "sphere/0/3")).toMatchObject({ score: 0.75, config: { rho: 0.75 } });
    expect(entry(db, "sphere/4/3")).toMatchObject({ score: 1.25 });
    expect(entry(db, "surface/cube/fold/0/3")!.config).toEqual({ s: (2 + A) / 2, pieces: [{ face: 1, x: A / 2, y: B / 2, theta: 2 }] });
    expect(entry(db, "boundary/tesseract/ball/3")).toEqual({ score: 3, config: { s: 3, pieces: [{ cell: 2, u: [A / 2, B / 2, 0.5] }] } });
    expect(entry(db, "boundary/tesseract/cube/3")!.score).toBe(7);
    // balls in a ball: the diameter is the old radius; in a cube: halves; cubes in a ball: the diameter doubles
    expect(entry(db, "balls/ballinball/3")).toEqual({ score: 5, config: { s: 5, pieces: [[A / 2, B / 2, 0.5]] } });
    expect(entry(db, "balls/ballincub/3")).toEqual({ score: 3, config: { s: 3, pieces: [[A / 2, B / 2, 0.5]] } });
    expect(entry(db, "balls/cubinball/2")).toEqual({ score: 2.8, config: { s: 2.8, pieces: [[0.6, 0, 0, 1, 0, 0, 0]] } });
    // curved: flat disks convert, polygons in a circle double at any K, polygons elsewhere stay
    expect(entry(db, "curved/0/0/4/2")!.config).toEqual({ size: 2.5, pieces: [{ x: A / 2, y: B / 2, theta: 1 }] });
    expect(entry(db, "curved/0/0/0/2")).toMatchObject({ score: 3, config: { size: 3 } });
    expect(entry(db, "curved/-1/3/0/2")).toMatchObject({ score: 2.5, config: { size: 2.5, pieces: [{ x: A, y: B, theta: 1 }] } });
    expect(entry(db, "curved/1/3/4/2")).toMatchObject({ score: 2 });
    // and the disks at K = +-1, which have no equivalent at the same K, are set aside rather than served
    expect(entry(db, "curved/1/0/0/2")).toBeNull();
    expect(entry(db, "curved/-1/0/4/2")).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS c FROM space_entries_units_archive").get() as any).c).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS c FROM space_entries").get() as any).c).toBe(15);
  });

  it("runs once: a second start and a second call change nothing", () => {
    const { path, db } = oldDatabase();
    new SqliteStore(path);
    const once = unitsDigest(db);
    const again = new SqliteStore(path);
    expect(again.unitsReport).toBeNull();
    expect(migrateUnits(db).action).toBe("none");
    expect(unitsDigest(db)).toBe(once);
    expect(unitsEpoch(db)).toBe(2);
  });

  it("reverses exactly: every row, bit for bit, and the archived entries come back", () => {
    const { path, db } = oldDatabase();
    const original = unitsDigest(db);
    new SqliteStore(path);
    expect(migrateUnits(db, true)).toMatchObject({ action: "reverse", restored: 2 });
    expect(unitsEpoch(db)).toBe(1);
    // the row that held JSON text came back as a BLOB: compare it by value, the rest by digest
    const text = sub(db, 0, 6, 1)[0];
    expect(readPieces(text.pieces)).toEqual([{ x: 1, y: 2, theta: 0 }]);
    db.prepare("UPDATE submissions SET pieces = ? WHERE id = ?").run(JSON.stringify([{ x: 1, y: 2, theta: 0 }]), text.id);
    expect(unitsDigest(db)).toBe(original);
    expect(entry(db, "curved/1/0/0/2")).toMatchObject({ score: 2 });
    // and forward again
    expect(migrateUnits(db).action).toBe("forward");
    expect(unitsEpoch(db)).toBe(2);
    expect(migrateUnits(db, true).action).toBe("reverse");
    expect(migrateUnits(db, true).action).toBe("none");
  });

  it("rolls back whole when the conversion fails midway, leaving the old units and no marker", () => {
    const { db } = oldDatabase();
    db.exec("INSERT INTO space_entries (space, problem, score, name, agent_note, created_at, config) VALUES ('torus', 'torus/sq/0/3', 1, 'x', '', 'now', '{\"lattice\":{\"L\":1},\"poses\":[]}')");
    const before = unitsDigest(db);
    db.exec("CREATE TRIGGER boom BEFORE UPDATE ON space_entries BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => migrateUnits(db)).toThrow(/boom/);
    expect(unitsEpoch(db)).toBe(0);
    expect(unitsDigest(db)).toBe(before);
    expect(() => applyUnits(db, false)).toThrow(); // still not converted: it tries again
  });

  it("marks a new database as converted and leaves it alone", () => {
    const path = tmp();
    const store = new SqliteStore(path);
    expect(store.unitsReport).toBeNull();
    expect(unitsEpoch(new DatabaseSync(path))).toBe(2);
  });
});
