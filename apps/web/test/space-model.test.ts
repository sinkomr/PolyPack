/**
 * The board's space mode, its pure parts (apps/web/src/space/model.ts, space-address.ts): the
 * address, the problem picker against the real catalogue, a problem as the server sends it, the
 * rounds of a run, the panel's words and the meaning of the server's answers.
 */
import { SCORE_TIE } from "@polypack/geometry";
import { PROBLEM_CODES } from "@polypack/polyhedra/catalogue";
import { type SpaceName, SPACE_RECORD_MARGIN, spaceProblemSummary, validateSpaceSubmission } from "@polypack/spaces";
import { loadSpacesIndex, readEntryConfigSync } from "@polypack/spaces/load";
import { BOUNDARY_ROUND_EVALS, mixSeed, parseSearchProblem } from "@polypack/spaces/search";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { gainText } from "../src/boundary-model";
import { BOARD_SPACES, parseSpaceAddress, spaceAddress } from "../src/space-address";
import {
  DEFAULT_PROBLEM,
  EVALS_MAX,
  FRESH_EVALS,
  GROW_LIMIT,
  ROUND_EVALS,
  ROUND_TIME_CAP,
  defaultBudget,
  freshSize,
  ballsRound,
  polyhedraRound,
  polyhedraRoundSeconds,
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

const root = resolve(__dirname, "../../..");
const index = loadSpacesIndex(root);
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
    // polyhedra configurations are kept apart and read on demand, as the server reads them
    certified_config: (() => {
      const c = readEntryConfigSync(root, catalogue(space), p);
      return c === null ? null : JSON.parse(c);
    })(),
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
      // every problem of the small spaces, every 7th of the surface and the polyhedra
      for (const p of problems.filter((_, i) => (space !== "surface" && space !== "polyhedra") || i % 7 === 0)) {
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
    const run = { seed: 7, budget: { evals: 50000, time_s: 10 }, fresh: false };
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
    const b = roundJob(p, rule, run, 2, { evals: 49000, seconds: 9.5 }, start)!;
    expect(b.job.seed).toBe(mixSeed(7, 2));
    expect(b.job.budget).toEqual({ evals: 1000, time_s: 0.5 });
    // nothing is left for another round
    expect(roundJob(p, rule, run, 3, { evals: 50000, seconds: 1 }, start)).toBeNull();
    // rounds that got nowhere double the next one, up to GROW_LIMIT times
    const long = { ...run, budget: { evals: 1e6 } };
    expect(roundJob(p, rule, long, 1, { evals: 0, seconds: 0 }, start, 1)!.evals).toBe(2 * ROUND_EVALS.sphere);
    expect(roundJob(p, rule, long, 9, { evals: 0, seconds: 0 }, start, 9)!.evals).toBe(
      GROW_LIMIT.sphere * ROUND_EVALS.sphere,
    );
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

describe("3D on 4D on the board", () => {
  const id = DEFAULT_PROBLEM.boundary;

  it("reads a boundary problem with its nofold comparison, and lists it with the usual values", () => {
    const p = readSpaceProblem("boundary", id, answer("boundary", id));
    if (typeof p === "string") throw new Error(p);
    expect(p.search).toEqual({ space: "boundary", id, P: 9, polytope: "tesseract", piece: "ball" });
    expect(p.best?.source).toBe("certified");
    expect(p.extra?.nofold?.value).toBeCloseTo(2 + 2 / Math.sqrt(3), 12);
    expect(scoreLabel(p.search)).toBe("Tesseract edge s");
    expect(problemFacts(p).map((f) => f.label)).toEqual([
      "Certified value",
      "Status",
      "Lower bound",
      "Without folding",
      "Folding gains",
      "Site best",
      "Entries",
    ]);
    const facts = Object.fromEntries(problemFacts(p).map((f) => [f.label, f]));
    expect(facts["Without folding"]).toMatchObject({ value: "3.154701", details: true });
    expect(facts["Folding gains"]).toMatchObject({
      value: gainText(1 - p.best_score! / p.extra!.nofold!.value),
      note: "shorter edge than without folding",
    });
    // the shown record passes the rule the page applies before it offers a result
    const v = validateSpaceSubmission("boundary", id, p.best!.config, {
      bound: p.bound!.value,
      certified: p.certified!.score,
    });
    expect(v.valid, v.reasons.join("; ")).toBe(true);

    // the other kinds have no such values; a malformed extra is left out
    const torus = readSpaceProblem("torus", "torus/sq/5/7", answer("torus", "torus/sq/5/7"));
    if (typeof torus === "string") throw new Error(torus);
    expect(torus.extra).toBeNull();
    const odd = readSpaceProblem("boundary", id, { ...answer("boundary", id), extra: { nofold: "x" } });
    if (typeof odd === "string") throw new Error(odd);
    expect(odd.extra).toBeNull();
    expect(Object.fromEntries(problemFacts(odd).map((f) => [f.label, f.value]))["Folding gains"]).toBe("—");
  });

  it("runs the boundary search in rounds of its own size", () => {
    const p = parseSearchProblem(id)!;
    const rule = { bound: 1.6, certified: 2.2 };
    const start = { s: 2.3, pieces: [] };
    const run = { seed: 3, budget: { evals: 1000000, time_s: 30 }, fresh: false };
    const a = roundJob(p, rule, run, 0, { evals: 0, seconds: 0 }, start)!;
    expect(a.evals).toBe(ROUND_EVALS.boundary);
    // one complete search call per round, of the job runner's size, growing to at most 1,000,000
    expect(ROUND_EVALS.boundary).toBe(BOUNDARY_ROUND_EVALS);
    expect(FRESH_EVALS.boundary).toBe(BOUNDARY_ROUND_EVALS);
    expect(ROUND_EVALS.boundary * GROW_LIMIT.boundary).toBeLessThanOrEqual(1_000_000);
    const long = { ...run, budget: { evals: 1e8 } };
    expect(roundJob(p, rule, long, 5, { evals: 0, seconds: 0 }, start, 5)!.evals).toBe(
      GROW_LIMIT.boundary * BOUNDARY_ROUND_EVALS,
    );
    expect(a.job).toMatchObject({ space: "boundary", id, method: "boundary compression search", kind: "iterate" });
    expect(roundJob(p, rule, { ...run, fresh: true }, 0, { evals: 0, seconds: 0 }, null)!.evals).toBe(
      FRESH_EVALS.boundary,
    );
    expect(defaultBudget(p).time_s).toBe(30);
    expect(defaultBudget(p).evals).toBeGreaterThanOrEqual(ROUND_EVALS.boundary);
    expect(searchKind(p)).toBe("boundary");
    // its evaluations are cheap, so the panel takes more of them
    expect(EVALS_MAX.boundary).toBe(100_000_000);
  });

  it("starts every kind with a budget the panel accepts", () => {
    for (const space of BOARD_SPACES) {
      const p = parseSearchProblem(DEFAULT_PROBLEM[space])!;
      const kind = searchKind(p);
      expect(defaultBudget(p).evals, space).toBeLessThanOrEqual(EVALS_MAX[kind]);
      expect(ROUND_EVALS[kind], space).toBeLessThanOrEqual(EVALS_MAX[kind]);
      expect(FRESH_EVALS[kind], space).toBeLessThanOrEqual(EVALS_MAX[kind]);
    }
    expect(defaultBudget(parseSearchProblem("surface/cube/nofold/4/12")!).evals).toBeLessThanOrEqual(EVALS_MAX.nofold);
  });
});

describe("3D in 3D: balls on the board", () => {
  const rule = { bound: null, certified: null };

  it("picks one of the seven problems, then P from 2 to 100", () => {
    const problems = catalogue("balls").problems;
    expect(problems).toHaveLength(693);
    const pick = pickProblem("balls", problems, fieldsOfId("balls", DEFAULT_PROBLEM.balls));
    expect(pick.id).toBe("balls/ballinball/13");
    expect(pick.fields.map((f) => f.label)).toEqual(["Problem", "Pieces (P)"]);
    expect(pick.fields[0].options.map((o) => o.text)).toEqual([
      "Balls in a ball",
      "Balls in a cube",
      "Tetrahedra in a ball",
      "Cubes in a ball",
      "Octahedra in a ball",
      "Dodecahedra in a ball",
      "Icosahedra in a ball",
    ]);
    expect(pick.fields[1].options).toHaveLength(99);
    expect(pickProblem("balls", problems, { code: "icoinball", P: "100" }).id).toBe("balls/icoinball/100");
    expect(scoreLabel(parseSearchProblem("balls/ballinball/13")!)).toBe("Container radius s");
    expect(scoreLabel(parseSearchProblem("balls/ballincub/13")!)).toBe("Cube edge s");
    expect(scoreLabel(parseSearchProblem("balls/tetinball/13")!)).toBe("Container radius s");
  });

  it("sizes its rounds from P and the piece, within their limits", () => {
    expect(ballsRound(13, "ballinball").round).toBe(300000);
    expect(ballsRound(100, "ballinball").round).toBe(107000);
    expect(ballsRound(100, "dodinball").round).toBe(23000);
    for (const code of ["ballinball", "ballincub", "tetinball", "cubinball", "octinball", "dodinball", "icoinball"])
      for (let P = 2; P <= 100; P++) {
        const { round, fresh } = ballsRound(P, code);
        const search = parseSearchProblem(`balls/${code}/${P}`)!;
        expect(roundSize(search)).toBe(round);
        expect(freshSize(search)).toBe(fresh);
        expect(round).toBeGreaterThanOrEqual(10000);
        expect(round).toBeLessThanOrEqual(300000);
        expect(defaultBudget(search)).toEqual({ time_s: 60, evals: 10 * round });
        expect(10 * round).toBeLessThanOrEqual(EVALS_MAX.balls);
      }
  });

  it("runs rounds of its own search with the run's seeds, within the budget", () => {
    const p = parseSearchProblem("balls/dodinball/100")!;
    const run = { seed: 5, budget: { evals: 100000, time_s: 60 }, fresh: false };
    const start = { s: 6, pieces: [] };
    const a = roundJob(p, rule, run, 0, { evals: 0, seconds: 0 }, start)!;
    expect(a.evals).toBe(23000);
    expect(a.job).toMatchObject({ space: "balls", id: p.id, seed: mixSeed(5, 0), kind: "iterate" });
    expect(a.job.method).toBe("balls penalty basin hopping");
    expect(roundJob(p, rule, run, 1, { evals: 23000, seconds: 2 }, start, 0, true)!.job.polished).toBe(true);
    expect(roundJob(p, rule, run, 1, { evals: 23000, seconds: 5 }, start, 3)!.evals).toBe(46000);
    expect(GROW_LIMIT.balls).toBe(2);
  });

  it("keeps an entry when it beats the research record by the tie tolerance", () => {
    const id = "balls/ballinball/13";
    const p = readSpaceProblem("balls", id, answer("balls", id));
    if (typeof p === "string") throw new Error(p);
    expect(p.best?.source).toBe("certified");
    expect(SPACE_RECORD_MARGIN.balls).toBe(SCORE_TIE);
    const cert = p.certified!.score;
    expect(beatsBest(p, cert * (1 - 0.5 * SCORE_TIE))).toBe(false);
    expect(beatsBest(p, cert * (1 - 2 * SCORE_TIE))).toBe(true);
    const v = validateSpaceSubmission("balls", id, p.best!.config, { bound: p.bound!.value, certified: cert });
    expect(v.valid, v.reasons.join("; ")).toBe(true);
  });
});

describe("3D in 3D: polyhedra on the board", () => {
  const rule = { bound: null, certified: null };

  it("picks a problem by its pair of solids, then P from 2 to 100", () => {
    const problems = catalogue("polyhedra").problems;
    const pick = pickProblem("polyhedra", problems, fieldsOfId("polyhedra", DEFAULT_PROBLEM.polyhedra));
    expect(pick.id).toBe("polyhedra/cubincub/11");
    expect(pick.fields.map((f) => f.label)).toEqual(["Problem", "Pieces (P)"]);
    expect(pick.fields[0].options).toHaveLength(86);
    expect(pick.fields[0].options[4]).toEqual({ value: "cubincub", text: "Cubes in a cube" });
    const Ps = pick.fields[1].options.map((o) => Number(o.value));
    expect(Ps[0]).toBe(2);
    expect(Ps[Ps.length - 1]).toBe(100);
    expect(pickProblem("polyhedra", problems, { code: "tidintid", P: "100" }).id).toBe("polyhedra/tidintid/100");
    expect(scoreLabel(parseSearchProblem("polyhedra/tidintid/100")!)).toBe("Container scale s");
  });

  it("sizes its rounds from P and the solid's size, at most about 20 s on a slow machine up to P = 100", () => {
    // two hops for small problems; for 100 of the largest solids, a polish of the start and jiggles
    expect(polyhedraRound(11, "cubincub").round).toBe(16800);
    expect(polyhedraRound(100, "cubincub").round).toBe(7100);
    expect(polyhedraRound(100, "tidintid").round).toBe(2600);
    expect(polyhedraRound(100, "phcinphc").round).toBe(2600);
    expect(polyhedraRound(100, "dtcindtc").round).toBe(2400);
    for (const code of PROBLEM_CODES)
      for (let P = 2; P <= 100; P++) {
        const { round, fresh, stepMs } = polyhedraRound(P, code);
        const at = `${code}/${P}`;
        if (round > 2 * (7000 + 130 * P) || round < 1000) throw new Error(`${at}: round ${round}`);
        // [CALC] at most about 20 s on a machine 3.5 times slower than the measured costs (3.4 times was seen under load)
        if (!(polyhedraRoundSeconds(P, code, round) < 20)) throw new Error(`${at}: ${polyhedraRoundSeconds(P, code, round)} s`);
        if (fresh < round) throw new Error(`${at}: fresh ${fresh}`);
        // a new arrangement runs its schedule on at most 40 % of the round, at about 1.5 times a hop's step
        if (fresh > round && !((0.4 * fresh * 1.5 * stepMs) / 1000 < 21)) throw new Error(`${at}: fresh ${fresh}`);
      }
    for (const code of ["tetintet", "cubincub", "tidintid", "phcinphc", "dtcindtc", "sndinsnd", "pr12l3incub"])
      for (const P of [2, 11, 30, 31, 64, 100]) {
        const { round, fresh } = polyhedraRound(P, code);
        const at = `${code}/${P}`;
        const search = parseSearchProblem(`polyhedra/${code}/${P}`)!;
        expect(roundSize(search)).toBe(round);
        expect(freshSize(search)).toBe(fresh);
        const budget = defaultBudget(search);
        expect(budget.evals).toBe(10 * round);
        expect(budget.time_s).toBeGreaterThanOrEqual(60);
        expect(budget.time_s).toBeLessThanOrEqual(300);
        // time for at least five rounds on the slow machine
        expect(budget.time_s, at).toBeGreaterThanOrEqual(Math.min(300, 5 * polyhedraRoundSeconds(P, code, round)));
      }
  });

  it("runs rounds of its own search with the run's seeds, within the budget", () => {
    const p = parseSearchProblem("polyhedra/tidintid/100")!;
    const run = { seed: 5, budget: { evals: 50000, time_s: 120 }, fresh: false };
    const start = { s: 6, pieces: [] };
    const a = roundJob(p, rule, run, 0, { evals: 0, seconds: 0 }, start)!;
    expect(a.evals).toBe(2600);
    expect(a.job).toMatchObject({ space: "polyhedra", id: p.id, seed: mixSeed(5, 0), kind: "iterate" });
    expect(a.job.method).toBe("polyhedra soft-to-rigid search");
    expect(a.job.budget).toEqual({ evals: 2600, time_s: 120 });
    // the shown packing is polished in the first round; the best of a round is not polished again
    expect(a.job.polished).toBeUndefined();
    expect(roundJob(p, rule, run, 1, { evals: 2600, seconds: 2 }, start, 0, true)!.job.polished).toBe(true);
    // grown after a round that did not improve, at most GROW_LIMIT times, and never past the budget
    expect(roundJob(p, rule, run, 1, { evals: 2600, seconds: 50 }, start, 1)!.job.budget).toEqual({
      evals: 5200,
      time_s: 70,
    });
    expect(GROW_LIMIT.polyhedra).toBe(2);
    expect(roundJob(p, rule, run, 2, { evals: 50000, seconds: 90 }, start)).toBeNull();
    // a new arrangement of 100 large solids: what fits in about 20 s on the slow machine
    expect(roundJob(p, rule, { ...run, budget: { evals: 1e6 } }, 0, { evals: 0, seconds: 0 }, null)!.evals).toBe(3400);
    // of 11 cubes: the simulator's whole soft-to-rigid schedule (12,910 steps) fits in 40 % of it
    expect(freshSize(parseSearchProblem("polyhedra/cubincub/11")!)).toBe(32200);
  });

  it("keeps an entry only when it beats the research record by the relative margin of 1e-6", () => {
    const id = "polyhedra/cubincub/11";
    const p = readSpaceProblem("polyhedra", id, answer("polyhedra", id));
    if (typeof p === "string") throw new Error(p);
    expect(p.best?.source).toBe("certified");
    expect(SPACE_RECORD_MARGIN.polyhedra).toBe(1e-6);
    const cert = p.certified!.score;
    expect(beatsBest(p, cert * (1 - 2 * SCORE_TIE))).toBe(false);
    expect(beatsBest(p, cert * (1 - 5e-7))).toBe(false);
    expect(beatsBest(p, cert * (1 - 2e-6))).toBe(true);
    // a site entry below the record: beaten by the tie tolerance, the record still by the margin
    const site = cert * (1 - 3e-6);
    const q = readSpaceProblem("polyhedra", id, answer("polyhedra", id, { score: site, config: null }));
    if (typeof q === "string") throw new Error(q);
    expect(beatsBest(q, site * (1 - 2 * SCORE_TIE))).toBe(true);
    expect(beatsBest(q, site)).toBe(false);
    expect(submitAnswer(200, { valid: true, score: 1.5, leader: false, id: null, best_score: 1.4 }, "polyhedra").text).toBe(
      `✓ Valid, score 1.500000, but not kept: it does not beat the problem's best 1.400000 (the site's best by more than a relative ${SCORE_TIE}, the research record by more than a relative 1e-6).`,
    );
  });

  it("shows a research record of 100 pieces that passes the server's check", () => {
    const id = "polyhedra/tidintid/100";
    const p = readSpaceProblem("polyhedra", id, answer("polyhedra", id));
    if (typeof p === "string") throw new Error(p);
    expect(p.P).toBe(100);
    expect((p.best!.config.pieces as unknown[]).length).toBe(100);
    const v = validateSpaceSubmission("polyhedra", id, p.best!.config, { bound: p.bound!.value, certified: p.certified!.score });
    expect(v.valid, v.reasons.join("; ")).toBe(true);
  });
});
