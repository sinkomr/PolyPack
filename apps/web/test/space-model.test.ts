/**
 * The board's space mode, its pure parts (apps/web/src/space/model.ts, space-address.ts): the
 * address, the problem picker against the real catalogue, a problem as the server sends it, the
 * rounds of a run, the panel's words and the meaning of the server's answers.
 */
import { SCORE_TIE } from "@polypack/geometry";
import { type SpaceName, spaceProblemSummary, validateSpaceSubmission } from "@polypack/spaces";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { mixSeed, parseSearchProblem } from "@polypack/spaces/search";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BOARD_SPACES, parseSpaceAddress, spaceAddress } from "../src/space-address";
import {
  DEFAULT_PROBLEM,
  FRESH_EVALS,
  ROUND_EVALS,
  ROUND_TIME_CAP,
  defaultBudget,
  roundSize,
  beatsBest,
  fieldsOfId,
  pickProblem,
  problemFacts,
  readSpaceProblem,
  roundJob,
  scoreLabel,
  searchKind,
  submitAnswer,
} from "../src/space/model";

const index = loadSpacesIndex(resolve(__dirname, "../../.."));
const catalogue = (space: SpaceName) => index[space]!;

/** The server's answer for a catalogue problem, with an optional site entry (spaces.ts, GET .../problems/<id>). */
function answer(space: SpaceName, id: string, site?: { score: number; config: unknown }) {
  const p = catalogue(space).byId.get(id)!;
  const summary = spaceProblemSummary(
    p,
    site ? { id: 7, score: site.score, name: "Ada", created_at: "2026-10-24T12:00:00Z" } : null,
  );
  return {
    ...summary,
    conventions: {},
    certified_config: p.config === null ? null : JSON.parse(p.config),
    site_config: site?.config ?? null,
  };
}

describe("the board's address of a space problem", () => {
  it("names a problem or a space, and nothing else", () => {
    expect(parseSpaceAddress("#space=sphere/0/12")).toEqual({ space: "sphere", id: "sphere/0/12" });
    expect(parseSpaceAddress("#space=curved/-1/3/4/5")).toEqual({ space: "curved", id: "curved/-1/3/4/5" });
    expect(parseSpaceAddress("#space=curved%2F1e-06%2F0%2F0%2F5")).toEqual({
      space: "curved",
      id: "curved/1e-06/0/0/5",
    });
    expect(parseSpaceAddress("#space=torus")).toEqual({ space: "torus", id: null });
    expect(parseSpaceAddress("#space=torus/hex/5/8&x=1")).toEqual({ space: "torus", id: "torus/hex/5/8" });
    for (const hash of [
      "",
      "#",
      "#p=4,4,5",
      "#c=abc",
      "#s=12",
      "#space=",
      "#space=planet/1",
      "#x=1&space=sphere",
      "#space=%E0",
    ])
      expect(parseSpaceAddress(hash), hash).toBeNull();
  });

  it("writes what it reads", () => {
    for (const space of BOARD_SPACES) {
      expect(parseSpaceAddress(spaceAddress(space))).toEqual({ space, id: null });
      const id = DEFAULT_PROBLEM[space];
      expect(parseSpaceAddress(spaceAddress(space, id))).toEqual({ space, id });
    }
  });
});

