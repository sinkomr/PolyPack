import { describe, expect, it } from "vitest";
import { answerTrouble, classifyAnswer, troubleText } from "../src/tighter/submission";

// Trouble with sending, as the notice line under the board tells it: what happened, then what the
// game does next. Points waiting for the server's answer are not shown at all.

const TITLE = "24-gons in a 30-gon, 3 pieces";
const trouble = (status: number | null, body: unknown = null, timedOutAfter: number | null = null) =>
  answerTrouble(classifyAnswer(status, body), status, timedOutAfter, TITLE, "5.7");

describe("Tighter trouble with sending", () => {
  it("is nothing for an answer the game can act on", () => {
    expect(trouble(200, { valid: true, score: 9.5, leader: true, id: 4 })).toBeNull();
    expect(trouble(200, { valid: true, score: 9.5, leader: false, leader_score: 9.3 })).toBeNull();
    expect(trouble(409, { reasons: ["this problem is closed"] })).toBeNull();
  });

  it("tells an unreachable server, a late answer, a 5xx and a 429 apart, each with when sending tries again", () => {
    expect(troubleText(trouble(null)!)).toBe("The server cannot be reached. Sending will try again in 30 seconds.");
    expect(troubleText(trouble(null, null, 30_000)!)).toBe(
      "The server did not answer within 30 seconds. Sending will try again in 30 seconds.",
    );
    expect(troubleText(trouble(502)!)).toBe(
      "The server answered with an error (502). Sending will try again in 30 seconds.",
    );
    expect(troubleText(trouble(429, { reasons: ["too many submissions from this address; wait a minute"] })!)).toBe(
      "The server says too many submissions came from your address. Sending will try again in a minute.",
    );
  });

  it("names the refused board, the server's reasons (the first two) and the points taken back", () => {
    expect(troubleText(trouble(400, { valid: false, reasons: ["name is required"] })!)).toBe(
      `The server refused your board on ${TITLE} (name is required). The 5.7 RP it paid were taken back. Your next better board will be sent as usual.`,
    );
    const overlaps = Array.from({ length: 20 }, (_, i) => `pieces ${i} and ${i + 1} overlap`);
    const text = troubleText(
      answerTrouble(classifyAnswer(422, { valid: false, reasons: overlaps }), 422, null, TITLE, null)!,
    );
    expect(text).toBe(
      `The server refused your board on ${TITLE} (pieces 0 and 1 overlap, pieces 1 and 2 overlap and 18 more). Your next better board will be sent as usual.`,
    );
  });

  it("says when an answer that never came cannot be checked, and when the game checks again", () => {
    expect(troubleText({ kind: "lost", title: TITLE })).toBe(
      `The server never answered your board on ${TITLE}, and it cannot be reached to check whether the board arrived. The game checks again in 30 seconds.`,
    );
  });

  it("is written in plain sentences: no semicolons, no colons, no dashes", () => {
    const all = [
      troubleText({ kind: "unreachable" }),
      troubleText({ kind: "timeout", waitedMs: 30_000 }),
      troubleText({ kind: "error", status: 500 }),
      troubleText({ kind: "rate-limited" }),
      troubleText({ kind: "refused", title: TITLE, reasons: ["x"], takenBack: "1.0" }),
      troubleText({ kind: "lost", title: TITLE }),
    ];
    for (const t of all) expect(t).not.toMatch(/[;:—–]/);
  });
});
