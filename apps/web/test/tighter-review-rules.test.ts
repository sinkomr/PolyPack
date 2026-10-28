import { describe, expect, it } from "vitest";
import { SCORE_TIE, areaLowerBound } from "@polypack/geometry";
import type { PackingConfig } from "@polypack/geometry";
import {
  ProblemState,
  addToQueue,
  applyAnswer,
  applyLeader,
  applyStep,
  hasUnsent,
  markSending,
  newGame,
  newProblem,
  recordsHeld,
  unconfirmedPoints,
} from "../src/tighter/game";
import { MAX_NAME_LENGTH as SERVER_MAX_NAME_LENGTH, sanitizeText } from "../../server/src/limits";
import { MAX_NAME_LENGTH, sanitizeName } from "../src/tighter/names";
import { fromJson, toJson } from "../src/tighter/save";
import { canSend, newPacer, recordSend } from "../src/tighter/pacer";
import { recordPoints, shapeWeight } from "../src/tighter/points";
import { msPerEval } from "../src/tighter/families";
import type { SubmitOutcome } from "../src/tighter/submission";

// Independent review of Tighter (2026-10-19). Tests named "owner rule" assert the site owner's rules
// as stated in the review brief; a failure there is a finding, not a broken test.

const T0 = 5_000_000;
const KEY = "24/30/3";
const cfg = (shift: number): PackingConfig => ({
  N: 24,
  M: 30,
  P: 3,
  pieces: [0, 1, 2].map((i) => ({ x: 3 * i + shift, y: 0, theta: 0 })),
  container_phi: 0,
});
const runRec = (seed: number) => ({ method: "mc_compress", params: {}, seed, budget: { evals: 30 } });

function readyProblem(name = "Ada"): { s: ReturnType<typeof newGame>; p: ProblemState } {
  const s = newGame(T0, 1);
  s.name = name;
  const p = newProblem({ family: "polygon", N: 24, M: 30, P: 3 }, "open", T0);
  addToQueue(s, p);
  p.phase = "loaded";
  p.board = cfg(0);
  p.best = 12;
  p.floor = 12;
  // Compact: the first record, paid at once
  applyStep(
    s,
    p,
    { best: cfg(1), score: 11, evaluations: 100, ms: 1000, run: runRec(1), ended: false, click: true },
    T0,
  );
  return { s, p };
}

describe("tighter review: owner pacing rule (one POST per problem per minute)", () => {
  it("owner rule: a problem leaving the queue still waits for its minute after a POST", () => {
    const sent = recordSend(newPacer(), KEY, T0);
    // design §9 lets a leaving problem's best go "at once"; the owner's rule allows one per problem per minute
    expect(canSend(sent, KEY, T0 + 5_000, { leaving: true })).toBe(false);
  });

  it("owner rule: after a refused first record, the next POST on that problem waits for its minute", () => {
    const sent = recordSend(newPacer(), KEY, T0);
    // main.ts marks a problem "first" while verified and leader are null, which stays true after a 400/422
    expect(canSend(sent, KEY, T0 + 5_000, { first: true })).toBe(false);
  });
});

