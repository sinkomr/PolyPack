// Fix 2: answers from the server are untrusted; malformed ones are refused, never trusted.
import { describe, expect, it } from "vitest";
import {
  cleanText,
  readPieces,
  readProblemInfo,
  readStoredEntry,
  readSubmitResponse,
  readTarget,
} from "../src/validate";

const p = { N: 4, M: 4, P: 2 };
const pieces = [
  { x: 0, y: 0, theta: 0.5 },
  { x: 1, y: 0, theta: 0.5 },
];
const goodInfo = {
  ...p,
  conventions: {},
  area_bound: 1.5,
  literature: { value: 2.1, display: "2.1", status: "best_known", pieces, container_phi: 0 },
  site_best: { id: 7, name: "Ada", score: 2.2, found_with: "optimizer" },
  accepts_submissions: true,
};

describe("reading the server's answers", () => {
  it("accepts a well-formed problem", () => {
    const info = readProblemInfo(goodInfo, p)!;
    expect(info.site_best).toMatchObject({ id: 7, name: "Ada", score: 2.2 });
    expect(info.literature).toMatchObject({ value: 2.1, pieces, container_phi: 0 });
  });

  it("refuses a problem whose leader or bound is malformed", () => {
    for (const site_best of [
      { id: 7, name: "Ada" },
      { id: 7, score: "2.2" },
      { id: "7", score: 2.2 },
      { score: NaN },
      5,
    ])
      expect(readProblemInfo({ ...goodInfo, site_best }, p), JSON.stringify(site_best)).toBeNull();
    expect(readProblemInfo({ ...goodInfo, area_bound: "1.5" }, p)).toBeNull();
    expect(readProblemInfo({ ...goodInfo, accepts_submissions: "yes" }, p)).toBeNull();
    expect(readProblemInfo({ ...goodInfo, P: 3 }, p)).toBeNull();
    expect(readProblemInfo("<html>", p)).toBeNull();
    expect(readProblemInfo(null, p)).toBeNull();
  });

  it("drops only a malformed published value or published coordinates", () => {
    expect(
      readProblemInfo({ ...goodInfo, literature: { ...goodInfo.literature, value: "2.1" } }, p)!.literature,
    ).toBeNull();
    for (const bad of ["pieces", [null, pieces[1]], [pieces[0]], [{ x: 0, y: "0", theta: 0 }, pieces[1]]]) {
      const info = readProblemInfo({ ...goodInfo, literature: { ...goodInfo.literature, pieces: bad } }, p)!;
      expect(info.literature?.value).toBe(2.1);
      expect(info.literature?.pieces).toBeUndefined();
    }
  });

  it("reads pieces as P poses of finite numbers, a missing theta being 0", () => {
    expect(
      readPieces(
        [
          { x: 1, y: 2 },
          { x: 3, y: 4, theta: 1 },
        ],
        2,
      ),
    ).toEqual([
      { x: 1, y: 2, theta: 0 },
      { x: 3, y: 4, theta: 1 },
    ]);
    expect(readPieces([{ x: 1, y: Infinity }, pieces[1]], 2)).toBeNull();
    expect(readPieces(pieces, 3)).toBeNull();
  });

  it("refuses a stored entry without valid pieces", () => {
    expect(readStoredEntry({ score: 2.2, pieces, container_phi: null }, 2)).toEqual({
      score: 2.2,
      pieces,
      container_phi: 0,
    });
    expect(readStoredEntry({ score: 2.2, pieces: null }, 2)).toBeNull();
    expect(readStoredEntry({ score: 2.2, pieces: [null, null] }, 2)).toBeNull();
    expect(readStoredEntry({ score: "2.2", pieces }, 2)).toBeNull();
    expect(readStoredEntry({ score: 2.2, pieces, container_phi: "0" }, 2)).toBeNull();
  });

  it("reads work list entries, refusing malformed ones", () => {
    const t = {
      N: 4,
      M: 4,
      P: 2,
      reason: "slack",
      priority: 3,
      leader: 2,
      leader_id: 7,
      published: null,
      area_bound: 1,
    };
    expect(readTarget(t)).toMatchObject({ N: 4, P: 2, priority: 3, leader_id: 7 });
    expect(readTarget({ ...t, leader_id: "7" })).toMatchObject({ leader_id: null, leader: null });
    for (const bad of [
      { ...t, N: 2 },
      { ...t, P: 0 },
      { ...t, P: 1.5 },
      { ...t, priority: NaN },
      { ...t, priority: "3" },
      null,
    ])
      expect(readTarget(bad)).toBeNull();
  });

  it("reads a submission's answer", () => {
    expect(
      readSubmitResponse({ valid: true, leader: true, id: 9, score: 2, leader_score: "x", reasons: ["a\u001b[31mb"] }),
    ).toEqual({
      valid: true,
      leader: true,
      score: 2,
      leader_score: null,
      id: 9,
      pending_verification: false,
      reasons: ["ab"],
    });
    expect(readSubmitResponse("Bad Gateway")).toBeNull();
  });
});

// Fix 9: names and reasons from the server must not drive the terminal.
describe("text from the server", () => {
  it("loses escape sequences and control characters, on one line, capped", () => {
    expect(cleanText("\u001b[2J\u001b[31mred\u001b[0m name")).toBe("red name");
    expect(cleanText("\u001b]0;title\u0007tab\there\r\nnext")).toBe("tab here next");
    expect(cleanText("a‮b\u0000c")).toBe("a b c");
    expect(cleanText("x".repeat(300), 10)).toBe("xxxxxxxxx…");
    expect(cleanText(undefined)).toBe("");
  });
});
