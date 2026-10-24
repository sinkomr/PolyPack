import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCORE_TIE } from "@polypack/geometry";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "../src/sqlite-store";

// The pieces of an entry can be tens of kilobytes and sit in the table before verification and
// the later columns, so a query that reads those from the table walks every row's pieces. These
// queries must be answered from the listing index alone.
describe("SqliteStore query plans", () => {
  it("finds leaders, prunes, ranks and lists from the covering index", async () => {
    const store = new SqliteStore(":memory:");
    const db = (store as unknown as { db: DatabaseSync }).db;
    const plans: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (/^\s*(WITH|SELECT)/i.test(sql) && /FROM submissions/.test(sql) && !/SELECT \*/.test(sql))
        plans.push(
          (prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
            .map((r) => r.detail)
            .filter((d) => /^SEARCH|^SCAN/.test(d) && !/rowid=\?|best/.test(d))
            .join("; "),
        );
      return prepare(sql);
    }) as typeof db.prepare;
    const add = (score: number, verification: "none" | "pending") =>
      store.insert({
        N: 4,
        M: 4,
        P: 1,
        score,
        name: "a",
        agent_note: "",
        found_with: "hand",
        method: null,
        method_params: null,
        seed: null,
        budget: null,
        software: null,
        pieces: [{ x: 0, y: 0, theta: 0 }],
        container_phi: 0,
        created_at: "2026-10-18T00:00:00Z",
        verification,
        literature_value: null,
        strict_check: null,
      });
    await add(1, "none");
    await store.leader(4, 4, 1);
    await store.prune(4, 4, 1);
    await store.rank(4, 4, 1, 1);
    await store.bestPerP(4, 4);
    await store.bestPerP(4, 4, true);
    await store.leaders();
    await store.pairs();
    // the prune of a problem led by a pending claim, which keeps the best entry that is not
    // pending, and the prunes after a review and a removal
    const claim = await add(0.5, "pending");
    expect(await store.prune(4, 4, 1)).toEqual([]);
    await store.review(claim, "confirmed");
    await store.remove(claim);
    expect(plans.length).toBeGreaterThanOrEqual(5);
    for (const plan of plans) {
      for (const step of plan.split("; ")) expect(step).toMatch(/USING COVERING INDEX submissions_listing/);
    }
  });

  it("walks the table by id for the pieces migration, without reading the pieces of rows it skips", () => {
    const store = new SqliteStore(":memory:");
    const db = (store as unknown as { db: DatabaseSync }).db;
    const seen: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (/WHERE id > \?/.test(sql))
        seen.push(
          ...(prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail),
          // OP_Column with p5 = 0x80 (typeof) or 0xc0 (octet_length) does not load the value
          ...(prepare(`EXPLAIN ${sql}`).all() as { opcode: string; p2: number; p5: number }[])
            .filter((r) => r.opcode === "Column" && r.p2 === 8)
            .map((r) => `pieces column p5=${r.p5}`),
        );
      return prepare(sql);
    }) as typeof db.prepare;
    store.migratePieces(10);
    expect(seen).toEqual([
      expect.stringMatching(/^SEARCH submissions USING INTEGER PRIMARY KEY \(rowid>\?\)$/),
      "pieces column p5=128",
      "pieces column p5=192",
    ]);
  });

  it("replaces the narrower index of an older database", () => {
    const path = join(mkdtempSync(join(tmpdir(), "polypack-store-")), "old.sqlite");
    new SqliteStore(path);
    const old = new DatabaseSync(path);
    old.exec("DROP INDEX submissions_listing; CREATE INDEX submissions_problem ON submissions (n, m, p, score, id);");
    old.close();
    const db = (new SqliteStore(path) as unknown as { db: DatabaseSync }).db;
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(names).toContain("submissions_listing");
    expect(names).not.toContain("submissions_problem");
  });
});