describe("tighter review: points", () => {
  it("match the §5 formula term by term on arbitrary verified improvements", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 500; i++) {
      const N = [0, 3, 4, 7, 21, 33, 60, 100][Math.floor(rnd() * 8)];
      const M = [0, 3, 4, 6, 24, 47, 90][Math.floor(rnd() * 7)];
      const P = 2 + Math.floor(rnd() * 300);
      const b = areaLowerBound(N, M, P);
      const sPrev = b * (1.02 + rnd() * 0.4);
      const delta = 10 ** (-9 + rnd() * 8) * (1 + rnd());
      const sNew = sPrev * (1 - delta);
      if (!(sNew > b)) continue;
      const tier = rnd() < 0.5 ? "open" : "loose";
      const first = rnd() < 0.3;
      const pts = recordPoints({ family: "polygon", N, M, P, sPrev, sNew, tier, first, beatOther: false });
      const d = 1 - sNew / sPrev;
      if (!(sNew < sPrev * (1 - SCORE_TIE))) {
        expect(pts).toBeNull();
        continue;
      }
      const gp = sPrev / b - 1,
        gn = sNew / b - 1;
      const bonus = first && gn <= 0.9 * gp ? 10 : 0;
      const want =
        shapeWeight(N, M) *
        (tier === "open" ? 1 : 3) *
        (msPerEval(N + M + P) / msPerEval(85)) *
        (1 + Math.log10(d / 1e-9) + 10_000 * Math.log(sPrev / sNew) + 10_000 * Math.log(gp / gn) + bonus);
      expect(pts).not.toBeNull();
      expect(Math.abs(pts!.total - want)).toBeLessThan(1e-12 * Math.max(1, want));
    }
  });

  it("paid per click are kept only when the server makes the entry leader", () => {
    // taken back: the server looked at the entry and did not make it leader
    const lost: SubmitOutcome[] = [
      { kind: "behind", score: 11, leaderScore: 10.9 },
      { kind: "closed", reasons: [] },
      { kind: "refused", status: 422, reasons: ["overlap"] },
    ];
    for (const o of lost) {
      const { s, p } = readyProblem();
      expect(s.rp).toBeGreaterThan(0);
      markSending(p, 11, "Ada", null, T0);
      applyAnswer(s, p, null, 11, o, T0);
      expect(s.rp).toBe(0);
      expect(s.rpEarned).toBe(0);
      expect(unconfirmedPoints(s)).toBe(0);
    }
    // not looked at (429) or no answer: the points stay, waiting for a verdict
    for (const o of [{ kind: "rate-limited", reasons: [] }, { kind: "offline" }] as SubmitOutcome[]) {
      const { s, p } = readyProblem();
      const paid = s.rp;
      markSending(p, 11, "Ada", null, T0);
      applyAnswer(s, p, null, 11, o, T0);
      expect(s.rp).toBe(paid);
      expect(unconfirmedPoints(s)).toBe(paid);
    }
    // confirmed
    const { s, p } = readyProblem();
    const paid = s.rp;
    markSending(p, 11, "Ada", null, T0);
    applyAnswer(s, p, null, 11, { kind: "leader", score: 11, id: 4, pending: false }, T0);
    expect(s.rp).toBe(paid);
    expect(unconfirmedPoints(s)).toBe(0);
  });

  it("do not pay the beat-other bonus for beating your own record under the server's sanitised name", () => {
    // The player typed "Ada <3"; the server stores names with angle brackets removed ("Ada 3").
    const { s, p } = readyProblem("Ada <3");
    // our first record was accepted but its answer was lost (reload, or a second tab sent it):
    // the game never learnt its id, and the leader read before the next POST is that entry
    const ownEntry = { score: 11, name: "Ada 3", id: 77 };
    applyLeader(p, ownEntry);
    p.verified = null;
    // the next click beats that entry: it is ours, so no bonus for beating another name
    const pts = applyStep(
      s,
      p,
      { best: cfg(2), score: 10.9, evaluations: 1, ms: 1, run: runRec(1), ended: false, click: true },
      T0,
    ).points;
    expect(pts).not.toBeNull();
    expect(pts!.beatBonus).toBe(false);
  });
});

describe("tighter review: what the player sees after edge answers", () => {
  it("a 'behind' answer does not relabel a rival's record with the player's own name", () => {
    const { s, p } = readyProblem();
    applyAnswer(s, p, null, 11, { kind: "leader", score: 11, id: 5, pending: false }, T0);
    p.best = 10.95;
    // a rival got 10.9 in between the GET and the POST
    applyAnswer(s, p, p.leader, 10.95, { kind: "behind", score: 10.95, leaderScore: 10.9 }, T0 + 61_000);
    expect(p.leader?.score).toBe(10.9);
    expect(p.leader?.name).not.toBe("Ada");
  });

  it("an accepted first record whose answer was lost is still counted as held once the leader is read", () => {
    const { s, p } = readyProblem();
    // POST reached the server (id 9), the tab reloaded before the answer: the save has no id.
    // Adjusted for the fix: the game marks the send in the save before the POST, and settles it
    // with the game state when it next reads the leader.
    markSending(p, 11, "Ada", null, T0);
    expect(hasUnsent(p)).toBe(true);
    // the first record was paid when the click found it; the lost answer only confirms it
    const paid = s.rp;
    expect(paid).toBeGreaterThan(0);
    const r = applyLeader(p, { score: 11, name: "Ada", id: 9 }, s, T0 + 5000);
    expect(r.reconciled).toBe(true);
    expect(r.confirmed).toBe(paid);
    expect(hasUnsent(p)).toBe(false);
    expect(recordsHeld(s)).toBe(1);
    expect(s.rp).toBe(paid);
    expect(unconfirmedPoints(s)).toBe(0);
    expect(s.stats.firstRecords).toBe(1);
    applyLeader(p, { score: 11, name: "Ada", id: 9 }, s, T0 + 6000);
    expect(s.rp).toBe(paid);
    expect(s.stats.firstRecords).toBe(1);
  });
});

