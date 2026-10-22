import { MAX_METHOD_PARAMS_BYTES, type ProblemInfo, SCORE_TIE, parseProvenance } from "@polypack/geometry";
import { describe, expect, it } from "vitest";
import {
  SOFTWARE_REFUSAL,
  better,
  buildKnown,
  checkStored,
  decideSubmission,
  isSoftwareRefusal,
  storedName,
  submissionBody,
} from "../src/submit";
import type { Candidate } from "../src/types";
import { SOFTWARE } from "../src/version";

const problem = { N: 4, M: 4, P: 2 };
const pieces = [
  { x: 0, y: 0, theta: Math.PI / 4 },
  { x: 1, y: 0, theta: Math.PI / 4 },
];

function candidate(score: number, extra: Partial<Candidate> = {}): Candidate {
  return {
    config: { ...problem, pieces, container_phi: 0 },
    score,
    strict: true,
    job: { problem, method: "harden", seed: 4242, budget: { time_s: 30, evals: 50000 }, kind: "warm" },
    params: { restarts: 3, pressure: 0.5 },
    ...extra,
  };
}

describe("the submission decision", () => {
  const leader = 2.1;
  it("submits a strict packing that beats the leader, or any when there is none", () => {
    expect(decideSubmission({ best: candidate(2), open: true, leader, dryRun: false })).toEqual({
      submit: true,
      reason: "better than the leader",
    });
    expect(decideSubmission({ best: candidate(2), open: true, leader: null, dryRun: false }).submit).toBe(true);
  });

  it("needs a strict packing", () => {
    expect(decideSubmission({ best: null, open: true, leader, dryRun: false })).toMatchObject({ submit: false });
    const loose = candidate(2, { strict: false });
    expect(decideSubmission({ best: loose, open: true, leader, dryRun: false })).toMatchObject({ submit: false });
  });

  it("needs an open problem", () => {
    expect(decideSubmission({ best: candidate(2), open: false, leader, dryRun: false })).toEqual({
      submit: false,
      reason: "the problem is closed",
    });
  });

  it("needs a margin beyond the server's tie tolerance", () => {
    const tie = leader * (1 - SCORE_TIE / 2);
    expect(decideSubmission({ best: candidate(tie), open: true, leader, dryRun: false })).toEqual({
      submit: false,
      reason: "not better than the leader",
    });
    expect(decideSubmission({ best: candidate(leader), open: true, leader, dryRun: false }).submit).toBe(false);
    const clear = leader * (1 - 2 * SCORE_TIE);
    expect(decideSubmission({ best: candidate(clear), open: true, leader, dryRun: false }).submit).toBe(true);
  });

  it("only says what it would do in a dry run", () => {
    expect(decideSubmission({ best: candidate(2), open: true, leader, dryRun: true })).toEqual({
      submit: false,
      reason: "dry run: would submit",
    });
  });

  it("prefers the better strict candidate", () => {
    const a = candidate(2.0);
    const b = candidate(1.9);
    expect(better(a, b)).toBe(b);
    expect(better(b, a)).toBe(b);
    expect(better(a, candidate(2.0))).toBe(a);
    expect(better(null, a)).toBe(a);
    expect(better(candidate(1, { strict: false }), a)).toBe(a);
    expect(better(null, null)).toBeNull();
  });
});

describe("the request body", () => {
  it("carries the packing, the name and how it was found", () => {
    const body = submissionBody(candidate(2), { name: "Ada", note: "spare laptop", software: SOFTWARE });
    expect(body).toEqual({
      N: 4,
      M: 4,
      P: 2,
      pieces,
      container_phi: 0,
      name: "Ada",
      agent_note: "spare laptop",
      found_with: "optimizer",
      method: "harden",
      method_params: { restarts: 3, pressure: 0.5 },
      seed: 4242,
      budget: { time_s: 30, evals: 50000 },
      software: SOFTWARE,
    });
    expect(SOFTWARE).toMatch(/^polypack-volunteer\/\d+\.\d+\.\d+$/);
  });

  it("is what the server's own provenance check accepts, with `software` and without it", () => {
    const withSoftware = submissionBody(candidate(2), { name: "Ada", note: "", software: SOFTWARE });
    expect(parseProvenance(withSoftware, ["harden"])).toMatchObject({ ok: true });
    const { software: _s, ...body } = withSoftware;
    expect(parseProvenance(body, ["harden"])).toMatchObject({ ok: true });
    // servers from before 2026-10-22 refused `software` on optimizer entries with these words
    expect(isSoftwareRefusal(400, { reasons: [SOFTWARE_REFUSAL] })).toBe(true);
    expect(SOFTWARE_REFUSAL).toBe('software needs found_with "external"');
  });

  it("leaves out an empty note, the software when asked, and a budget without evals keeps time_s only", () => {
    const c = candidate(2);
    c.job = { ...c.job, budget: { time_s: 12.5 } };
    const body = submissionBody(c, { name: "Ada", note: "", software: null });
    expect(body).not.toHaveProperty("agent_note");
    expect(body).not.toHaveProperty("software");
    expect(body.budget).toEqual({ time_s: 12.5 });
  });

  it("sends method_params only within the server's size limit", () => {
    // {"k":"..."} is 8 bytes plus the string
    const exact = { k: "x".repeat(MAX_METHOD_PARAMS_BYTES - 8) };
    expect(JSON.stringify(exact).length).toBe(MAX_METHOD_PARAMS_BYTES);
    expect(submissionBody(candidate(2, { params: exact }), { name: "A", note: "", software: null }).method_params).toBe(
      exact,
    );
    const over = { k: "x".repeat(MAX_METHOD_PARAMS_BYTES - 7) };
    expect(submissionBody(candidate(2, { params: over }), { name: "A", note: "", software: null })).not.toHaveProperty(
      "method_params",
    );
    // multi-byte characters count in UTF-8 bytes, as the server counts them
    const wide = { k: "é".repeat((MAX_METHOD_PARAMS_BYTES - 8) / 2 + 1) };
    expect(submissionBody(candidate(2, { params: wide }), { name: "A", note: "", software: null })).not.toHaveProperty(
      "method_params",
    );
    expect(
      submissionBody(candidate(2, { params: undefined }), { name: "A", note: "", software: null }),
    ).not.toHaveProperty("method_params");
  });

  it("recognises exactly the refusal of `software`", () => {
    expect(isSoftwareRefusal(400, { valid: false, reasons: [SOFTWARE_REFUSAL] })).toBe(true);
    expect(isSoftwareRefusal(400, { valid: false, reasons: ["name is required"] })).toBe(false);
    expect(isSoftwareRefusal(422, { valid: false, reasons: [SOFTWARE_REFUSAL] })).toBe(false);
    expect(isSoftwareRefusal(400, "Bad Request")).toBe(false);
  });
});

