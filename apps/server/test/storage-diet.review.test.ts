// Independent review of the storage diet (pieces as BLOBs, only the leader kept, background
// migration). Adversarial: a reference model of the keep rule is compared with the store after
// every operation, including operations interleaved with migration steps on an older database.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCORE_TIE } from "@polypack/geometry";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { SqliteStore } from "../src/sqlite-store";

type V = "none" | "pending" | "confirmed" | "rejected";
type Pose = { x: number; y: number; theta: number };
/** One row as the reference model sees it. */
type E = { id: number; p: number; score: number; v: V; pieces: Pose[] };

// near-ties around 1 (see SCORE_TIE), and clear gaps
const SCORES = [1, 1 + 0.4 * SCORE_TIE, 1 + 0.9 * SCORE_TIE, 1 + 1.5 * SCORE_TIE, 1 - 0.5 * SCORE_TIE, 2, 0.5, 3];

/** The documented rule: earliest listed entry within SCORE_TIE of the smallest listed score. */
function leaderOf(es: E[]): E | null {
  const listed = es.filter((e) => e.v !== "rejected");
  if (!listed.length) return null;
  const lo = Math.min(...listed.map((e) => e.score));
  return listed.filter((e) => e.score <= lo * (1 + SCORE_TIE)).sort((a, b) => a.id - b.id)[0];
}
/** What a problem keeps: its leader, and behind a pending leader the leader among the others. */
function keepers(es: E[]): E[] {
  const L = leaderOf(es);
  if (!L) return [];
  if (L.v !== "pending") return [L];
  const R = leaderOf(es.filter((e) => e.v !== "pending"));
  return R ? [L, R] : [L];
}

const posesFor = (id: number, P: number): Pose[] =>
  Array.from({ length: P }, (_, i) => ({
    x: Math.sin(id * 7919 + i) * 1000,
    y: Math.cos(id * 104729 + i) / 3,
    theta: (id + i) * 0.1234567890123,
  }));

const newRow = (P: number, score: number, v: V, id: number) => ({
  N: 4,
  M: 4,
  P,
  score,
  name: `e${id}`,
  agent_note: "",
  found_with: "hand" as const,
  method: null,
  method_params: null,
  seed: null,
  budget: null,
  software: null,
  pieces: posesFor(id, P),
  container_phi: 0,
  created_at: "2026-10-18T00:00:00Z",
  verification: v as "none" | "pending",
  literature_value: null,
  strict_check: null,
});

function rawRows(store: SqliteStore): { id: number; p: number; kind: string }[] {
  const db = (store as unknown as { db: DatabaseSync }).db;
  return db.prepare("SELECT id, p, typeof(pieces) AS kind FROM submissions ORDER BY id").all() as never;
}

describe("review: the keep rule on every live path", () => {
  // An operation on problem P = 1..3: a submission (as the app does it: leader, insert, leader,
  // prune), a review or a removal of the k-th row the model holds for that problem.
  const op = fc.oneof(
    fc.record({
      kind: fc.constant("submit" as const),
      p: fc.integer({ min: 1, max: 3 }),
      score: fc.constantFrom(...SCORES),
      v: fc.constantFrom<V>("none", "pending"),
    }),
    fc.record({
      kind: fc.constantFrom("confirm" as const, "reject" as const, "remove" as const),
      p: fc.integer({ min: 1, max: 3 }),
      k: fc.integer({ min: 0, max: 2 }),
    }),
  );

  it("matches the reference model after every operation, never changes a leader by pruning, and keeps the fallback", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 40 }), async (ops) => {
        const store = new SqliteStore(":memory:");
        const model = new Map<number, E[]>([
          [1, []],
          [2, []],
          [3, []],
        ]);
        let next = 1;
        for (const o of ops) {
          const rows = model.get(o.p)!;
          if (o.kind === "submit") {
            const id = await store.insert(newRow(o.p, o.score, o.v, next));
            expect(id).toBe(next);
            const all = [...rows, { id, p: o.p, score: o.score, v: o.v, pieces: posesFor(id, o.p) }];
            next++;
            const before = await store.leader(4, 4, o.p);
            expect(before?.id ?? null).toBe(leaderOf(all)?.id ?? null);
            const deleted = await store.prune(4, 4, o.p);
            const kept = keepers(all);
            model.set(o.p, kept);
            expect(deleted.sort((a, b) => a - b)).toEqual(
              all
                .filter((e) => !kept.includes(e))
                .map((e) => e.id)
                .sort((a, b) => a - b),
            );
            // pruning never changes who leads
            expect((await store.leader(4, 4, o.p))?.id ?? null).toBe(before?.id ?? null);
            // a pending leader keeps a fallback whenever an entry that is not pending was there
            const L = leaderOf(kept);
            if (L?.v === "pending" && all.some((e) => e.v !== "pending")) expect(kept).toHaveLength(2);
          } else {
            const target = rows[o.k];
            const id = target?.id ?? 999_999;
            const leaderBefore = leaderOf(rows);
            let ok: boolean;
            if (o.kind === "remove") ok = await store.remove(id);
            else ok = await store.review(id, o.kind === "confirm" ? "confirmed" : "rejected");
            const applies =
              !!target && (o.kind === "remove" || target.v === "pending" || target.v === "confirmed");
            expect(ok).toBe(applies);
            if (applies) {
              const rest =
                o.kind === "confirm"
                  ? rows.map((e) => (e === target ? { ...e, v: "confirmed" as V } : e))
                  : rows.filter((e) => e !== target);
              const kept = keepers(rest);
              model.set(o.p, kept);
              // the leader only changes when it is the entry taken away
              if (target !== leaderBefore) expect(leaderOf(kept)?.id).toBe(leaderBefore?.id);
            }
          }
          // the store holds exactly what the model holds, pieces included
          const stored = rawRows(store);
          const want = [...model.values()].flat().sort((a, b) => a.id - b.id);
          expect(stored.map((r) => [r.id, r.kind])).toEqual(want.map((e) => [e.id, "blob"]));
          for (const e of want) expect((await store.get(e.id))!.pieces).toEqual(e.pieces);
        }
      }),
      { numRuns: 300 },
    );
  });
});

