import { describe, expect, it } from "vitest";
import { findFreeSpot } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import {
  GameState,
  addToQueue,
  applyAnswer,
  applyLoadAll,
  applyRun,
  buy,
  newGame,
  newProblem,
} from "../src/tighter/game";
import { recordSend } from "../src/tighter/pacer";
import {
  SAVE_VERSION,
  exportString,
  fromJson,
  importString,
  migrate,
  normalize,
  readSave,
  toJson,
} from "../src/tighter/save";

const T0 = 1_700_000_000_000;

function loadAll(N: number, M: number, P: number): PackingConfig {
  const pieces: Pose[] = [];
  for (let k = 0; k < P; k++) pieces.push(findFreeSpot(N, pieces, 0, 0));
  return { N, M, P, pieces, container_phi: 0 };
}

/** A game in the middle of Act I: a record verified, an upgrade bought, a submission paced. */
function played(): GameState {
  const s = newGame(T0, 1234);
  s.name = "Ada";
  s.consent = true;
  const p = newProblem({ N: 24, M: 30, P: 40 }, "open", T0);
  addToQueue(s, p);
  const b = loadAll(24, 30, 40);
  applyLoadAll(p, b, 7, null);
  // a strict "result": the Load-all board shifted, with a smaller made-up score (the save does not judge)
  const best = { ...b, pieces: b.pieces.map((q) => ({ ...q, x: q.x + 0.1 })), container_phi: 0.3 };
  applyRun(
    s,
    p,
    {
      best,
      score: 6.5,
      valid: true,
      strict: true,
      evaluations: 100,
      wallTime: 1.2,
      run: { method: "mc_compress", params: { shrinkFraction: 0.01 }, seed: 1, budget: { evals: 100 } },
    },
    T0 + 1000,
  );
  applyAnswer(s, p, null, 6.5, { kind: "leader", score: 6.5, id: 3, pending: false }, T0 + 2000);
  buy(s, "trace");
  s.pacer = recordSend(s.pacer, p.key, T0 + 2000);
  s.reveal.push("score", "points");
  s.log.push({ t: T0, text: "New record 6.500000" });
  s.past.push({
    N: 21,
    M: 21,
    P: 40,
    key: "21/21/40",
    tier: "open",
    best: 5,
    verified: 5,
    ourId: 2,
    rp: 3,
    leftAt: T0,
  });
  return s;
}

describe("Tighter saves", () => {
  it("round-trip through JSON with every value kept to the last bit", () => {
    const s = played();
    const r = fromJson(toJson(s), T0 + 5000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state).toEqual(s);
    // full precision of the pieces
    expect(r.state.queue[0].board!.pieces[7].x).toBe(s.queue[0].board!.pieces[7].x);
  });

  it("round-trip through an export string", async () => {
    const s = played();
    const text = await exportString(s);
    expect(text).toMatch(/^tighter:1:[zj]:[A-Za-z0-9_-]+$/);
    const r = await importString(text, T0 + 5000);
    expect(r.ok && r.state).toEqual(s);
    // whitespace from a copy and paste is ignored
    const wrapped = text.replace(/(.{60})/g, "$1\n  ");
    expect((await importString(wrapped, T0)).ok).toBe(true);
  });

  it("refuse damaged and foreign save strings", async () => {
    expect((await importString("hello", T0)).ok).toBe(false);
    expect((await importString("tighter:1:z:AAAA", T0)).ok).toBe(false);
    const r = await importString(`tighter:1:j:${btoa('{"version":1').replace(/=+$/, "")}`, T0);
    expect(r).toEqual({ ok: false, error: "the save is not valid JSON" });
  });

  it("refuse a save from a newer version, and anything that is not a save", () => {
    expect(readSave({ ...JSON.parse(toJson(played())), version: SAVE_VERSION + 1 }, T0)).toEqual({
      ok: false,
      error: `this save is from a newer version of Tighter (save format ${SAVE_VERSION + 1})`,
    });
    expect(readSave([], T0).ok).toBe(false);
    expect(readSave({ rp: 5 }, T0).ok).toBe(false);
  });

  it("run migrations step by step up to the current format", () => {
    // a hypothetical format history: 1 kept points as `points`, 2 renamed them `rp`
    const migrations = {
      1: (s: Record<string, unknown>) => {
        const { points, ...rest } = s;
        return { ...rest, rp: points };
      },
      2: (s: Record<string, unknown>) => ({ ...s, reveal: ["score"] }),
    };
    const m = migrate({ version: 1, points: 12 }, migrations, 3);
    expect(m).toEqual({ ok: true, save: { version: 3, rp: 12, reveal: ["score"] } });
    expect(migrate({ version: 2 }, {}, 3)).toEqual({ ok: false, error: "no way to read save format 2" });
    expect(migrate({ version: 0 }, migrations, 3).ok).toBe(false);
  });

  it("fill missing fields with defaults and drop what cannot be read", () => {
    const raw = JSON.parse(toJson(played()));
    delete raw.settings;
    delete raw.stats;
    raw.owned.push("warp-drive", "trace");
    raw.rp = -5;
    raw.consent = true;
    raw.name = "";
    raw.queue[0].board.pieces[0].x = "oops";
    raw.queue.push({ key: "not a problem" }, raw.queue[0]);
    const s = normalize(raw, T0);
    expect(s.owned).toEqual(["trace"]);
    expect(s.rp).toBe(0);
    // no consent without a name
    expect(s.consent).toBe(false);
    expect(s.settings).toEqual({ auto: false, method: "mc_compress", background: false, battery: false });
    expect(s.stats.evaluations).toBe(0);
    // an unreadable board takes its problem back to the start; duplicates and junk are dropped
    expect(s.queue).toHaveLength(1);
    expect(s.queue[0]).toMatchObject({ key: "24/30/40", phase: "bare", board: null, best: null, ourId: 3 });
    expect(s.focus).toBe("24/30/40");
  });

  it("refuse a board that belongs to another problem", () => {
    const raw = JSON.parse(toJson(played()));
    raw.queue[0].board.P = 41;
    expect(normalize(raw, T0).queue[0].phase).toBe("bare");
  });
});
