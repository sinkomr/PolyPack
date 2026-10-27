/**
 * The board's space mode, its pure parts (apps/web/src/space/model.ts, space-address.ts): the
 * address, the problem picker against the real catalogue, a problem as the server sends it, the
 * rounds of a run, the panel's words and the meaning of the server's answers.
 */
import { SCORE_TIE } from "@polypack/geometry";
import { PROBLEM_CODES } from "@polypack/polyhedra/catalogue";
import {
  type SpaceName,
  SPACE_RECORD_MARGIN,
  SPACE_DOMAINS,
  type ParsedSpaceId,
  parseSpaceId,
  problemOf,
  spaceProblemSummary,
  validateSpaceSubmission,
} from "@polypack/spaces";
import { loadSpacesIndex, readEntryConfigSync } from "@polypack/spaces/load";
import {
  BOUNDARY_ROUND_EVALS,
  mixSeed,
  parseSearchProblem,
  setKernelFactoryForTests,
  spaceKernel,
} from "@polypack/spaces/search";
import { useNofoldMethods } from "@polypack/spaces/search/nofold-methods";
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
  pickFromDomain,
  pickProblem,
  problemFacts,
  readSpaceProblem,
  ruleOf,
  roundJob,
  scoreLabel,
  searchKind,
  submitAnswer,
  boardMethods,
  evalsMax,
  evalUnit,
  GENERIC_ROUND_K,
  GENERIC_ROUND_K_BALL_PIECES,
  GENERIC_ROUND_K_SURFACE_DISKS,
  GENERIC_ROUND_MAX,
  GENERIC_ROUND_MIN,
  genericRound,
  isGeneric,
  METHOD_TEXT,
} from "../src/space/model";
import { POLYGON_METHOD_DESCRIPTIONS, POLYGON_METHOD_NAMES, POLYGON_METHOD_ORDER } from "../src/solve-methods";
import { ballsProblemOf } from "@polypack/balls/catalogue";

const root = resolve(__dirname, "../../..");
const index = loadSpacesIndex(root);
const catalogue = (space: SpaceName) => index[space]!;

/** The server's answer for a catalogue problem, with an optional site entry (spaces.ts, GET .../problems/<id>). */
function answer(space: SpaceName, id: string, site?: { score: number; config: unknown }) {
  // a record, or a problem of the space's domain without one
  const parsed = parseSpaceId(space, id);
  if (typeof parsed === "string") throw new Error(parsed);
  const p = problemOf(catalogue(space), parsed)!;
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
      const p = problemOf(catalogue(space), parseSpaceId(space, DEFAULT_PROBLEM[space]) as ParsedSpaceId);
      expect(p, space).toBeDefined();
      expect(p!.closed_reason, space).toBeNull();
      // a space without records opens on a problem without one
      if (p!.status === "no_record") continue;
      expect(p!.certified!.score, space).toBeGreaterThan(p!.bound!.value * 1.01);
    }
  });

  it("finds a problem from its own fields, on a hand-built list of every field family", () => {
    // per space: a list of ids as the catalogue writes them (its first and last, a sparse field, a P of 100, the
    // two signs of K), each of which must be found from its own fields. The catalogue's own ids and order are
    // checked in packages/spaces.
    const lists: Record<string, string[]> = {
      surface: [
        "surface/tetrahedron/fold/0/1",
        "surface/tetrahedron/fold/0/2",
        "surface/tetrahedron/nofold/0/2",
        "surface/dodecahedron/fold/5/22",
        "surface/dodecahedron/nofold/5/22",
        "surface/icosahedron/nofold/8/80",
      ],
      curved: [
        "curved/-6.519717439579256/3/12/12",
        "curved/-4.50521902808615/3/10/10",
        "curved/-1/5/3/1",
        "curved/-1/5/3/2",
        "curved/1.225778283313099/3/5/5",
      ],
      sphere: ["sphere/0/2", "sphere/0/3", "sphere/4/17", "sphere/4/18", "sphere/8/12"],
      torus: ["torus/sq/0/1", "torus/sq/0/2", "torus/sq/4/7", "torus/hex/0/6", "torus/free/0/5", "torus/free/8/49"],
      boundary: ["boundary/tesseract/ball/1", "boundary/tesseract/ball/2", "boundary/tesseract/cube/1", "boundary/tesseract/cube/16"],
      polyhedra: [
        "polyhedra/tetintet/2",
        "polyhedra/tetintet/3",
        "polyhedra/ap7inap7/2",
        "polyhedra/ap7inap7/50",
        "polyhedra/tz12incub/99",
        "polyhedra/tz12incub/100",
      ],
    };
    for (const [space, ids] of Object.entries(lists)) {
      const problems = ids.map((id) => ({ id }));
      for (const id of ids) {
        const pick = pickProblem(space as SpaceName, problems, fieldsOfId(space as SpaceName, id));
        expect(pick.id, id).toBe(id);
        expect(pick.fields.map((f) => f.value).join("/"), id).toBe(id.split("/").slice(1).join("/"));
      }
    }
  });

  it("finds the catalogue's first and last problem of every space from its own fields", () => {
    for (const space of BOARD_SPACES) {
      const problems = catalogue(space).problems;
      for (const p of [problems[0], problems[problems.length - 1]]) {
        if (!p) continue; // balls has a domain and no records
        const pick = pickProblem(space, problems, fieldsOfId(space, p.id));
        expect(pick.id, p.id).toBe(p.id);
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
    ).toBe("auto");
  });
});