describe("the problem picker", () => {
  it("opens each space on an open problem of its catalogue with room above its bound", () => {
    for (const space of BOARD_SPACES) {
      const p = catalogue(space).byId.get(DEFAULT_PROBLEM[space]);
      expect(p, space).toBeDefined();
      expect(p!.closed_reason, space).toBeNull();
      expect(p!.certified!.score, space).toBeGreaterThan(p!.bound!.value * 1.01);
    }
  });

  it("finds every catalogue problem from its own fields", () => {
    for (const space of BOARD_SPACES) {
      const problems = catalogue(space).problems;
      // every problem of the small spaces, every 7th of the surface
      for (const p of problems.filter((_, i) => space !== "surface" || i % 7 === 0)) {
        const pick = pickProblem(space, problems, fieldsOfId(space, p.id));
        expect(pick.id, p.id).toBe(p.id);
        expect(pick.fields.map((f) => f.value).join("/"), p.id).toBe(p.id.split("/").slice(1).join("/"));
      }
    }
  });

  it("offers only the values that occur with the fields before, and takes the nearest P", () => {
    const problems = ["torus/sq/0/5", "torus/sq/0/7", "torus/sq/4/7", "torus/hex/0/6", "torus/hex/0/9"].map((id) => ({
      id,
    }));
    const hex = pickProblem("torus", problems, { family: "hex" });
    expect(hex.id).toBe("torus/hex/0/6");
    expect(hex.fields.map((f) => f.key)).toEqual(["family", "N", "P"]);
    expect(hex.fields[1].options.map((o) => o.value)).toEqual(["0"]);
    expect(hex.fields[2].options.map((o) => o.value)).toEqual(["6", "9"]);
    expect(hex.fields[0].options.map((o) => o.text)).toEqual(["Square (sq)", "Hexagonal (hex)"]);
    expect(hex.fields.map((f) => f.label)).toEqual(["Torus", "Piece (N)", "Pieces (P)"]);
    // P = 8 is not listed with hexagonal disks: the nearest P is taken
    expect(pickProblem("torus", problems, { family: "hex", N: "0", P: "8" }).id).toBe("torus/hex/0/9");
    // squares exist only on the square torus, with P = 7
    expect(pickProblem("torus", problems, { family: "sq", N: "4", P: "5" }).id).toBe("torus/sq/4/7");
    // an unknown value falls back to the field's starting value
    expect(pickProblem("torus", problems, { family: "triangle" }).id).toBe("torus/sq/0/5");
    expect(pickProblem("torus", [], {})).toEqual({ fields: [], id: null });
  });
});

describe("a problem from the server", () => {
  it("shows the better of the research record and the site entry, the record on a tie", () => {
    const id = "sphere/4/12";
    const rec = catalogue("sphere").byId.get(id)!;
    const cert = rec.certified!.score;
    const config = JSON.parse(rec.config!);
    const alone = readSpaceProblem("sphere", id, answer("sphere", id));
    if (typeof alone === "string") throw new Error(alone);
    expect(alone.best?.source).toBe("certified");
    expect(alone.best?.score).toBe(config.rho);
    expect(alone.best_score).toBe(cert);
    expect(alone.search).toEqual(parseSearchProblem(id));
    expect(alone.accepts_submissions).toBe(true);

    const site = { ...config, rho: config.rho * (1 - 1e-6) };
    const better = readSpaceProblem("sphere", id, answer("sphere", id, { score: site.rho, config: site }));
    if (typeof better === "string") throw new Error(better);
    expect(better.best?.source).toBe("site");
    expect(better.best?.config).toEqual(site);
    expect(better.best_score).toBe(site.rho);
    expect(better.site_best?.name).toBe("Ada");

    const tie = readSpaceProblem("sphere", id, answer("sphere", id, { score: cert, config }));
    if (typeof tie === "string") throw new Error(tie);
    expect(tie.best?.source).toBe("certified");
  });

  it("keeps a closed problem viewable and says why it is closed", () => {
    const proven = readSpaceProblem("sphere", "sphere/0/12", answer("sphere", "sphere/0/12"));
    if (typeof proven === "string") throw new Error(proven);
    expect(proven.accepts_submissions).toBe(false);
    expect(proven.best).not.toBeNull();
    const facts = Object.fromEntries(problemFacts(proven).map((f) => [f.label, f]));
    expect(facts.Status.value).toBe("proven optimal");
    expect(facts.Entries.value).toBe("closed");
    expect(facts.Entries.note).toMatch(/^Its optimum 1\.806442 is proven/);

    const none = catalogue("curved").problems.find((p) => p.status === "infeasible")!;
    const infeasible = readSpaceProblem("curved", none.id, answer("curved", none.id));
    if (typeof infeasible === "string") throw new Error(infeasible);
    expect(infeasible.best).toBeNull();
    expect(infeasible.certified).toBeNull();
    expect(problemFacts(infeasible).map((f) => f.value)).toEqual(
      expect.arrayContaining(["—", "no packing exists", "closed"]),
    );
  });

  it("names the values as the spaces page does", () => {
    const p = readSpaceProblem("torus", "torus/sq/5/7", answer("torus", "torus/sq/5/7"));
    if (typeof p === "string") throw new Error(p);
    expect(problemFacts(p).map((f) => f.label)).toEqual([
      "Certified value",
      "Status",
      "Lower bound",
      "Site best",
      "Entries",
    ]);
    const facts = Object.fromEntries(problemFacts(p).map((f) => [f.label, f]));
    expect(facts["Certified value"].value).toBe(p.certified!.display);
    expect(facts["Lower bound"].value).toBe(p.bound!.value.toFixed(6));
    expect(facts["Site best"].value).toBe("—");
    expect(facts.Entries.value).toBe("open");
    expect(scoreLabel(p.search)).toBe("Torus side L");
    expect(scoreLabel(parseSearchProblem("curved/-1/0/0/5")!)).toBe("Container radius r");
    expect(scoreLabel(parseSearchProblem("torus/free/0/5")!)).toBe("Cell √|det(b1, b2)|");
  });

  it("refuses an answer that is not the problem or is malformed, and drops a malformed configuration", () => {
    const id = "torus/sq/5/7";
    const good = answer("torus", id);
    expect(readSpaceProblem("torus", "torus/sq/5/8", good)).toMatch(/not this problem/);
    expect(readSpaceProblem("torus", id, null)).toMatch(/not this problem/);
    expect(readSpaceProblem("torus", id, { ...good, accepts_submissions: "yes" })).toMatch(/malformed/);
    expect(readSpaceProblem("torus", id, { ...good, certified: { score: -1 } })).toMatch(/certified/);
    expect(readSpaceProblem("torus", id, { ...good, site_best: { id: 1.5, score: 3 } })).toMatch(/site best/);
    const bad = readSpaceProblem("torus", id, { ...good, certified_config: { lattice: { L: 3 }, poses: [[0, 0]] } });
    if (typeof bad === "string") throw new Error(bad);
    expect(bad.best).toBeNull();
  });

  it("counts a score as better only beyond the tie tolerance", () => {
    const p = readSpaceProblem("sphere", "sphere/4/12", answer("sphere", "sphere/4/12"));
    if (typeof p === "string") throw new Error(p);
    const best = p.best_score!;
    expect(beatsBest(p, best)).toBe(false);
    expect(beatsBest(p, best * (1 - SCORE_TIE / 2))).toBe(false);
    expect(beatsBest(p, best * (1 - 2 * SCORE_TIE))).toBe(true);
  });
});

