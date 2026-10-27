/**
 * The board and the dimensions page on a problem without a research record (status no_record): read from the
 * server's answer, its values, its rule (the strict check) and the counts.
 */
import { describe, expect, it } from "vitest";
import type { SpaceDomainInfo } from "@polypack/spaces";
import { NO_RECORD_TEXT, pickFromDomain, problemFacts, readSpaceProblem, ruleOf } from "../src/space/model";
import { domainNote, problemStatus, problemsText, statusLabel, summaryText } from "../src/spaces-model";

const answer = (site: { score: number } | null = null) => ({
  space: "torus",
  id: "torus/sq/0/2",
  fields: { family: "sq", N: 0, P: 2 },
  P: 2,
  status: "no_record",
  certified: null,
  bound: { value: 2.8284271247461903, label: "area bound; a test bound" },
  site_best: site ? { id: 3, score: site.score, name: "ann", created_at: "2026-10-25T00:00:00.000Z" } : null,
  best_score: site ? site.score : null,
  accepts_submissions: true,
  closed_reason: null,
  conventions: {},
  certified_config: null,
  site_config: site
    ? {
        lattice: { L: site.score },
        poses: [
          [0, 0, 0],
          [site.score / 2, site.score / 2, 0],
        ],
      }
    : null,
});

describe("a problem without a research record on the board", () => {
  it("is read with no best packing, and its rule asks the strict check", () => {
    const p = readSpaceProblem("torus", "torus/sq/0/2", answer());
    if (typeof p === "string") throw new Error(p);
    expect(p).toMatchObject({
      status: "no_record",
      certified: null,
      best: null,
      best_score: null,
      accepts_submissions: true,
    });
    expect(ruleOf(p)).toEqual({ bound: 2.8284271247461903, certified: null, noRecord: true });
    const facts = Object.fromEntries(problemFacts(p).map((f) => [f.label, f.value]));
    expect(facts["Certified value"]).toBe("—");
    expect(facts.Status).toBe("no record yet");
    expect(facts.Entries).toBe("open");
    expect(NO_RECORD_TEXT).toBe("No record yet: run the optimizer or submit one.");
  });

  it("starts from the site's entry once there is one", () => {
    const p = readSpaceProblem("torus", "torus/sq/0/2", answer({ score: 3 }));
    if (typeof p === "string") throw new Error(p);
    expect(p.best).toMatchObject({ source: "site", score: 3 });
    expect(p.best_score).toBe(3);
    expect(ruleOf(p).noRecord).toBe(true);
  });
});

describe("the picker of a space with a domain", () => {
  const domain: SpaceDomainInfo = {
    id: "torus/<family>/<N>/<P>",
    fields: [
      { key: "family", label: "Torus", values: ["sq", "hex"], titles: { sq: "Square", hex: "Hexagonal" } },
      { key: "N", label: "Piece (N)", values: ["0", "4"] },
      { key: "P", label: "Pieces (P)", min: 2, max: 60 },
    ],
    problems: 236,
  };

  it("offers every value of the domain, whatever the records, and writes the id from its pattern", () => {
    const pick = pickFromDomain("torus", domain, { family: "hex", N: "4", P: "59" });
    expect(pick.id).toBe("torus/hex/4/59");
    expect(pick.fields.map((f) => f.label)).toEqual(["Torus", "Piece (N)", "Pieces (P)"]);
    expect(pick.fields[0].options).toEqual([
      { value: "sq", text: "Square" },
      { value: "hex", text: "Hexagonal" },
    ]);
    expect(pick.fields[2].options).toHaveLength(59);
    // a P out of range takes the nearest, a value not offered the starting problem's (torus/sq/5/7: sq) or the first
    expect(pickFromDomain("torus", domain, { family: "free", N: "4", P: "500" }).id).toBe("torus/sq/4/60");
    expect(pickFromDomain("torus", domain, {}).id).toBe("torus/sq/0/7");
  });
});

describe("the dimensions page", () => {
  it("counts the problems without a record", () => {
    expect(problemsText({ problems: 693, records: 0 })).toBe("693, none with a record yet");
    expect(problemsText({ problems: 8514, records: 8514 })).toBe("8,514");
    expect(problemsText({ problems: 1000, records: 990 })).toBe("1,000, 10 without a record yet");
    // an older server sends no count of records
    expect(problemsText({ problems: 32 })).toBe("32");
    const row = { ...answer(), status: "no_record" as const };
    expect(statusLabel(problemStatus(row))).toBe("no record yet");
    expect(summaryText([row, row])).toBe("2 problems: 2 without a record yet. No site entries yet.");
    expect(domainNote({ problems: 693, records: 0 })).toBe(
      "No records yet. All 693 problems of this kind are open: choose one on the board, or let the volunteer client search them.",
    );
  });
});

describe("the widened piece domains on the board", () => {
  it("offers N = 0 or 3–100 and P = 1–100 from each real domain", async () => {
    const { SPACE_DOMAINS } = await import("@polypack/spaces");
    for (const space of ["curved", "sphere", "torus"] as const) {
      const domain = SPACE_DOMAINS[space]!.info;
      const pick = pickFromDomain(space, domain, { K: "-1e-06", M: "0", family: "hex", N: "100", P: "100" });
      expect(pick.id).toContain("/100/");
      const ns = pick.fields.find((f) => f.key === "N")!.options.map((o) => o.value);
      expect(ns).toEqual(["0", ...Array.from({ length: 98 }, (_, i) => String(i + 3))]);
      expect(pick.fields.find((f) => f.key === "P")!.options).toHaveLength(100);
      expect(pick.fields.find((f) => f.key === "N")!.value).toBe("100");
      expect(pick.fields.find((f) => f.key === "P")!.value).toBe("100");
    }
  });
});
