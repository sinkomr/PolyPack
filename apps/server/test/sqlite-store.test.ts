import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    await store.insert({
      N: 4,
      M: 4,
      P: 1,
      score: 1,
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
      verification: "none",
      literature_value: null,
      strict_check: null,
    });
    await store.leader(4, 4, 1);
    await store.prune(4, 4, 1);
    await store.rank(4, 4, 1, 1);
    await store.bestPerP(4, 4);
    await store.bestPerP(4, 4, true);
    expect(plans.length).toBeGreaterThanOrEqual(5);
    for (const plan of plans) {
      for (const step of plan.split("; ")) expect(step).toMatch(/USING COVERING INDEX submissions_listing/);
    }
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