type Pose = { x: number; y: number; theta: number };
type OldRow = { n?: number; m?: number; p: number; score: number; verification?: string; pieces: Pose[] | string };

/**
 * A database as the server wrote it before pieces became BLOBs: the deployed schema with the
 * added columns, the tallies and the listing index, no meta table, and pieces as JSON text.
 */
function oldDatabase(rows: OldRow[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "polypack-pieces-")), "old.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL, m INTEGER NOT NULL,
      p INTEGER NOT NULL, score REAL NOT NULL, name TEXT NOT NULL, agent TEXT NOT NULL DEFAULT '',
      agent_note TEXT NOT NULL, pieces TEXT NOT NULL, container_phi REAL NOT NULL, created_at TEXT NOT NULL,
      verification TEXT NOT NULL DEFAULT 'none', literature_value REAL, strict_check TEXT, found_with TEXT,
      method TEXT, method_params TEXT, seed INTEGER, budget TEXT, software TEXT);
    CREATE INDEX submissions_verification ON submissions (verification);
    CREATE INDEX submissions_listing
      ON submissions (n, m, p, score, id, verification, name, found_with, agent_note, created_at);
    CREATE TABLE tallies (n INTEGER NOT NULL, m INTEGER NOT NULL, p INTEGER NOT NULL, accepted INTEGER NOT NULL,
      PRIMARY KEY (n, m, p));`);
  const add = db.prepare(
    `INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at, verification,
       found_with, method, seed)
     VALUES (?, ?, ?, ?, ?, '', ?, 0, '2026-10-12T00:00:00Z', ?, 'optimizer', 'asc', 7)`,
  );
  rows.forEach((r, i) =>
    add.run(
      r.n ?? 4,
      r.m ?? 4,
      r.p,
      r.score,
      `row ${i + 1}`,
      typeof r.pieces === "string" ? r.pieces : JSON.stringify(r.pieces),
      r.verification ?? "none",
    ),
  );
  db.exec("INSERT INTO tallies SELECT n, m, p, COUNT(*) FROM submissions GROUP BY n, m, p");
  db.close();
  return path;
}

/** P poses with full-precision coordinates, different for every seed. */
const poses = (P: number, seed: number): Pose[] =>
  Array.from({ length: P }, (_, i) => ({
    x: Math.sin(seed * 7919 + i) * 1000,
    y: Math.cos(seed * 104729 + i) / 3,
    theta: (seed + i) * 0.1234567890123,
  }));

/** How each remaining row holds its pieces, read by a connection of its own. */
function forms(path: string): Record<number, "blob" | "json"> {
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db.prepare("SELECT id, typeof(pieces) AS kind FROM submissions ORDER BY id").all() as {
    id: number;
    kind: string;
  }[];
  db.close();
  return Object.fromEntries(rows.map((r) => [r.id, r.kind === "blob" ? "blob" : "json"]));
}

function read(path: string, sql: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  const r = db.prepare(sql).get() as Record<string, number> | undefined;
  db.close();
  return r ? (Object.values(r)[0] ?? 0) : 0;
}
const cursorOf = (path: string) => read(path, "SELECT value FROM meta WHERE key = 'pieces_cursor'");

describe("pieces as BLOBs, and the migration of older rows", () => {
  // ids follow the order of this list
  const rows: OldRow[] = [
    // 1-3: P = 2, three ordinary entries: only the best (2) is kept
    { p: 2, score: 2.2, pieces: poses(2, 1) },
    { p: 2, score: 2.0, pieces: poses(2, 2) },
    { p: 2, score: 2.1, pieces: poses(2, 3) },
    // 4-6: P = 3, a pending claim (5) leads: the best ordinary entry (4) is kept behind it
    { p: 3, score: 6.0, pieces: poses(3, 4) },
    { p: 3, score: 3.0, verification: "pending", pieces: poses(3, 5) },
    { p: 3, score: 6.5, pieces: poses(3, 6) },
    // 7-8: P = 5, a confirmed entry and a rejected one: the rejected one goes
    { p: 5, score: 5.0, verification: "confirmed", pieces: poses(5, 7) },
    { p: 5, score: 4.0, verification: "rejected", pieces: poses(5, 8) },
    // 9-11: P = 6, near-ties: 9 leads, as the earliest within the tolerance of the smallest
    // score (11's), although it is not first by score
    { p: 6, score: 6, pieces: poses(6, 9) },
    { p: 6, score: 6 * (1 + 0.3 * SCORE_TIE), pieces: poses(6, 10) },
    { p: 6, score: 6 * (1 - 0.6 * SCORE_TIE), pieces: poses(6, 11) },
    // 12: P = 7, a leader whose text is not a list of poses is left as it is
    { p: 7, score: 7, pieces: '[{"x":1,"y":2}]' },
    // 13: P = 8, nothing but a rejected entry
    { p: 8, score: 8, verification: "rejected", pieces: poses(8, 13) },
    // 14-16: P = 9, -0 (which JSON wrote as 0) and the coordinate limit
    { p: 9, score: 9, pieces: [{ x: -0, y: 1e6, theta: -1e6 }, ...poses(8, 14)] },
    { p: 9, score: 9.5, pieces: poses(9, 15) },
    { p: 9, score: 9.7, pieces: poses(9, 16) },
    // 17-46: three circle entries for each P from 10 to 19, so that the walk takes several steps;
    // the first of each (ids 17-26) is the best
    ...Array.from({ length: 30 }, (_, i) => ({
      n: 0,
      m: 0,
      p: 10 + (i % 10),
      score: 20 + i,
      pieces: poses(4, 17 + i),
    })),
  ];
  const kept: Record<number, "blob" | "json"> = { 2: "blob", 4: "blob", 5: "blob", 7: "blob", 9: "blob", 12: "json" };
  kept[14] = "blob";
  for (let id = 17; id <= 26; id++) kept[id] = "blob";

  it("reads JSON text and BLOBs side by side, before and during the migration", async () => {
    const path = oldDatabase(rows);
    const store = new SqliteStore(path);
    expect(store.piecesMigrated()).toBe(false);
    // the older rows read as before
    expect((await store.get(2))!.pieces).toEqual(poses(2, 2));
    // a new row is a BLOB in the same column
    const fresh = [{ x: -0, y: 0.1, theta: 1e6 }, ...poses(3, 99)];
    const id = await store.insert({
      N: 4,
      M: 4,
      P: 4,
      score: 4,
      name: "new",
      agent_note: "",
      found_with: "hand",
      method: null,
      method_params: null,
      seed: null,
      budget: null,
      software: null,
      pieces: fresh,
      container_phi: 0,
      created_at: "2026-10-18T00:00:00Z",
      verification: "pending",
      literature_value: 5,
      strict_check: null,
    });
    expect(forms(path)[id]).toBe("blob");
    expect(Object.is((await store.get(id))!.pieces[0].x, -0)).toBe(true);
    const many = await store.getMany([1, 2, 5, id]);
    expect(new Map(many.map((s) => [s.id, s.pieces]))).toEqual(
      new Map([
        [1, poses(2, 1)],
        [2, poses(2, 2)],
        [5, poses(3, 5)],
        [id, fresh],
      ]),
    );
    expect((await store.pending()).map((s) => [s.id, s.pieces])).toEqual([
      [id, fresh],
      [5, poses(3, 5)],
    ]);
    // half-way through, both forms are still read
    store.migratePieces(5);
    expect(forms(path)[2]).toBe("blob");
    expect(forms(path)[7]).toBe("json");
    expect((await store.getMany([2, 7])).map((s) => s.pieces)).toEqual([poses(2, 2), poses(5, 7)]);
  });

  it("converts and deletes in small steps, survives an interruption and resumes where it stopped", async () => {
    const path = oldDatabase(rows);
    const before = new Map<number, Pose[]>();
    let store = new SqliteStore(path);
    for (let id = 1; id <= rows.length; id++) before.set(id, (await store.get(id))!.pieces);
    const leaders = Object.fromEntries((await store.bestPerP(4, 4)).map((e) => [e.P, e.id]));
    expect(leaders).toEqual({ 2: 2, 3: 5, 5: 7, 6: 9, 7: 12, 9: 14 });

    // rows 1-4: problems 2 and 3 are pruned whole (1, 3 and 6 go), and 2 and 4 are converted
    const first = store.migratePieces(4);
    expect(first).toMatchObject({ done: false, cursor: 4, rows: 4, converted: 2, deleted: 3, unreadable: 0 });
    expect(first.bytesAfter).toBe(5 * 24);
    expect(first.bytesBefore).toBeGreaterThan(2.5 * first.bytesAfter);
    expect(() => store.migratePieces(0)).toThrow(RangeError);

    // A step cut short in the middle (a crash, a restart) changes nothing: its transaction is
    // rolled back, deletions included, the cursor stays, and the next start does it again.
    const db = (store as unknown as { db: DatabaseSync }).db;
    const prepare = db.prepare.bind(db);
    let writes = 0;
    db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (!/^UPDATE submissions SET pieces = \?/.test(sql)) return statement;
      return {
        run: (...args: unknown[]) => {
          if (++writes === 2) throw new Error("killed");
          return (statement.run as (...a: unknown[]) => unknown)(...args);
        },
      };
    }) as typeof db.prepare;
    const snapshot = forms(path);
    // rows 5, 7, 8, 9: 5 is converted, then 8 deleted with the prune of problem 5, then 7 fails
    expect(() => store.migratePieces(4)).toThrow("killed");
    expect(writes).toBe(2);
    expect(forms(path)).toEqual(snapshot);
    expect(snapshot[8]).toBe("json");
    expect(cursorOf(path)).toBe(4);

    // a new process, which stops again after two steps; the cursor was kept with each step
    store = new SqliteStore(path);
    const steps = [];
    for (let i = 0; i < 100; i++) {
      const step = store.migratePieces(7);
      steps.push(step);
      if (step.done) break;
      if (i === 1) store = new SqliteStore(path);
    }
    // rows deleted further on are not visited: after 26, nothing is left
    expect(steps.map((s) => s.cursor)).toEqual([12, 19, 26, 26]);
    expect(steps.at(-1)!.done).toBe(true);
    expect(steps.reduce((n, s) => n + s.unreadable, 0)).toBe(1);
    expect(first.deleted + steps.reduce((n, s) => n + s.deleted, 0)).toBe(rows.length - Object.keys(kept).length);
    expect(store.piecesMigrated()).toBe(true);

    expect(forms(path)).toEqual(kept);
    // every kept arrangement reads back exactly as the JSON held it, and the leaders are the same
    for (const id of Object.keys(kept).map(Number))
      expect([id, (await store.get(id))!.pieces]).toEqual([id, before.get(id)]);
    expect(Object.fromEntries((await store.bestPerP(4, 4)).map((e) => [e.P, e.id]))).toEqual(leaders);
    // -0 was lost already in the JSON; the coordinate limit is kept
    expect((await store.get(14))!.pieces[0]).toEqual({ x: 0, y: 1e6, theta: -1e6 });
    // the counts of submissions received are kept
    expect(await store.count(4, 4, 2)).toBe(3);

    // complete: another start does nothing and reads nothing again
    const again = new SqliteStore(path);
    expect(again.piecesMigrated()).toBe(true);
    const log: string[] = [];
    await again.startPiecesMigration({ batch: 100, pauseMs: 0, log: (m) => log.push(m) }).finished;
    expect(log).toEqual([]);
  });

  it("runs in the background with a pause between steps, logs sparingly, and can be stopped", async () => {
    const path = oldDatabase(rows);
    const log: string[] = [];
    const store = new SqliteStore(path);
    // one row per step, stopped after a few
    const stopped = store.startPiecesMigration({ batch: 1, pauseMs: 5, log: (m) => log.push(m) });
    await new Promise((r) => setTimeout(r, 50));
    stopped.stop();
    await stopped.finished;
    expect(log).toEqual([`[pieces] migration starting after row 0 of ${rows.length}: 1 rows every 5 ms`]);
    expect(store.piecesMigrated()).toBe(false);
    const cursor = cursorOf(path);
    expect(cursor).toBeGreaterThan(0);
    expect(cursor).toBeLessThan(26);
    await new Promise((r) => setTimeout(r, 30));
    expect(cursorOf(path)).toBe(cursor);

    log.length = 0;
    const last = read(path, "SELECT MAX(id) FROM submissions");
    const run = new SqliteStore(path).startPiecesMigration({
      batch: 3,
      pauseMs: 0,
      log: (m) => log.push(m),
      logEveryMs: 60_000,
    });
    await run.finished;
    expect(store.piecesMigrated()).toBe(true);
    expect(log).toHaveLength(2);
    expect(log[0]).toBe(`[pieces] migration starting after row ${cursor} of ${last}: 3 rows every 0 ms`);
    expect(log[1]).toMatch(/^\[pieces\] migration complete: \d+ converted .*, \d+ deleted, [01] left as text; /);
    expect(forms(path)).toEqual(kept);

    // switched off
    const off = new SqliteStore(oldDatabase(rows));
    log.length = 0;
    await off.startPiecesMigration({ batch: 0, pauseMs: 0, log: (m) => log.push(m) }).finished;
    expect(off.piecesMigrated()).toBe(false);
    expect(log).toEqual([]);
  });

  it("keeps the leader alone, and the best reviewed entry behind a pending one until it is reviewed", async () => {
    const store = new SqliteStore(":memory:");
    const add = (P: number, score: number, verification: "none" | "pending", seed: number) =>
      store.insert({
        N: 4,
        M: 4,
        P,
        score,
        name: `s${seed}`,
        agent_note: "",
        found_with: "hand",
        method: null,
        method_params: null,
        seed: null,
        budget: null,
        software: null,
        pieces: poses(P, seed),
        container_phi: 0,
        created_at: "2026-10-18T00:00:00Z",
        verification,
        literature_value: null,
        strict_check: null,
      });
    const leaderOf = async (P: number) => (await store.leader(4, 4, P))?.id ?? null;
    // a pending leader, a second claim, the best reviewed entry and a worse one
    const claim = await add(3, 1, "pending", 1);
    const other = await add(3, 2, "pending", 2);
    const plain = await add(3, 3, "none", 3);
    const worse = await add(3, 4, "none", 4);
    expect(await store.prune(4, 4, 3)).toEqual([other, worse]);
    expect(await store.get(other)).toBeNull();
    expect((await store.get(plain))!.pieces).toEqual(poses(3, 3));

    // rejected: the claim is deleted, and the entry behind it leads again
    expect(await store.review(claim, "rejected")).toBe(true);
    expect(await store.get(claim)).toBeNull();
    expect(await leaderOf(3)).toBe(plain);
    expect(await store.review(claim, "confirmed")).toBe(false);
    // only pending or confirmed entries are reviewed
    expect(await store.review(plain, "confirmed")).toBe(false);

    // confirmed: the claim stays alone
    const next = await add(3, 1.5, "pending", 5);
    expect(await store.prune(4, 4, 3)).toEqual([]);
    expect(await store.review(next, "confirmed")).toBe(true);
    expect(await store.get(plain)).toBeNull();
    expect(await leaderOf(3)).toBe(next);
    expect((await store.get(next))!.verification).toBe("confirmed");
    // a confirmed entry can still be rejected, which leaves the problem without an entry
    expect(await store.review(next, "rejected")).toBe(true);
    expect(await leaderOf(3)).toBeNull();
    expect(await store.count(4, 4, 3)).toBe(5);

    // removing a pending leader leaves the entry behind it; removing that one, nothing
    const lone = await add(5, 5, "none", 6);
    const claim5 = await add(5, 4, "pending", 7);
    expect(await store.prune(4, 4, 5)).toEqual([]);
    expect(await store.remove(claim5)).toBe(true);
    expect(await store.get(claim5)).toBeNull();
    expect(await leaderOf(5)).toBe(lone);
    expect(await store.remove(lone)).toBe(true);
    expect(await store.remove(lone)).toBe(false);
    expect(await leaderOf(5)).toBeNull();
    expect(await store.bestPerP(4, 4)).toEqual([]);
  });

  it("marks a new database as migrated, since it never held JSON text", () => {
    expect(new SqliteStore(":memory:").piecesMigrated()).toBe(true);
    const path = join(mkdtempSync(join(tmpdir(), "polypack-new-")), "new.sqlite");
    new SqliteStore(path);
    expect(new SqliteStore(path).piecesMigrated()).toBe(true);
  });
});

describe("a submission", () => {
  const entry = (score: number) => ({
    N: 4,
    M: 4,
    P: 1,
    score,
    name: "a",
    agent_note: "",
    found_with: "hand" as const,
    method: null,
    method_params: null,
    seed: null,
    budget: null,
    software: null,
    pieces: [{ x: 0, y: 0, theta: 0 }],
    container_phi: 0,
    created_at: "2026-10-21T00:00:00Z",
    verification: "none" as const,
    literature_value: null,
    strict_check: null,
  });

  it("is stored, counted, ranked and pruned in one transaction, one commit", async () => {
    const store = new SqliteStore(":memory:");
    const db = (store as unknown as { db: DatabaseSync }).db;
    const statements: string[] = [];
    const exec = db.exec.bind(db);
    db.exec = ((sql: string) => {
      statements.push(sql);
      return exec(sql);
    }) as typeof db.exec;
    const first = await store.submit(entry(2));
    expect(first).toMatchObject({ before: null, position: 1, kept: true });
    expect(first.leader?.id).toBe(first.id);
    const worse = await store.submit(entry(3));
    expect(worse).toMatchObject({ position: 2, kept: false });
    expect(worse.before?.id).toBe(first.id);
    expect(worse.leader?.id).toBe(first.id);
    const better = await store.submit(entry(1));
    expect(better).toMatchObject({ position: 1, kept: true });
    expect(better.before?.id).toBe(first.id);
    expect(better.leader?.id).toBe(better.id);
    expect(statements).toEqual(Array(3).fill(["BEGIN IMMEDIATE", "COMMIT"]).flat());
    expect(await store.count(4, 4, 1)).toBe(3);
    // the leader it overtook was deleted in the same transaction
    expect(await store.get(first.id)).toBeNull();
  });

  it("leaves nothing behind when it fails part way", async () => {
    const store = new SqliteStore(":memory:");
    await store.submit(entry(2));
    const db = (store as unknown as { db: DatabaseSync }).db;
    // the prune's delete fails after the insert and the count went in
    db.exec("CREATE TRIGGER fail BEFORE DELETE ON submissions BEGIN SELECT RAISE(ABORT, 'no'); END");
    await expect(store.submit(entry(1))).rejects.toThrow("no");
    db.exec("DROP TRIGGER fail");
    expect(await store.count(4, 4, 1)).toBe(1);
    expect((await store.leader(4, 4, 1))?.score).toBe(2);
    // and the store goes on
    expect((await store.submit(entry(1))).kept).toBe(true);
  });
});