/** A database as the deployed (older) server wrote it: JSON pieces, no meta table. */
function oldDatabase(rows: { p: number; score: number; v: V; pieces: Pose[] | string }[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "polypack-review-")), "old.sqlite");
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
    `INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at, verification)
     VALUES (4, 4, ?, ?, 'old', '', ?, 0, '2026-10-12T00:00:00Z', ?)`,
  );
  for (const r of rows) add.run(r.p, r.score, typeof r.pieces === "string" ? r.pieces : JSON.stringify(r.pieces), r.v);
  db.exec("INSERT INTO tallies SELECT n, m, p, COUNT(*) FROM submissions GROUP BY n, m, p");
  db.close();
  return path;
}

describe("review: the migration interleaved with live operations", () => {
  // up to three rows per problem, as the old code kept them, with every verification state
  const oldRow = fc.record({
    p: fc.integer({ min: 1, max: 6 }),
    score: fc.constantFrom(...SCORES),
    v: fc.constantFrom<V>("none", "none", "pending", "confirmed", "rejected"),
  });
  const action = fc.oneof(
    fc.record({ kind: fc.constant("step" as const), batch: fc.integer({ min: 1, max: 4 }) }),
    fc.record({
      kind: fc.constant("submit" as const),
      p: fc.integer({ min: 1, max: 6 }),
      score: fc.constantFrom(...SCORES),
      v: fc.constantFrom<V>("none", "pending"),
    }),
    fc.record({
      kind: fc.constantFrom("confirm" as const, "reject" as const, "remove" as const),
      p: fc.integer({ min: 1, max: 6 }),
      k: fc.integer({ min: 0, max: 2 }),
    }),
  );

  it("ends with every row a BLOB equal to its old JSON, and every problem kept by the rule", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(oldRow, { maxLength: 18 }), fc.array(action, { maxLength: 30 }), async (old, acts) => {
        // at most three rows per problem, as the old code left them
        const perP = new Map<number, number>();
        const rows = old.filter((r) => (perP.set(r.p, (perP.get(r.p) ?? 0) + 1).get(r.p) ?? 0) <= 3);
        const path = oldDatabase(rows.map((r, i) => ({ ...r, pieces: posesFor(i + 1, r.p) })));
        // the model: every physical row per problem, rejected ones included until a prune
        const model = new Map<number, E[]>();
        rows.forEach((r, i) =>
          model.set(r.p, [...(model.get(r.p) ?? []), { id: i + 1, p: r.p, score: r.score, v: r.v, pieces: posesFor(i + 1, r.p) }]),
        );
        const prune = (p: number) => model.set(p, keepers(model.get(p) ?? []));
        const store = new SqliteStore(path);
        let cursor = 0;
        let next = rows.length + 1;
        const check = async () => {
          const want = [...model.values()].flat().sort((a, b) => a.id - b.id);
          const stored = rawRows(store);
          expect(stored.map((r) => r.id)).toEqual(want.map((e) => e.id));
          // rows the cursor has passed are BLOBs
          for (const r of stored) if (r.id <= cursor) expect([r.id, r.kind]).toEqual([r.id, "blob"]);
          for (const e of want) expect((await store.get(e.id))!.pieces).toEqual(e.pieces);
        };
        const allIds = () => [...model.values()].flat().map((e) => e.id);
        for (const a of [...acts, ...Array.from({ length: 40 }, () => ({ kind: "step" as const, batch: 3 }))]) {
          if (a.kind === "step") {
            const step = store.migratePieces(a.batch);
            // the model's walk: the next `batch` rows by id after the cursor, each problem pruned once
            const ahead = allIds()
              .filter((id) => id > cursor)
              .sort((x, y) => x - y)
              .slice(0, a.batch);
            expect(step.done).toBe(ahead.length === 0);
            const seen = new Set<number>();
            for (const id of ahead) {
              const e = [...model.values()].flat().find((x) => x.id === id);
              if (e && !seen.has(e.p)) {
                seen.add(e.p);
                prune(e.p);
              }
              cursor = id;
            }
            expect(step.cursor).toBe(cursor);
          } else if (a.kind === "submit") {
            const id = await store.insert(newRow(a.p, a.score, a.v, next));
            expect(id).toBe(next);
            model.set(a.p, [...(model.get(a.p) ?? []), { id, p: a.p, score: a.score, v: a.v, pieces: posesFor(id, a.p) }]);
            next++;
            await store.prune(4, 4, a.p);
            prune(a.p);
          } else {
            const listed = (model.get(a.p) ?? []).filter((e) => e.v !== "rejected");
            const target = listed[a.k];
            const id = target?.id ?? 999_999;
            const ok =
              a.kind === "remove"
                ? await store.remove(id)
                : await store.review(id, a.kind === "confirm" ? "confirmed" : "rejected");
            const applies = !!target && (a.kind === "remove" || target.v === "pending" || target.v === "confirmed");
            expect(ok).toBe(applies);
            if (applies) {
              const rest = (model.get(a.p) ?? [])
                .map((e) => (a.kind === "confirm" && e === target ? { ...e, v: "confirmed" as V } : e))
                .filter((e) => a.kind === "confirm" || e !== target);
              model.set(a.p, rest);
              prune(a.p);
            }
          }
          await check();
        }
        expect(store.piecesMigrated()).toBe(true);
        for (const r of rawRows(store)) expect(r.kind).toBe("blob");
      }),
      { numRuns: 200 },
    );
  });
});

