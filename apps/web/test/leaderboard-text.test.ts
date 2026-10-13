import { SubmitResponse } from "@polypack/geometry";
import { describe, expect, it } from "vitest";
import { CLOSED_NOTE, acceptedMessage, leaderboardNote } from "../src/leaderboard-text";

const response = (extra: Partial<SubmitResponse>): SubmitResponse => ({
  valid: true,
  reasons: [],
  score: 2.5,
  rank: 1,
  leader: true,
  leader_score: 2.5,
  id: 1,
  container: null,
  pending_verification: false,
  strict_check: null,
  ...extra,
});

describe("submit result text", () => {
  it("announces a new leader, with the review sentence when it beats the published value", () => {
    expect(acceptedMessage(response({}))).toBe(
      "✓ Accepted. Server score 2.500000. This is now the best entry for this problem.",
    );
    expect(acceptedMessage(response({ pending_verification: true }))).toMatch(
      /best entry for this problem\. This beats the published value and is pending verification\.$/,
    );
  });

  it("names the score to beat when the entry does not lead", () => {
    const text = acceptedMessage(response({ rank: 2, leader: false, leader_score: 2.25, score: 2.25 }));
    expect(text).toContain("Valid, score 2.250000, but it does not beat the current best 2.250000");
    expect(text).toContain("equal scores keep the earlier entry");
    expect(text).not.toContain("Accepted");
    // a leader that vanished between the two server queries leaves no score to quote
    expect(acceptedMessage(response({ rank: 2, leader: false, leader_score: null }))).toContain(
      "the current best (an entry",
    );
  });
});

describe("leaderboard note", () => {
  it("counts the stored submissions and says which one is shown", () => {
    expect(leaderboardNote(0, 0, true)).toBe("No entries yet. Yours could be the first.");
    expect(leaderboardNote(1, 1, true)).toBe("1 submission so far.");
    expect(leaderboardNote(3, 1, true)).toBe("3 submissions in total; the earliest best one is shown.");
  });

  it("says that a closed problem has no leaderboard, whatever is stored", () => {
    expect(leaderboardNote(0, 0, false)).toBe(CLOSED_NOTE);
    expect(leaderboardNote(4, 0, false)).toBe(CLOSED_NOTE);
  });
});
