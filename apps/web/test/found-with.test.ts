import { describe, expect, it } from "vitest";
import {
  Attribution,
  BoardChange,
  HAND,
  RunInfo,
  attributionAfter,
  foundWithLabel,
  readRun,
  submissionFields,
} from "../src/found-with";

const asc: RunInfo = { method: "asc", params: { sweeps: 10 }, seed: 1, budget: { evals: 100 } };
const mc: RunInfo = { method: "mc_compress", seed: 7, budget: { evals: 100, time_s: 5 } };
const optimizer: Attribution = { found_with: "optimizer", run: asc };
const edited: Attribution = { found_with: "optimizer_edited", run: asc };

const after = (
  change: BoardChange,
  previous: Attribution,
  extra: { accepted?: RunInfo; recorded?: Attribution; empty?: boolean } = {},
) => attributionAfter({ change, previous, empty: false, ...extra });

describe("found with: the board's attribution", () => {
  it("is the optimizer exactly while the board is an accepted result, whatever the change", () => {
    for (const change of ["edit", "load", "history"] as const) {
      expect(after(change, HAND, { accepted: asc })).toEqual(optimizer);
      expect(after(change, edited, { accepted: mc, recorded: edited })).toEqual({ found_with: "optimizer", run: mc });
    }
  });

  it("turns an edit of an optimizer board into an edited one, with the same run", () => {
    expect(after("edit", optimizer)).toEqual(edited);
    expect(after("edit", edited)).toEqual(edited);
    expect(after("edit", { found_with: "optimizer_edited", run: mc })).toEqual({
      found_with: "optimizer_edited",
      run: mc,
    });
  });

  it("keeps a hand-made board hand-made", () => {
    expect(after("edit", HAND)).toEqual(HAND);
    // even when the same pieces were once an edited board: an edit goes by what it started from
    expect(after("edit", HAND, { recorded: edited })).toEqual(HAND);
  });

  it("starts over with a load from elsewhere and with an empty board", () => {
    expect(after("load", optimizer)).toEqual(HAND);
    expect(after("load", edited, { recorded: edited })).toEqual(HAND);
    expect(after("edit", optimizer, { empty: true })).toEqual(HAND);
    expect(after("history", edited, { recorded: edited, empty: true })).toEqual(HAND);
  });

  it("returns through the history to what each board was", () => {
    expect(after("history", HAND, { recorded: edited })).toEqual(edited);
    expect(after("history", optimizer)).toEqual(HAND);
    expect(after("history", edited)).toEqual(HAND);
  });
});

describe("found with: what is submitted", () => {
  it("sends found_with alone for a hand-made board", () => {
    expect(submissionFields(HAND)).toEqual({ found_with: "hand" });
  });

  it("sends the run of an optimizer board and of an edited one", () => {
    expect(submissionFields(optimizer)).toEqual({
      found_with: "optimizer",
      method: "asc",
      method_params: { sweeps: 10 },
      seed: 1,
      budget: { evals: 100 },
    });
    expect(submissionFields({ found_with: "optimizer_edited", run: mc })).toEqual({
      found_with: "optimizer_edited",
      method: "mc_compress",
      seed: 7,
      budget: { evals: 100, time_s: 5 },
    });
  });

  it("leaves out parameters larger than the server accepts", () => {
    const big = { ...asc, params: { record: "x".repeat(5000) } };
    const fields = submissionFields({ found_with: "optimizer", run: big });
    expect(fields).not.toHaveProperty("method_params");
    expect(fields).toMatchObject({ found_with: "optimizer", method: "asc", seed: 1 });
  });

  it("labels each value for the listings, and nothing when it was not recorded", () => {
    expect(foundWithLabel("hand")).toBe("by hand");
    expect(foundWithLabel("optimizer")).toBe("PolyPack optimizer");
    expect(foundWithLabel("optimizer_edited")).toBe("optimizer, then edited");
    expect(foundWithLabel("external")).toBe("own software");
    expect(foundWithLabel(null)).toBe("");
    expect(foundWithLabel(undefined)).toBe("");
  });
});

describe("found with: stored runs", () => {
  it("reads runs, and the notes older pages stored", () => {
    expect(readRun(asc)).toEqual(asc);
    expect(readRun('asc; seed 1; budget {"evals":100}')).toEqual({ method: "asc", seed: 1, budget: { evals: 100 } });
    expect(readRun('mc_compress; seed 7; budget {"evals":100,"time_s":5}')).toEqual(mc);
    // a note cut short keeps what it has
    expect(readRun('asc; seed 3; budget {"evals":1')).toEqual({ method: "asc", seed: 3 });
  });

  it("drops what the server would refuse", () => {
    for (const bad of [null, 3, [], {}, { method: 4 }, { method: "Robert'); DROP" }, "free text"])
      expect(readRun(bad)).toBeUndefined();
    expect(readRun({ method: "asc", seed: -1, params: [1], budget: { evals: 0, time_s: "5", extra: 1 } })).toEqual({
      method: "asc",
    });
    expect(readRun({ method: "asc", budget: { evals: 10, time_s: 2, steps: 3 } })).toEqual({
      method: "asc",
      budget: { evals: 10, time_s: 2 },
    });
  });
});