describe("review: pruning a database written by the old code", () => {
  // The old code kept three rows per problem regardless of who led. Here: R (not pending), then a
  // claim L just below the published value, then a better claim X within the tolerance of L.
  // L leads (earliest within SCORE_TIE of X). R is kept behind it, X is deleted, and then R is
  // within the tolerance of the new smallest score (L's) and earlier: R leads, and the next prune
  // deletes the claim L, unreviewed.
  const rows = [
    { p: 3, score: 1 + 1.5 * SCORE_TIE, v: "none" as V },
    { p: 3, score: 1 + 0.9 * SCORE_TIE, v: "pending" as V },
    { p: 3, score: 1, v: "pending" as V },
  ];

  // Known limitation, accepted on 2026-10-19: only a database written by the old code can hold two
  // pending claims of one problem, and the live database had none when the migration was deployed
  // (0 pending rows in the 2026-10-18 backup and in /api/admin/pending). New code never keeps a
  // second claim. These fail until the leader rule stops depending on rows that pruning removes.
  it.fails("does not change the leader when the migration prunes the problem", async () => {
    const path = oldDatabase(rows.map((r, i) => ({ ...r, pieces: posesFor(i + 1, 3) })));
    const store = new SqliteStore(path);
    const before = (await store.leader(4, 4, 3))?.id;
    expect(before).toBe(2);
    store.migratePieces(100);
    expect((await store.leader(4, 4, 3))?.id).toBe(before);
  });

  it.fails("keeps the pending claim that led before the migration", async () => {
    const path = oldDatabase(rows.map((r, i) => ({ ...r, pieces: posesFor(i + 1, 3) })));
    const store = new SqliteStore(path);
    store.migratePieces(100);
    // any later prune of the problem (a submission, a review elsewhere in it)
    await store.prune(4, 4, 3);
    expect(await store.get(2)).not.toBeNull();
  });
});

describe("review: stored pieces that cannot be decoded", () => {
  it("answers a malformed BLOB with an error status rather than a crash of the process", async () => {
    const store = new SqliteStore(":memory:");
    const id = await store.insert(newRow(2, 2, "none", 1));
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.prepare("UPDATE submissions SET pieces = ? WHERE id = ?").run(new Uint8Array(23), id);
    const app = createApp({ store, records: [], adminToken: "t", log: () => {} });
    const r = await app.request(`/api/submissions/${id}`);
    // documents the behaviour: a 500 for the entry, and for any atlas range that includes it
    expect(r.status).toBe(500);
    const atlas = await app.request("/api/atlas?N=4&M=4&from=1&to=5");
    expect(atlas.status).toBe(500);
  });
});
