import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HistoryLine,
  LockHeld,
  StateDir,
  acquireLock,
  bestFileOf,
  candidateOf,
  pidAlive,
  writeFileAtomic,
} from "../src/state";
import type { Candidate } from "../src/types";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pv-state-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lockFile = (fields: object) => JSON.stringify({ started: "2026-10-21T00:00:00Z", token: "old", ...fields });

describe("atomic writes", () => {
  it("replace the file whole and leave no temporary file", () => {
    const path = join(dir, "memory.json");
    writeFileAtomic(path, '{"v":1}');
    writeFileAtomic(path, '{"v":2}');
    expect(readFileSync(path, "utf8")).toBe('{"v":2}');
    expect(readdirSync(dir)).toEqual(["memory.json"]);
  });

  it("leave the old content and no temporary file when the rename fails", () => {
    // a directory in the way makes the rename fail
    const path = join(dir, "taken");
    mkdirSync(join(path, "inside"), { recursive: true });
    expect(() => writeFileAtomic(path, "new")).toThrow();
    expect(readdirSync(dir)).toEqual(["taken"]);
    expect(readdirSync(path)).toEqual(["inside"]);
  });
});

describe("the lock", () => {
  it("lets one copy in and keeps a second out until the first releases it", () => {
    const path = join(dir, "lock");
    const first = acquireLock(path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: process.pid, hostname: hostname() });
    expect(() => acquireLock(path)).toThrow(LockHeld);
    first.release();
    const second = acquireLock(path);
    second.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("takes over a lock left by a copy on this machine that no longer runs", () => {
    const path = join(dir, "lock");
    writeFileSync(path, lockFile({ pid: 999_999_999, hostname: hostname() }));
    const lock = acquireLock(path, { alive: () => false });
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(lock.info.token);
    lock.release();
    expect(readdirSync(dir)).toEqual([]); // no takeover file or temporary file left
  });

  // Fix 4: in a container every start is pid 1 with the same host name.
  it("takes over a lock with this process's own pid that this process does not hold", () => {
    const path = join(dir, "lock");
    writeFileSync(path, lockFile({ pid: process.pid, hostname: hostname() }));
    const lock = acquireLock(path, { alive: () => true });
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(lock.info.token);
    // a lock this process does hold still keeps a second taker out
    expect(() => acquireLock(path, { alive: () => true })).toThrow(LockHeld);
    lock.release();
  });

  it("counts a lock from another machine, or one it cannot read, as held", () => {
    const path = join(dir, "lock");
    writeFileSync(path, lockFile({ pid: 1, hostname: "elsewhere" }));
    expect(() => acquireLock(path, { alive: () => false })).toThrow(/held by process 1 on elsewhere/);
    writeFileSync(path, "garbage");
    expect(() => acquireLock(path, { alive: () => false })).toThrow(LockHeld);
  });

  // Fix 5: two copies that both find the same stale lock must not both take it.
  it("lets only one of two copies take over a stale lock", () => {
    const path = join(dir, "lock");
    writeFileSync(path, lockFile({ pid: 111, hostname: "box" }));
    const alive = (pid: number) => pid === 201 || pid === 202; // 111 is gone
    let rival: ReturnType<typeof acquireLock> | null = null;
    // copy A has found the stale lock; before it takes it over, copy B does the whole thing
    const a = () =>
      acquireLock(path, {
        pid: 201,
        hostname: "box",
        alive,
        beforeTakeover: () => {
          if (!rival) rival = acquireLock(path, { pid: 202, hostname: "box", alive });
        },
      });
    expect(a).toThrow(/held by process 202/);
    expect(rival).not.toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: 202, token: rival!.info.token });
    rival!.release();
  });

  it("waits for another copy's takeover, and removes a takeover file left by a crash", () => {
    const path = join(dir, "lock");
    writeFileSync(path, lockFile({ pid: 111, hostname: "box" }));
    writeFileSync(`${path}.takeover`, "999\n");
    const options = { pid: 201, hostname: "box", alive: () => false, takeoverWaitMs: 100 };
    expect(() => acquireLock(path, options)).toThrow(/another copy is taking over/);
    const old = Date.now() / 1000 - 3600;
    utimesSync(`${path}.takeover`, old, old);
    const lock = acquireLock(path, options);
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(lock.info.token);
    expect(readdirSync(dir).sort()).toEqual(["lock"]);
    lock.release();
  });

  it("is only removed by its owner", () => {
    const path = join(dir, "lock");
    const mine = acquireLock(path);
    // another copy took over (say, after this one was suspended for long)
    writeFileSync(path, JSON.stringify({ ...mine.info, token: "someone-else" }));
    mine.release();
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe("someone-else");
  });

  it("checks pids", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(999_999_999)).toBe(false);
  });
});