describe("the methods of a run", () => {
  const rule = { bound: 1, certified: 1.2 };
  const sphere = parseSearchProblem("sphere/4/12")!;
  const nofold = parseSearchProblem("surface/cube/nofold/4/13")!;
  const start = { rho: 2, pieces: [] };

  it("offers Auto, and the polygon solver's methods on a nofold problem under the Flat board's names and order", () => {
    // a problem whose space builds no kernel: Auto alone
    setKernelFactoryForTests(() => {
      throw new Error("no kernel");
    });
    expect(boardMethods(sphere).map((m) => m.name)).toEqual(["auto"]);
    expect(boardMethods(sphere)[0]).toMatchObject({ title: "Auto", summary: METHOD_TEXT.sphere });
    setKernelFactoryForTests(null);
    // the polygon solver's methods, which the board loads for a nofold problem
    useNofoldMethods();
    const methods = boardMethods(nofold);
    expect(methods[0]).toMatchObject({ name: "auto", summary: METHOD_TEXT.nofold });
    const listed = methods.slice(1).map((m) => m.name);
    expect(listed).toEqual(POLYGON_METHOD_ORDER.filter((name) => listed.includes(name)));
    expect(listed.slice(0, 3)).toEqual(["basin_hopping", "penalty", "mc_compress"]);
    expect(methods.find((m) => m.name === "mc_compress")).toMatchObject({
      title: POLYGON_METHOD_NAMES.mc_compress,
      summary: POLYGON_METHOD_DESCRIPTIONS.mc_compress,
    });
  });

  it("gives a round the run's method and parameters; Auto takes none", () => {
    const run = { seed: 7, budget: { evals: 50000 }, fresh: false };
    expect(roundJob(sphere, rule, run, 0, { evals: 0, seconds: 0 }, start)!.job).toMatchObject({ method: "auto" });
    const auto = roundJob(
      sphere,
      rule,
      { ...run, method: "auto", params: { hops: 3 } },
      0,
      { evals: 0, seconds: 0 },
      start,
    )!;
    expect(auto.job.params).toBeUndefined();
    const face = roundJob(
      nofold,
      rule,
      { ...run, method: "penalty", params: { mu: 2 } },
      0,
      { evals: 0, seconds: 0 },
      null,
    )!;
    expect(face.job).toMatchObject({ method: "penalty", params: { mu: 2 } });
    // the polygon solver's methods count the polygon solver's evaluations, as Auto there does
    expect(face.evals).toBe(FRESH_EVALS.nofold);
  });

  it("sizes a generic method's rounds and budget in kernel energy evaluations", () => {
    const run = { seed: 7, budget: { evals: 1e7 }, fresh: false, method: "basin_hopping", params: {} };
    expect(isGeneric(sphere, "basin_hopping")).toBe(true);
    expect(isGeneric(sphere, "auto")).toBe(false);
    expect(isGeneric(nofold, "basin_hopping")).toBe(false);
    const round = genericRound(sphere);
    const a = roundJob(sphere, rule, run, 0, { evals: 0, seconds: 0 }, start)!;
    expect(a.evals).toBe(round);
    expect(a.job).toMatchObject({ method: "basin_hopping", budget: { evals: round } });
    expect(a.job.params).toBeUndefined();
    expect(roundJob(sphere, rule, run, 5, { evals: 0, seconds: 0 }, start, 9)!.evals).toBe(4 * round);
    expect(roundSize(sphere, "basin_hopping")).toBe(round);
    expect(freshSize(sphere, "basin_hopping")).toBe(round);
    expect(defaultBudget(sphere, "basin_hopping")).toEqual({ time_s: 30, evals: 10 * round });
    expect(evalsMax(sphere, "basin_hopping")).toBe(100_000_000);
    expect(evalsMax(sphere, "auto")).toBe(EVALS_MAX.sphere);
    // what the kernel's dearer calls count
    expect(evalUnit(sphere, "basin_hopping")).toMatch(
      /^one evaluation of the penalty energy \(.*a finish of a whole packing [\d,.]+, a check by the server's rule [\d,.]+\)$/,
    );
    expect(evalUnit(parseSearchProblem("surface/cube/fold/4/12")!, "penalty")).toContain(
      "one with its gradient counts",
    );
    // a fold round of a generic method is not the fold search's: no compressions of its start are taken off
    const fold = parseSearchProblem("surface/cube/fold/4/12")!;
    const f = roundJob(fold, rule, run, 0, { evals: 0, seconds: 0 }, null)!;
    expect(f.job.budget.evals).toBe(genericRound(fold));
  });

  it("makes a generic round about K / P evaluations of its space, clamped, and room for two finishes", () => {
    const at = (id: string) => {
      const p = parseSearchProblem(id)!;
      const k = spaceKernel(p)!;
      const K =
        p.space === "surface" && p.N === 0
          ? GENERIC_ROUND_K_SURFACE_DISKS
          : p.space === "balls" && ballsProblemOf(p.code)?.piece === "ball"
            ? GENERIC_ROUND_K_BALL_PIECES
            : GENERIC_ROUND_K[p.space];
      const offers = 100 * Math.ceil((2 * (k.finishCost + (k.validateCost ?? k.finishCost))) / 100);
      return { round: genericRound(p), K, P: p.P, offers };
    };
    // K / P in hundreds
    expect(at("sphere/4/12").round).toBe(275_000);
    expect(at("torus/sq/5/7").round).toBe(128_600);
    expect(at("surface/cube/fold/0/10").round).toBe(30_000);
    expect(at("surface/cube/fold/4/12").round).toBe(8300);
    // balls and solids in a ball have their own K
    expect(at("balls/ballincub/80").round).toBe(125_000);
    expect(at("balls/dodinball/13").round).toBe(11_500);
    // clamped to [5,000, 300,000]
    expect(at("boundary/tesseract/cube/2").round).toBe(GENERIC_ROUND_MAX);
    expect(at("polyhedra/cubincub/100").round).toBe(GENERIC_ROUND_MIN);
    // at least two finishes and checks of the kernel
    const curved = at("curved/-1/3/8/22");
    expect(curved.round).toBe(Math.max(100 * Math.round(curved.K / curved.P / 100), curved.offers));
    expect(curved.round).toBeGreaterThanOrEqual(curved.offers);
    for (const id of ["sphere/4/12", "boundary/tesseract/ball/9", "polyhedra/cubincub/57", "curved/-1/3/4/5"]) {
      const r = at(id);
      expect(r.round, id).toBeGreaterThanOrEqual(Math.min(r.offers, GENERIC_ROUND_MAX));
      expect(r.round, id).toBeGreaterThanOrEqual(GENERIC_ROUND_MIN);
    }
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
    expect(a.job).toMatchObject({ space: "boundary", id, method: "auto", kind: "iterate" });
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

  it("picks one of the 189 problems in groups, then P from 2 to 100, from its domain", () => {
    // no records: the picker is the domain's
    expect(catalogue("balls").problems).toHaveLength(0);
    const domain = catalogue("balls").domain!.info;
    const pick = pickFromDomain("balls", domain, fieldsOfId("balls", DEFAULT_PROBLEM.balls));
    expect(pick.id).toBe("balls/ballinball/13");
    expect(pick.fields.map((f) => f.label)).toEqual(["Problem", "Pieces (P)"]);
    const options = pick.fields[0].options;
    expect(options).toHaveLength(189);
    expect(options.slice(0, 3).map((o) => o.text)).toEqual(["Balls in a ball", "Balls in a tetrahedron", "Balls in a cube"]);
    expect(options.find((o) => o.value === "ballinpkd")).toMatchObject({
      text: "Balls in a pentakis dodecahedron",
      group: "Balls in a Catalan solid",
    });
    expect(options.find((o) => o.value === "kttinball")).toMatchObject({
      text: "Triakis tetrahedra in a ball",
      group: "Catalan solids in a ball",
    });
    // every option has a group, and a group is one run of options (an optgroup each)
    const runs: string[] = [];
    for (const o of options) {
      expect(o.group).toBeDefined();
      if (runs[runs.length - 1] !== o.group) runs.push(o.group!);
    }
    expect(runs).toHaveLength(16);
    expect(new Set(runs).size).toBe(16);
    expect(["tetinball", "cubinball", "octinball", "dodinball", "icoinball"].map((c) => options.find((o) => o.value === c)!.group)).toEqual(
      Array(5).fill("Platonic solids in a ball"),
    );
    expect(pick.fields[1].options).toHaveLength(99);
    expect(pickFromDomain("balls", domain, { code: "icoinball", P: "100" }).id).toBe("balls/icoinball/100");
    expect(pickFromDomain("balls", domain, { code: "ballinpr3l15", P: "7" }).id).toBe("balls/ballinpr3l15/7");
    expect(scoreLabel(parseSearchProblem("balls/ballinball/13")!)).toBe("Container radius s");
    expect(scoreLabel(parseSearchProblem("balls/ballincub/13")!)).toBe("Cube edge s");
    expect(scoreLabel(parseSearchProblem("balls/tetinball/13")!)).toBe("Container radius s");
    expect(scoreLabel(parseSearchProblem("balls/ballinpkd/13")!)).toBe("Container scale s");
    expect(scoreLabel(parseSearchProblem("balls/pr3l15inball/13")!)).toBe("Container radius s");
  });

  it("sizes its rounds from P and the piece, within their limits", () => {
    expect(ballsRound(13, "ballinball").round).toBe(300000);
    expect(ballsRound(100, "ballinball").round).toBe(128000);
    expect(ballsRound(100, "dodinball").round).toBe(25000);
    expect(ballsRound(100, "tetinball").round).toBe(16000);
    // also the new problems: any container solid, and any solid in a ball
    expect(ballsRound(100, "ballinball").round).toBe(128000);
    expect(ballsRound(100, "ballindtc").round).toBeLessThan(ballsRound(100, "ballinball").round);
    expect(ballsRound(100, "ballinball").evalUs).toBeCloseTo(15.6, 10);
    expect(ballsRound(100, "ballintet").evalUs).toBeCloseTo(15.6 * (1 + 4 / 150), 10);
    expect(ballsRound(100, "phcinball").evalUs).toBe(500);
    for (const code of ["ballinball", "ballincub", "tetinball", "cubinball", "octinball", "dodinball", "icoinball", "ballinpkd", "ballinpr12l3", "ballindtc", "phcinball", "pr3l3inball", "tz12inball"])
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
    expect(a.evals).toBe(25000);
    expect(a.job).toMatchObject({ space: "balls", id: p.id, seed: mixSeed(5, 0), kind: "iterate" });
    // the job's method is the method chosen (Auto), not the space's search label
    expect(a.job.method).toBe("auto");
    expect(roundJob(p, rule, run, 1, { evals: 25000, seconds: 2 }, start, 0, true)!.job.polished).toBe(true);
    expect(roundJob(p, rule, run, 1, { evals: 25000, seconds: 5 }, start, 3)!.evals).toBe(50000);
    expect(GROW_LIMIT.balls).toBe(2);
  });

  it("has no records: the first valid entry is kept, then entries better by the tie tolerance", () => {
    const id = "balls/ballinball/13";
    const p = readSpaceProblem("balls", id, answer("balls", id));
    if (typeof p === "string") throw new Error(p);
    expect(p).toMatchObject({ status: "no_record", certified: null, best: null, best_score: null });
    expect(ruleOf(p)).toMatchObject({ noRecord: true });
    expect(beatsBest(p, 1e6)).toBe(true);
    expect(SPACE_RECORD_MARGIN.balls).toBe(SCORE_TIE);
    // with a site entry of 3.1: beaten by more than the tie tolerance only
    const site = { score: 3.1, config: { s: 3.1, pieces: Array.from({ length: 13 }, (_, i) => [0, 0, 2.05 * i - 12.3]) } };
    const q = readSpaceProblem("balls", id, answer("balls", id, site));
    if (typeof q === "string") throw new Error(q);
    expect(beatsBest(q, 3.1 * (1 - 0.5 * SCORE_TIE))).toBe(false);
    expect(beatsBest(q, 3.1 * (1 - 2 * SCORE_TIE))).toBe(true);
  });
});

describe("3D in 3D: polyhedra on the board", () => {
  it("offers the entire domain through 500 regardless of records", () => {
    const pick = pickFromDomain("polyhedra", SPACE_DOMAINS.polyhedra!.info, { code: "tidintid", P: "500" });
    expect(pick.id).toBe("polyhedra/tidintid/500");
    expect(pick.fields.at(-1)!.options).toHaveLength(499);
    expect(pick.fields.at(-1)!.options.at(-1)!.value).toBe("500");
    for (const code of ["cubincub", "tetintet", "tidintid", "dtcindtc", "pr12l3incub"])
      for (const method of ["auto", "basin_hopping"])
        for (const fresh of [false, true]) {
          const p = parseSearchProblem(`polyhedra/${code}/500`)!;
          const plan = roundJob(p, rule, { seed: 1, fresh, method, budget: { evals: 1e6 } },
            0, { evals: 0, seconds: 0 }, fresh ? null : { s: 10, pieces: [] }, 20)!;
          const { stepMs } = polyhedraRound(500, code);
          const seconds = method !== "auto" ? plan.evals * stepMs / 1000
            : fresh ? 0.4 * plan.evals * 1.5 * stepMs / 1000 : polyhedraRoundSeconds(500, code, plan.evals);
          expect(seconds, `${code} ${method} fresh=${fresh}`).toBeLessThanOrEqual(20);
        }
  });

  it("picks the piece and the container in two menus of the 94 solids, grouped, and composes the code", () => {
    const info = SPACE_DOMAINS.polyhedra!.info;
    const pick = pickFromDomain("polyhedra", info, fieldsOfId("polyhedra", DEFAULT_PROBLEM.polyhedra));
    expect(pick.id).toBe("polyhedra/cubincub/11");
    expect(pick.fields.map((f) => [f.key, f.label, f.value])).toEqual([
      ["piece", "Piece", "cub"],
      ["container", "Container", "cub"],
      ["P", "Pieces (P)", "11"],
    ]);
    for (const f of pick.fields.slice(0, 2)) {
      expect(f.options).toHaveLength(94);
      expect(new Set(f.options.map((o) => o.group)).size).toBe(8);
    }
    expect(pick.fields[0].options[0]).toEqual({ value: "tet", text: "tetrahedron", group: "Platonic solids" });
    // a menu's change keeps the others
    expect(pickFromDomain("polyhedra", info, { piece: "ktt", container: "pkd", P: "7" }).id).toBe("polyhedra/kttinpkd/7");
    expect(pickFromDomain("polyhedra", info, { piece: "pr12l3", container: "cub", P: "500" }).id).toBe("polyhedra/pr12l3incub/500");
    // an old address with the code alone opens the same problem, whether one of the 150 or another pair
    for (const code of ["cubintet", "pr3l15incub", "tidintid", "kttinpkd", "pr12l3inbp7"]) {
      const old = pickFromDomain("polyhedra", info, { code, P: "9" });
      expect(old.id, code).toBe(`polyhedra/${code}/9`);
      expect(old.fields.map((f) => f.value).slice(0, 2).join("in")).toBe(code);
    }
    // a code that is no pair falls back to the starting problem's solids
    expect(pickFromDomain("polyhedra", info, { code: "nonsense", P: "9" }).id).toBe("polyhedra/cubincub/9");
  });

  const rule = { bound: null, certified: null };

  it("picks a problem by its pair of solids, then P from 2 to 100", () => {
    const problems = catalogue("polyhedra").problems;
    const pick = pickProblem("polyhedra", problems, fieldsOfId("polyhedra", DEFAULT_PROBLEM.polyhedra));
    expect(pick.id).toBe("polyhedra/cubincub/11");
    expect(pick.fields.map((f) => f.label)).toEqual(["Problem", "Pieces (P)"]);
    expect(pick.fields[0].options).toHaveLength(150);
    expect(pick.fields[0].options[4]).toEqual({ value: "cubincub", text: "Cubes in a cube" });
    const Ps = pick.fields[1].options.map((o) => Number(o.value));
    expect(Ps[0]).toBe(2);
    expect(Ps[Ps.length - 1]).toBe(100);
    expect(pickProblem("polyhedra", problems, { code: "tidintid", P: "100" }).id).toBe("polyhedra/tidintid/100");
    expect(scoreLabel(parseSearchProblem("polyhedra/tidintid/100")!)).toBe("Container scale s");
  });

  it("sizes its rounds from P and the solid's size, at most about 20 s on a slow machine up to P = 500", () => {
    // two hops for small problems; for 100 of the largest solids, a polish of the start and jiggles
    expect(polyhedraRound(11, "cubincub").round).toBe(16800);
    expect(polyhedraRound(100, "cubincub").round).toBe(7100);
    expect(polyhedraRound(100, "tidintid").round).toBe(2600);
    expect(polyhedraRound(100, "phcinphc").round).toBe(2600);
    expect(polyhedraRound(100, "dtcindtc").round).toBe(2400);
    for (const code of PROBLEM_CODES)
      for (let P = 2; P <= 500; P++) {
        const { round, fresh, stepMs } = polyhedraRound(P, code);
        const at = `${code}/${P}`;
        if (round > 2 * (7000 + 130 * P) || round < (P > 100 ? 100 : 1000)) throw new Error(`${at}: round ${round}`);
        // [CALC] at most about 20 s on a machine 3.5 times slower than the measured costs (3.4 times was seen under load)
        if (!(polyhedraRoundSeconds(P, code, round) < 20))
          throw new Error(`${at}: ${polyhedraRoundSeconds(P, code, round)} s`);
        if (fresh < round) throw new Error(`${at}: fresh ${fresh}`);
        // a new arrangement runs its schedule on at most 40 % of the round, at about 1.5 times a hop's step
        if (fresh > round && !((0.4 * fresh * 1.5 * stepMs) / 1000 < 21)) throw new Error(`${at}: fresh ${fresh}`);
      }
    for (const code of ["tetintet", "cubincub", "tidintid", "phcinphc", "dtcindtc", "sndinsnd", "pr12l3incub"])
      for (const P of [2, 11, 30, 31, 64, 100, 101, 257, 500]) {
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
    expect(a.job.method).toBe("auto");
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
    expect(
      submitAnswer(200, { valid: true, score: 1.5, leader: false, id: null, best_score: 1.4 }, "polyhedra").text,
    ).toBe(
      `✓ Valid, score 1.500000, but not kept: it does not beat the problem's best 1.400000 (the site's best by more than a relative ${SCORE_TIE}, the research record by more than a relative 1e-6).`,
    );
  });

  it("shows a research record of 100 pieces that passes the server's check", () => {
    const id = "polyhedra/tidintid/100";
    const p = readSpaceProblem("polyhedra", id, answer("polyhedra", id));
    if (typeof p === "string") throw new Error(p);
    expect(p.P).toBe(100);
    expect((p.best!.config.pieces as unknown[]).length).toBe(100);
    const v = validateSpaceSubmission("polyhedra", id, p.best!.config, {
      bound: p.bound!.value,
      certified: p.certified!.score,
    });
    expect(v.valid, v.reasons.join("; ")).toBe(true);
  });
});