describe("the rounds of a run", () => {
  const p = parseSearchProblem("sphere/4/12")!;
  const rule = { bound: 1, certified: 1.2 };
  const start = { rho: 2, pieces: [] };

  it("seeds each round from the run's seed, starts from the best and caps its evaluations", () => {
    const run = { seed: 7, budget: { evals: 5000, time_s: 10 }, fresh: false };
    const a = roundJob(p, rule, run, 0, { evals: 0, seconds: 0 }, start)!;
    expect(a.evals).toBe(ROUND_EVALS.sphere);
    expect(a.job).toMatchObject({
      space: "sphere",
      id: "sphere/4/12",
      seed: mixSeed(7, 0),
      budget: { evals: ROUND_EVALS.sphere, time_s: 10 },
      kind: "iterate",
      start,
      rule,
    });
    const b = roundJob(p, rule, run, 2, { evals: 4000, seconds: 9.5 }, start)!;
    expect(b.job.seed).toBe(mixSeed(7, 2));
    expect(b.job.budget).toEqual({ evals: 1000, time_s: 0.5 });
    // nothing is left for another round
    expect(roundJob(p, rule, run, 3, { evals: 5000, seconds: 1 }, start)).toBeNull();
  });

  it("gives a round without a start the work to build a packing, doubled after each one that found none", () => {
    const run = { seed: 7, budget: { evals: 100000 }, fresh: true };
    const c = roundJob(p, rule, run, 1, { evals: 0, seconds: 99 }, null)!;
    // without a time limit a round ends on its evaluations
    expect(c.job.budget).toEqual({ evals: FRESH_EVALS.sphere, time_s: ROUND_TIME_CAP });
    expect(c.job.kind).toBe("fresh");
    expect(c.job.start).toBeUndefined();
    expect(roundJob(p, rule, run, 2, { evals: 0, seconds: 0 }, null, 2)!.evals).toBe(4 * FRESH_EVALS.sphere);
    // never more than the budget left
    expect(roundJob(p, rule, run, 2, { evals: 99000, seconds: 0 }, null, 2)!.evals).toBe(1000);
  });

  it("asks a fold job for its hops, so that a round's compressions are the round's evaluations", () => {
    const fold = parseSearchProblem("surface/cube/fold/0/10")!;
    const run = { seed: 1, budget: { evals: 40 }, fresh: false };
    const warm = roundJob(fold, rule, run, 0, { evals: 0, seconds: 0 }, { s: 3, pieces: [] })!;
    // the start's compression and 3 hops
    expect(warm.evals).toBe(4);
    expect(warm.job.budget.evals).toBe(3);
    const fresh = roundJob(fold, rule, run, 0, { evals: 0, seconds: 0 }, null)!;
    // two random starts and 2 hops
    expect(fresh.evals).toBe(FRESH_EVALS.surface);
    expect(fresh.job.budget.evals).toBe(FRESH_EVALS.surface - 2);
    // one evaluation left: a warm round compresses its start only; a fresh one needs two
    expect(roundJob(fold, rule, run, 9, { evals: 39, seconds: 0 }, { s: 3, pieces: [] })!.job.budget.evals).toBe(0);
    expect(roundJob(fold, rule, run, 9, { evals: 39, seconds: 0 }, null)).toBeNull();
    // large solids get shorter rounds, and fewer evaluations by default
    const large = parseSearchProblem("surface/icosahedron/fold/3/80")!;
    expect(roundSize(large)).toBe(2);
    expect(defaultBudget(large)).toEqual({ time_s: 60, evals: 8 });
    expect(defaultBudget(fold)).toEqual({ time_s: 60, evals: 40 });
    expect(defaultBudget(parseSearchProblem("surface/dodecahedron/fold/5/30")!).evals).toBe(16);
  });

  it("has a search for every kind of problem", () => {
    expect(searchKind(parseSearchProblem("surface/cube/nofold/4/12")!)).toBe("nofold");
    expect(searchKind(parseSearchProblem("surface/cube/fold/4/12")!)).toBe("surface");
    expect(
      roundJob(
        parseSearchProblem("surface/cube/nofold/4/12")!,
        rule,
        { seed: 1, budget: { evals: 9e9 }, fresh: true },
        0,
        { evals: 0, seconds: 0 },
        null,
      )!.job.method,
    ).toBe("surface nofold: basin hopping on one face");
  });
});

