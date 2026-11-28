import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ANONYMOUS, nameFilter, nameHash } from "../src/name-filter";
import { SqliteStore } from "../src/sqlite-store";

// The same cases as name_filter.rs's tests, so that both servers refuse the same names.
describe("nameFilter", () => {
  it("refuses the words in their disguises", () => {
    const f = nameFilter();
    for (const name of ["N1GGER", "a55hole", "F.U.C.K", "Nazi", "ＮＩＧＧＥＲ", "🖕 hi", "cum", "CockNballz", "Hitler was right"])
      expect(f.refuses(name), name).toBe(true);
    for (const name of ["xXGamerXx", "Peacock", "Dickens", "Cumquat1", "Ignazio", "Gr8 Player", "Rio Negro", "Shrimp",
      "TighterGamePlayer2717975", "Anonymous", "Michael Sinko"])
      expect(f.refuses(name), name).toBe(false);
  });

  it("knows the removed names by their hash", () => {
    const f = nameFilter();
    expect(f.isRemoved("Cumfart")).toBe(true);
    expect(f.isRemoved("DaddyDongMilker")).toBe(true);
    expect(f.isRemoved("cumfart")).toBe(false);
    expect(nameHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("SqliteStore removed names", () => {
  it("names their entries Anonymous and forgets their peaks when it opens, once", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "names-")), "db.sqlite");
    const store = new SqliteStore(path);
    const add = (name: string) =>
      store.insert({
        N: 4, M: 4, P: 1, score: 1, name, agent_note: "", found_with: "hand", method: null, method_params: null,
        seed: null, budget: null, software: null, pieces: [{ x: 0, y: 0, theta: 0 }], container_phi: 0,
        created_at: "2026-10-18T00:00:00Z", verification: "none", literature_value: null, strict_check: null,
      });
    await add("Cumfart");
    await add("Ann");
    const db = (store as unknown as { db: DatabaseSync }).db;
    const space = db.prepare(
      "INSERT INTO space_entries (space, problem, score, name, agent_note, created_at, config) VALUES ('torus', 'x', 1, ?, '', '', '{}')",
    );
    space.run("Cumfart");
    space.run("Ann");
    await store.raiseHolderPeaks([{ name: "Cumfart", peak: 25 }, { name: "Ann", peak: 3 }]);
    db.close();

    const logs: string[] = [];
    const reopened = new SqliteStore(path, { log: (msg) => logs.push(msg) });
    const again = (reopened as unknown as { db: DatabaseSync }).db;
    const names = (table: string) =>
      (again.prepare(`SELECT name FROM ${table} ORDER BY id`).all() as { name: string }[]).map((r) => r.name);
    expect(names("submissions")).toEqual([ANONYMOUS, "Ann"]);
    expect(names("space_entries")).toEqual([ANONYMOUS, "Ann"]);
    expect(await reopened.holderPeaks()).toEqual([{ name: "Ann", peak: 3 }]);
    expect(logs).toEqual(["names: 1 removed name(s) left the site; 1 entries and 1 space entries are now named Anonymous"]);
    // the space entries are found through their listing index, not by reading the table
    const plan = (
      again
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM space_entries INDEXED BY space_entries_listing WHERE name IN (?)")
        .all("x") as { detail: string }[]
    ).map((r) => r.detail);
    expect(plan.join("; ")).toMatch(/COVERING INDEX space_entries_listing/);
    again.close();

    // nothing is left to remove
    const third: string[] = [];
    new SqliteStore(path, { log: (msg) => third.push(msg) });
    expect(third).toEqual([]);
  });
});