describe("the starting packing", () => {
  const leaderEntry = { score: 2.2, pieces, container_phi: 0.1 };
  const info = (literature: ProblemInfo["literature"]): ProblemInfo => ({
    ...problem,
    conventions: {},
    area_bound: Math.SQRT2,
    literature,
    site_best: null,
    accepts_submissions: true,
  });
  const lit = (value: number, withPieces: boolean): ProblemInfo["literature"] => ({
    ...problem,
    value,
    display: String(value),
    display_precision: 6,
    status: "best_known",
    source_name: "test",
    source_url: "",
    accessed: "2026-01-01",
    conversion_note: "",
    ...(withPieces ? { pieces: pieces.map((p) => ({ ...p, x: p.x + 5 })), container_phi: 0 } : {}),
  });

  it("is the leader's packing when it is at least as good as the published one", () => {
    expect(buildKnown(info(null), leaderEntry)).toMatchObject({ score: 2.2, source: "site" });
    expect(buildKnown(info(lit(2.2, true)), leaderEntry)).toMatchObject({ source: "site" });
    expect(buildKnown(info(lit(2.0, false)), leaderEntry)).toMatchObject({ source: "site" });
  });

  it("is the published packing when it is better, or when there is no leader", () => {
    const k = buildKnown(info(lit(2.0, true)), leaderEntry)!;
    expect(k).toMatchObject({ score: 2.0, source: "literature" });
    expect(k.config.pieces[0].x).toBe(5);
    expect(buildKnown(info(lit(2.5, true)), null)).toMatchObject({ score: 2.5, source: "literature" });
  });

  it("is nothing without coordinates, or with the wrong number of pieces", () => {
    expect(buildKnown(info(lit(2.0, false)), null)).toBeUndefined();
    expect(buildKnown(info(null), { ...leaderEntry, pieces: pieces.slice(1) })).toBeUndefined();
  });
});

// Fix 1: after a POST without an answer, the re-read decides whether it was stored.
describe("recognising our own stored entry", () => {
  const info = (site_best: { id: number; name: string; score: number } | null, open = true): ProblemInfo => ({
    ...problem,
    conventions: {},
    area_bound: Math.SQRT2,
    literature: null,
    site_best: site_best && {
      ...site_best,
      found_with: "optimizer",
      agent_note: "",
      created_at: "2026-10-21T00:00:00Z",
      verification: "none",
    },
    accepts_submissions: open,
  });

  it("finds it by name and score within the tie tolerance", () => {
    expect(checkStored(info({ id: 9, name: "Ada", score: 2 * (1 + SCORE_TIE / 2) }), "Ada", 2)).toEqual({
      state: "ours",
      id: 9,
      score: 2 * (1 + SCORE_TIE / 2),
    });
    // the server stores names cleaned: control characters and angle brackets become spaces
    expect(checkStored(info({ id: 9, name: "Ada L", score: 2 }), "  Ada\u0007<L> ", 2).state).toBe("ours");
    expect(storedName("a\tb  <c>")).toBe("a b c");
  });

  it("is not ours with another name or another score", () => {
    expect(checkStored(info({ id: 9, name: "Bob", score: 2 }), "Ada", 2)).toEqual({ state: "beaten", leader: 2 });
    expect(checkStored(info({ id: 9, name: "Ada", score: 1.9 }), "Ada", 2)).toEqual({ state: "beaten", leader: 1.9 });
    expect(checkStored(info({ id: 9, name: "Ada", score: 2.5 }), "Ada", 2)).toEqual({ state: "absent" });
    expect(checkStored(info(null), "Ada", 2)).toEqual({ state: "absent" });
    expect(checkStored(info(null, false), "Ada", 2)).toEqual({ state: "closed" });
  });
});