describe("the state directory", () => {
  const problem = { N: 4, M: 4, P: 3 };
  const pieces = [
    { x: 0, y: 0, theta: 0 },
    { x: 1, y: 0, theta: 0 },
    { x: 0, y: 1, theta: 0 },
  ];
  const candidate: Candidate = {
    config: { ...problem, pieces, container_phi: 0 },
    score: 2.0000001,
    strict: true,
    job: { problem, method: "asc", seed: 7, budget: { time_s: 30 }, kind: "fresh", start: undefined },
    params: { a: 1 },
  };
  const line = (P: number): HistoryLine =>
    ({ time: "2026-10-21T00:00:00.000Z", N: 4, M: 4, P, stopped: "time", decision: "" }) as HistoryLine;

  it("cannot be opened twice", () => {
    const state = StateDir.open(dir);
    expect(() => StateDir.open(dir)).toThrow(LockHeld);
    state.close();
    StateDir.open(dir).close();
  });

  it("keeps the engine's memory, and forgets an unreadable one", () => {
    const state = StateDir.open(dir);
    expect(state.readMemory()).toBeUndefined();
    state.writeMemory({ methods: { asc: 3 } });
    expect(state.readMemory()).toEqual({ methods: { asc: 3 } });
    writeFileSync(state.memoryPath, '{"methods": {"asc"');
    expect(state.readMemory()).toBeUndefined();
    state.close();
  });

  it("reads the history once when opened, skips broken lines and mends a line cut short", () => {
    let state = StateDir.open(dir);
    state.appendHistory(line(1));
    writeFileSync(state.historyPath, readFileSync(state.historyPath, "utf8") + '{"time": "2026-10-21T00:01');
    state.close();
    state = StateDir.open(dir);
    expect(state.initialHistory.map((l) => l.P)).toEqual([1]);
    state.appendHistory(line(2));
    expect(state.readHistory()).toHaveLength(2);
    expect(readFileSync(state.historyPath, "utf8").split("\n")).toHaveLength(4); // 3 lines and the final newline
    state.close();
  });

  it("cuts the history back to its last lines, when opened and while running", () => {
    const path = join(dir, "history.jsonl");
    writeFileSync(path, Array.from({ length: 25 }, (_, i) => JSON.stringify(line(i + 1)) + "\n").join(""));
    const state = StateDir.open(dir, { maxHistory: 10 });
    expect(state.initialHistory.map((l) => l.P)).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    expect(state.readHistory()).toHaveLength(10);
    // 10 kept, cut back once more than 10 + 1 lines are there
    state.appendHistory(line(26));
    expect(state.readHistory()).toHaveLength(11);
    state.appendHistory(line(27));
    expect(state.readHistory().map((l) => l.P)).toEqual([18, 19, 20, 21, 22, 23, 24, 25, 26, 27]);
    state.close();
  });

  it("removes temporary files left by a crash, but not fresh ones", () => {
    mkdirSync(join(dir, "best"), { recursive: true });
    const old = Date.now() / 1000 - 3600;
    for (const name of ["memory.json.1-ab.tmp", "best/4-4-3.json.1-cd.tmp"]) {
      writeFileSync(join(dir, name), "half");
      utimesSync(join(dir, name), old, old);
    }
    writeFileSync(join(dir, "lock.fresh.tmp"), "another copy starting");
    const state = StateDir.open(dir);
    expect(readdirSync(dir).sort()).toEqual(["best", "lock", "lock.fresh.tmp", "state.json"]);
    expect(readdirSync(join(dir, "best"))).toEqual([]);
    state.close();
  });

  it("keeps a best packing with its provenance", () => {
    const state = StateDir.open(dir);
    expect(state.readBest(problem)).toBeNull();
    state.writeBest(bestFileOf(candidate, "0.1.0", new Date("2026-10-21T00:00:00Z")));
    const file = state.readBest(problem)!;
    expect(file).toMatchObject({ ...problem, score: 2.0000001, method: "asc", seed: 7, params: { a: 1 } });
    expect(file.found_at).toBe("2026-10-21T00:00:00.000Z");
    const back = candidateOf(file);
    expect(back).toMatchObject({ score: candidate.score, strict: true, params: { a: 1 } });
    expect(back.job).toMatchObject({ method: "asc", seed: 7, budget: { time_s: 30 }, kind: "fresh" });
    expect(back.config).toEqual(candidate.config);
    state.close();
  });

  it("does not use a best packing that does not fit its problem", () => {
    const state = StateDir.open(dir);
    const good = bestFileOf(candidate, "0.1.0");
    const bad = [
      { ...good, P: 4 },
      { ...good, config: { ...good.config, P: 4 } },
      { ...good, config: { ...good.config, N: 0 } },
      { ...good, config: { ...good.config, pieces: pieces.slice(1) } },
      { ...good, config: { ...good.config, pieces: [null, ...pieces.slice(1)] } },
      { ...good, config: { ...good.config, pieces: [{ x: "0", y: 0, theta: 0 }, ...pieces.slice(1)] } },
      { ...good, seed: -1 },
      { ...good, budget: { time_s: "30" } },
      { ...good, score: "2" },
    ];
    for (const f of bad) {
      writeFileSync(state.bestPath(problem), JSON.stringify(f));
      expect(state.readBest(problem), JSON.stringify(f).slice(0, 120)).toBeNull();
    }
    writeFileSync(state.bestPath(problem), JSON.stringify(good));
    expect(state.readBest(problem)).not.toBeNull();
    state.close();
  });
});
