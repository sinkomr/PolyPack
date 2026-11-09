import { describe, expect, it } from "vitest";
import { evaluate } from "@polypack/geometry";
import {
  Checkpoint,
  CheckpointStore,
  Checkpoints,
  MAX_NAME,
  MemoryCheckpointStore,
  byScore,
  checkpointBoard,
  formatBytes,
  makeCheckpoint,
} from "../src/checkpoints";

// two squares in a square container, the same closer together, and with one placed
const square = (x: number) => ({ x, y: 0, theta: 0 });
const two = { N: 4, M: 4, P: 2, container_phi: 0, pieces: [square(0), square(2)] };
const tight = { ...two, pieces: [square(0), square(1.5)] };
const one = { ...two, pieces: [square(0)] };
const other = { N: 6, M: 4, P: 1, container_phi: 0, pieces: [square(0)] };

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);

describe("a checkpoint", () => {
  it("keeps the board with its units, its problem, and its score when all P pieces are placed", () => {
    const c = makeCheckpoint(two, "  after basin hop 3  ", T0);
    expect(c.key).toBe("4/4/2");
    expect(c.name).toBe("after basin hop 3");
    expect(c.placed).toBe(2);
    expect(c.savedAt).toBe("2026-11-08T12:00:00.000Z");
    expect(c.board.units).toBe("diameter");
    const e = evaluate(two);
    expect(e.valid && c.score).toBe(e.valid && e.container.size);
    expect(c.bytes).toBe(JSON.stringify(c.board).length);
  });

  it("has no score while pieces are missing", () => {
    const c = makeCheckpoint(one, "", T0);
    expect(c.score).toBeNull();
    expect(c.placed).toBe(1);
  });

  it("caps the name, and gives every checkpoint its own id", () => {
    expect(makeCheckpoint(two, "x".repeat(200), T0).name).toHaveLength(MAX_NAME);
    const ids = new Set(Array.from({ length: 50 }, () => makeCheckpoint(two, "", T0).id));
    expect(ids.size).toBe(50);
  });

  it("loads back as the board it was", () => {
    const r = checkpointBoard(makeCheckpoint(two, "", T0));
    expect(r.ok && r.config).toEqual(two);
    const broken = { ...makeCheckpoint(two, "", T0), board: { ...two, units: "diameter", P: 0 } };
    expect(checkpointBoard(broken).ok).toBe(false);
  });
});

describe("the checkpoints of a problem", () => {
  it("are listed best first, incomplete ones last, newest first among equals", () => {
    const loose = makeCheckpoint(two, "loose", T0);
    const best = makeCheckpoint(tight, "best", T0);
    const partOld = makeCheckpoint(one, "part, old", T0);
    const partNew = makeCheckpoint(one, "part, new", T0 + 1000);
    const sorted = [partOld, loose, partNew, best].sort(byScore).map((c) => c.name);
    expect(sorted).toEqual(["best", "loose", "part, new", "part, old"]);
  });

  it("are kept in the store, listed per problem and summed up for the overview", async () => {
    const store = new MemoryCheckpointStore();
    const cps = new Checkpoints(store);
    await cps.add(makeCheckpoint(two, "a", T0));
    await cps.add(makeCheckpoint(tight, "b", T0 + 1000));
    await cps.add(makeCheckpoint(other, "c", T0 + 500));
    expect(store.rows.size).toBe(3);
    expect(cps.size).toBe(3);
    expect(cps.forProblem("4/4/2").map((c) => c.name)).toEqual(["b", "a"]);
    expect(cps.forProblem("5/5/5")).toEqual([]);
    const summary = cps.summary();
    expect(summary.map((s) => [s.key, s.count])).toEqual([
      ["4/4/2", 2],
      ["6/4/1", 1],
    ]);
    expect(summary[0].best).toBe(cps.forProblem("4/4/2")[0].score);
    expect(summary[0].newest).toBe("2026-11-08T12:00:01.000Z");
    expect(cps.bytes).toBe(summary.reduce((n, s) => n + s.bytes, 0));
  });

  it("can be deleted one at a time, a problem at a time, or all at once", async () => {
    const store = new MemoryCheckpointStore();
    const cps = new Checkpoints(store);
    const a = makeCheckpoint(two, "a", T0);
    await cps.add(a);
    await cps.add(makeCheckpoint(tight, "b", T0));
    await cps.add(makeCheckpoint(other, "c", T0));
    await cps.add(makeCheckpoint(other, "d", T0));
    expect(await cps.remove([a.id, "no such id"])).toBe(1);
    expect(cps.forProblem("4/4/2").map((c) => c.name)).toEqual(["b"]);
    expect(await cps.removeProblem("6/4/1")).toBe(2);
    expect([...store.rows.values()].map((c) => c.name)).toEqual(["b"]);
    expect(await cps.removeAll()).toBe(1);
    expect(store.rows.size).toBe(0);
    expect(await cps.removeAll()).toBe(0);
  });

  it("are read again from the store, so another tab's changes show", async () => {
    const store = new MemoryCheckpointStore();
    const here = new Checkpoints(store);
    const there = new Checkpoints(store);
    await there.add(makeCheckpoint(two, "from the other tab", T0));
    expect(here.size).toBe(0);
    const before = here.version;
    expect(await here.reload()).toBe(true);
    expect(here.forProblem("4/4/2").map((c) => c.name)).toEqual(["from the other tab"]);
    expect(here.version).toBeGreaterThan(before);
  });

  it("stay as they were when the store fails", async () => {
    const broken: CheckpointStore = {
      all: () => Promise.reject(new Error("no")),
      put: () => Promise.reject(new Error("quota")),
      remove: () => Promise.reject(new Error("no")),
    };
    const cps = new Checkpoints(broken);
    await expect(cps.add(makeCheckpoint(two, "", T0))).rejects.toThrow("quota");
    expect(cps.size).toBe(0);
    expect(await cps.reload()).toBe(false);
  });

  it("live in memory only without a store", async () => {
    const cps = new Checkpoints(null);
    expect(cps.persistent).toBe(false);
    await cps.add(makeCheckpoint(two, "", T0));
    expect(await cps.reload()).toBe(true);
    expect(cps.size).toBe(1);
  });
});

it("sizes read as bytes, KB or MB", () => {
  expect(formatBytes(820)).toBe("820 B");
  expect(formatBytes(14_230)).toBe("14.2 KB");
  expect(formatBytes(3_140_000)).toBe("3.1 MB");
});
