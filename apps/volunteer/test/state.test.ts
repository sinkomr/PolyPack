import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockHeld, StateDir, acquireLock, bestFileOf, candidateOf, pidAlive, writeFileAtomic } from "../src/state";
import type { Candidate } from "../src/types";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pv-state-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
    writeFileSync(path, JSON.stringify({ pid: 999_999_999, hostname: hostname(), started: "x", token: "old" }));
    const lock = acquireLock(path, () => false);
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(lock.info.token);
    lock.release();
  });

  it("counts a lock from another machine, or one it cannot read, as held", () => {
    const path = join(dir, "lock");
    writeFileSync(path, JSON.stringify({ pid: 1, hostname: "elsewhere", started: "x", token: "t" }));
    expect(() => acquireLock(path, () => false)).toThrow(/held by process 1 on elsewhere/);
    writeFileSync(path, "garbage");
    expect(() => acquireLock(path, () => false)).toThrow(LockHeld);
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
  const candidate: Candidate = {
    config: { ...problem, pieces: [{ x: 0, y: 0, theta: 0 }], container_phi: 0 },
    score: 2.0000001,
    strict: true,
    job: { problem, method: "asc", seed: 7, budget: { time_s: 30 }, kind: "fresh", start: undefined },
    params: { a: 1 },
  };

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

  it("appends history lines, skips broken ones and mends a line cut short", () => {
    let state = StateDir.open(dir);
    const line = { time: "2026-10-21T00:00:00.000Z", ...problem, stopped: "time" } as never;
    state.appendHistory(line);
    writeFileSync(state.historyPath, readFileSync(state.historyPath, "utf8") + '{"time": "2026-10-21T00:01');
    state.close();
    state = StateDir.open(dir);
    state.appendHistory(line);
    expect(state.readHistory()).toHaveLength(2);
    expect(readFileSync(state.historyPath, "utf8").split("\n")).toHaveLength(4); // 3 lines and the final newline
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
    // a file for another problem, or a damaged one, is not used
    writeFileSync(state.bestPath(problem), JSON.stringify({ ...file, P: 4 }));
    expect(state.readBest(problem)).toBeNull();
    state.close();
  });
});