describe("tighter review fixes: regressions", () => {
  it("clean names exactly as the server does", () => {
    const samples = [
      "Ada",
      "  Ada   Lovelace ",
      "<>",
      "Ada <3",
      `<img src=x onerror="x">`,
      "a\u0000b\u001fc\u007fd\u009fe",
      "zero​width‏ marks‪‮⁦⁩",
      "tab\tand\nnewline",
      "é", // NFC
      "x".repeat(60),
      "y".repeat(39) + " z",
      "",
    ];
    expect(MAX_NAME_LENGTH).toBe(SERVER_MAX_NAME_LENGTH);
    for (const raw of samples) expect(sanitizeName(raw)).toBe(sanitizeText(raw, SERVER_MAX_NAME_LENGTH));
    expect(sanitizeName("<>")).toBe("");
  });

  it("a lost send that did not lead is forgotten, and its points wait for the next send's verdict", () => {
    const { s, p } = readyProblem();
    const paid = s.rp;
    markSending(p, 11, "Ada", null, T0);
    // the leader is a rival's 10.9: our POST never arrived, or arrived too late
    const r = applyLeader(p, { score: 10.9, name: "Bob", id: 4 }, s, T0);
    expect(r.reconciled).toBe(false);
    expect(r.confirmed).toBe(0);
    expect(p.sending).toBeNull();
    expect(p.unconfirmed).toBe(paid);
    expect(recordsHeld(s)).toBe(0);
    // the board does not beat 10.9, so nothing goes; the next submission that is answered decides
    expect(hasUnsent(p)).toBe(false);
    markSending(p, 11, "Ada", p.leader, T0 + 61_000);
    applyAnswer(s, p, p.leader, 11, { kind: "behind", score: 11, leaderScore: 10.9 }, T0 + 61_000);
    expect(s.rp).toBe(0);
    // a same-named entry with another score is not ours either
    markSending(p, 11, "Ada", null, T0);
    expect(applyLeader(p, { score: 10.99, name: "Ada", id: 5 }, s, T0).reconciled).toBe(false);
  });

  it("an answer clears the pending send, except when there was no answer", () => {
    const { s, p } = readyProblem();
    markSending(p, 11, "Ada", null, T0);
    applyAnswer(s, p, null, 11, { kind: "offline" }, T0);
    expect(p.sending).not.toBeNull();
    applyAnswer(s, p, null, 11, { kind: "refused", status: 400, reasons: ["x"] }, T0);
    expect(p.sending).toBeNull();
  });

  it("a board that still beats the rival found by a 'behind' answer pays the beat-other bonus", () => {
    const { s, p } = readyProblem();
    // a better board than the rival's 10.99999, sent as 11 and answered "behind"
    applyStep(
      s,
      p,
      { best: cfg(2), score: 10.9, evaluations: 1, ms: 1, run: runRec(1), ended: false, click: true },
      T0,
    );
    markSending(p, 10.9, "Ada", null, T0);
    const a = applyAnswer(s, p, null, 10.9, { kind: "behind", score: 10.9, leaderScore: 10.95 }, T0);
    expect(a.points?.beatBonus).toBe(true);
    expect(p.beatPaid).toBe(true);
  });

  it("the pending send survives a save and a reload, with the points it carries", () => {
    const { s, p } = readyProblem();
    const paid = s.rp;
    markSending(p, 11, "Ada <3", { score: 12, name: "Bob", id: 2 }, T0);
    const r = fromJson(toJson(s), T0);
    expect(r.ok && r.state.queue[0].sending).toEqual({
      score: 11,
      name: "Ada 3",
      leaderBefore: { score: 12, name: "Bob", id: 2 },
      at: T0,
      rp: paid,
    });
  });
});