describe("the server's answer to a submission", () => {
  it("says whether the entry was kept, and why not", () => {
    expect(
      submitAnswer(200, {
        valid: true,
        score: 1.5,
        leader: true,
        id: 4,
        best_score: 1.5,
        beats_certified: true,
        reasons: [],
      }),
    ).toEqual({
      kind: "kept",
      text: "✓ Kept. Server score 1.500000. This is now the best entry for this problem. It beats the research record.",
    });
    expect(
      submitAnswer(200, { valid: true, score: 1.5, leader: false, id: null, best_score: 1.4, reasons: [] }),
    ).toEqual({
      kind: "not-kept",
      text: `✓ Valid, score 1.500000, but not kept: it does not beat the problem's best 1.400000 by more than a relative ${SCORE_TIE}.`,
    });
    expect(submitAnswer(409, { valid: false, reasons: ["this problem is closed: its optimum is proven"] })).toEqual({
      kind: "closed",
      text: "✗ This problem takes no entries: this problem is closed: its optimum is proven.",
    });
    expect(submitAnswer(422, { valid: false, reasons: ["pieces 1 and 2 overlap by 0.1"] }).text).toBe(
      "✗ Not accepted: pieces 1 and 2 overlap by 0.1.",
    );
    expect(submitAnswer(400, { valid: false, reasons: ["name is required"] }).kind).toBe("invalid");
    expect(
      submitAnswer(429, { valid: false, reasons: ["too many submissions from this address; wait a minute"] }),
    ).toEqual({
      kind: "busy",
      text: "✗ Too many submissions from this address; wait a minute. Nothing was stored; try again later.",
    });
    expect(submitAnswer(503, null).kind).toBe("busy");
    expect(submitAnswer(null, null).text).toBe("✗ The server could not be reached. Nothing was stored.");
    expect(submitAnswer(500, "oops").text).toBe("✗ The server answered 500.");
  });

  it("is consistent with the server's own check of a research record", () => {
    // the shown record passes the rule the page applies before it offers a result
    const p = readSpaceProblem("sphere", "sphere/4/12", answer("sphere", "sphere/4/12"));
    if (typeof p === "string") throw new Error(p);
    const v = validateSpaceSubmission("sphere", p.id, p.best!.config, {
      bound: p.bound!.value,
      certified: p.certified!.score,
    });
    expect(v.valid).toBe(true);
  });
});
