/**
 * The optional spaces mode, piece by piece: ids, configurations and the pre-submit check
 * (spaces/model.ts), the options, the draw, the state files, the engine with a fake RunSpaceJob,
 * and one real job per space on the current thread (spaces/run.ts).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceTarget } from "@polypack/spaces";
import { SPACE_STRICT_REASON } from "@polypack/spaces";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OptionError, helpText, parseOptions } from "../src/options";
import { eligibleSpaceTargets, noteSearch, pickSpaceTarget, recentFromHistory } from "../src/pick";
import { type SpaceSearchInput, searchSpaceProblem } from "../src/spaces/engine";
import { checkSpaceConfig, parseSpaceId, readSpaceConfig, statedScore } from "../src/spaces/model";
import { faceProblem, surfaceFromFace } from "../src/spaces/nofold";
import { readSpaceProblem, readSpaceTarget } from "../src/spaces/read";
import { Gate, type SpaceJob, type SpaceJobResult, runSpaceJob } from "../src/spaces/run";
import { decideSpaceSubmission, spaceSubmissionBody } from "../src/spaces/submit";
import { type HistoryLine, type SpaceHistoryLine, StateDir, spaceBestFileOf, spaceCandidateOf } from "../src/state";
import type { Control } from "../src/types";
import { enlarged, recordConfig } from "./spaces-fixtures";

const machine = { availableParallelism: 8, homedir: "/home/vol" };
const run = (...argv: string[]) => {
  const parsed = parseOptions(argv, machine);
  if (parsed.kind !== "run") throw new Error("not a run");
  return parsed.options;
};

describe("space problem ids and configurations", () => {
  it("reads the five id forms and nothing else", () => {
    expect(parseSpaceId("surface/cube/fold/0/12")).toMatchObject({
      space: "surface",
      solid: "cube",
      mode: "fold",
      N: 0,
      P: 12,
    });
    expect(parseSpaceId("curved/-1/3/4/7")).toMatchObject({ space: "curved", K: -1, N: 3, M: 4, P: 7 });
    expect(parseSpaceId("curved/1e-06/0/0/3")).toMatchObject({ K: 1e-6 });
    expect(parseSpaceId("curved/1.225778283313099/3/5/5")).toMatchObject({ K: 1.225778283313099, P: 5 });
    expect(parseSpaceId("sphere/4/12")).toMatchObject({ space: "sphere", N: 4, P: 12 });
    expect(parseSpaceId("torus/hex/5/8")).toMatchObject({ space: "torus", family: "hex", N: 5, P: 8 });
    expect(parseSpaceId("boundary/tesseract/ball/9")).toEqual({
      space: "boundary",
      id: "boundary/tesseract/ball/9",
      polytope: "tesseract",
      piece: "ball",
      P: 9,
    });
    expect(parseSpaceId("boundary/tesseract/cube/16")).toMatchObject({ piece: "cube", P: 16 });
    for (const bad of [
      "boundary/tesseract/ball/09",
      "boundary/tesseract/sphere/9",
      "boundary/tesseract/ball/9/../../x",
      "boundary/../ball/9",
      "boundary/tesseract/ball",
      "surface/cube/fold/0",
      "surface/prism/fold/0/3",
      "sphere/4/0",
      "sphere/2/5",
      "torus/rect/0/3",
      "curved/x/3/4/7",
      "sphere/4/12/../../x",
      "../sphere/4/12",
      "sphere/4/1000",
      42,
      null,
    ])
      expect(parseSpaceId(bad)).toBeNull();
  });

  it("accepts every space's research record and refuses an overlap", () => {
    const cases: [string, string, string][] = [
      ["sphere", "sphere/3/13", "rho"],
      ["torus", "torus/hex/5/8", "lattice"],
      ["curved", "curved/-1/3/4/7", "size"],
      ["surface", "surface/cube/fold/0/2", "s"],
      ["surface", "surface/cube/nofold/4/7", "s"],
      ["boundary", "boundary/tesseract/ball/9", "s"],
      ["boundary", "boundary/tesseract/cube/12", "s"],
    ];
    for (const [space, id] of cases) {
      const p = parseSpaceId(id)!;
      const c = recordConfig(space, id);
      const ok = checkSpaceConfig(p.space, p.id, c);
      expect(ok, id).toMatchObject({ valid: true });
      expect(ok.score).toBe(statedScore(p, readSpaceConfig(p, c)!));
      // 1 % smaller with the same poses overlaps (or leaves the container)
      const tight = checkSpaceConfig(
        p.space,
        p.id,
        enlarged(space, c, 0.99, id.includes("nofold") ? "nofold" : "fold"),
      );
      expect(tight.valid, id).toBe(false);
      expect(tight.reasons.length, id).toBeGreaterThan(0);
    }
  });

  // Review D3: the server's whole rule, with the bound and the research record's certified size.
  it("refuses, as the server does, a record shrunk by 2e-9: valid at 1e-9, not at the strict 1e-11", () => {
    for (const [space, id, mode] of [
      ["sphere", "sphere/3/8", undefined],
      ["surface", "surface/tetrahedron/fold/3/4", "fold"],
    ] as const) {
      const record = recordConfig(space, id);
      const certified = checkSpaceConfig(space, id, record).score!;
      const shrunk = enlarged(space, record, 1 - 2e-9, mode);
      expect(checkSpaceConfig(space, id, shrunk).valid, id).toBe(true);
      const strict = checkSpaceConfig(space, id, shrunk, { certified, bound: null });
      expect(strict.valid, id).toBe(false);
      expect(strict.reasons[0]).toBe(SPACE_STRICT_REASON);
      // the record itself does not beat its own certified size, so no strict check applies
      expect(checkSpaceConfig(space, id, record, { certified }).valid, id).toBe(true);
      // and a size below the bound is refused unchecked
      expect(checkSpaceConfig(space, id, record, { bound: certified * 1.01 }).valid, id).toBe(false);
    }
  });

  it("refuses malformed configurations", () => {
    const p = parseSpaceId("sphere/3/13")!;
    const good = recordConfig("sphere", "sphere/3/13");
    expect(readSpaceConfig(p, good)).not.toBeNull();
    for (const bad of [
      null,
      [],
      { rho: "1" },
      { ...good, rho: -1 },
      { ...good, pieces: (good.pieces as unknown[]).slice(1) },
      { ...good, pieces: [{ q: [1, 0, 0] }] },
    ])
      expect(checkSpaceConfig(p.space, p.id, bad)).toMatchObject({ valid: false, score: null });
    const t = parseSpaceId("torus/free/3/6")!;
    const free = recordConfig("torus", "torus/free/3/6");
    expect(checkSpaceConfig(t.space, t.id, free).valid).toBe(true);
    expect(checkSpaceConfig(t.space, t.id, { ...free, lattice: { L: 3 } }).valid).toBe(false);
  });

  it("reads the work list and a problem, dropping what it cannot use", () => {
    const t = {
      space: "sphere",
      id: "sphere/3/13",
      P: 13,
      priority: 0.5,
      best_score: 0.81,
      bound: 0.75,
      leader: "certified",
      leader_id: null,
    };
    expect(readSpaceTarget(t)).toEqual(t);
    expect(readSpaceTarget({ ...t, id: "sphere/3/14" })).toBeNull(); // P does not match the id
    expect(readSpaceTarget({ ...t, space: "torus" })).toBeNull();
    expect(readSpaceTarget({ ...t, priority: "high" })).toBeNull();
    const p = parseSpaceId("sphere/3/13")!;
    const config = recordConfig("sphere", "sphere/3/13");
    const body = {
      space: "sphere",
      id: "sphere/3/13",
      P: 13,
      accepts_submissions: true,
      best_score: 0.81,
      certified: { score: 0.81, display: "0.810000", status: "best_known" },
      bound: { value: 0.75, label: "area" },
      site_best: null,
      certified_config: config,
      site_config: { rho: 1, pieces: "none" },
    };
    expect(readSpaceProblem(body, p)).toMatchObject({
      accepts_submissions: true,
      closed_reason: null,
      bound: 0.75,
      site_config: null,
    });
    expect(
      readSpaceProblem({ ...body, accepts_submissions: false, closed_reason: "proven \u001b[31moptimal" }, p),
    ).toMatchObject({ accepts_submissions: false, closed_reason: "proven optimal" });
    expect(readSpaceProblem({ ...body, id: "sphere/3/12" }, p)).toBeNull();
    expect(readSpaceProblem({ ...body, site_best: { id: 3, score: "1" } }, p)).toBeNull();
  });
});

describe("the spaces options", () => {
  it("are off by default", () => {
    expect(run()).toMatchObject({ spaces: null, onlySpaces: false });
  });

  it("take a list or all, and --only-spaces", () => {
    expect(run("--spaces", "torus,sphere")).toMatchObject({ spaces: ["sphere", "torus"], onlySpaces: false });
    expect(run("--spaces", "polyhedra")).toMatchObject({ spaces: ["polyhedra"], onlySpaces: false });
    expect(run("--spaces", "all", "--only-spaces")).toMatchObject({
      spaces: ["surface", "curved", "sphere", "torus", "boundary", "polyhedra", "balls"],
      onlySpaces: true,
    });
    expect(run("--spaces", "Surface")).toMatchObject({ spaces: ["surface"] });
  });

  it("take boundary (3D on 4D) under either name, alone, in a list or as part of all", () => {
    expect(run("--spaces", "boundary")).toMatchObject({ spaces: ["boundary"], onlySpaces: false });
    expect(run("--dimensions", "boundary")).toMatchObject({ spaces: ["boundary"], onlySpaces: false });
    expect(run("--dimensions", "boundary,torus", "--only-dimensions")).toMatchObject({
      spaces: ["torus", "boundary"],
      onlySpaces: true,
    });
    expect(run("--dimensions", "all").spaces).toContain("boundary");
    // and never without the option
    expect(run("--N", "4").spaces).toBeNull();
    const help = helpText(machine);
    expect(help).toMatch(/boundary \(3D on 4D: unit balls and cubes on the boundary\s+of\s+a tesseract\)/);
    expect(help).toMatch(/surface, curved, sphere, torus,\s+boundary, polyhedra, balls, comma-separated, or all/);
    expect(run("--dimensions", "balls")).toMatchObject({ spaces: ["balls"], onlySpaces: false });
    expect(run("--dimensions", "all").spaces).toContain("balls");
  });

  it("refuse bad lists and an --only-spaces without spaces", () => {
    const bad =
      (...argv: string[]) =>
      () =>
        parseOptions(argv, machine);
    expect(bad("--spaces", "plane")).toThrow(
      /"plane" is not one of surface, curved, sphere, torus, boundary, polyhedra, balls or all/,
    );
    expect(bad("--spaces", "sphere,,torus")).toThrow(/empty item/);
    expect(bad("--spaces", "all,sphere")).toThrow(/cannot be combined/);
    expect(bad("--only-spaces")).toThrow(/--only-spaces needs --spaces/);
    expect(bad("--only-spaces", "--spaces", "all", "--N", "4")).toThrow(OptionError);
  });

  it("are explained by --help as optional", () => {
    const help = helpText(machine);
    expect(help).toContain("--spaces LIST");
    expect(help).toContain("--only-spaces");
    expect(help).toMatch(/off by default/);
  });

  it("are also named --dimensions and --only-dimensions, with the same values", () => {
    for (const argv of [
      ["--spaces", "torus,sphere"],
      ["--spaces", "all", "--only-spaces"],
      ["--spaces", "Surface"],
    ]) {
      const renamed = argv.map((a) => a.replace("spaces", "dimensions"));
      expect(run(...renamed), renamed.join(" ")).toEqual(run(...argv));
    }
    // the two names mix: the list under one, --only- under the other
    expect(run("--dimensions", "curved", "--only-spaces")).toMatchObject({ spaces: ["curved"], onlySpaces: true });
    expect(run("--spaces", "curved", "--only-dimensions")).toMatchObject({ spaces: ["curved"], onlySpaces: true });
    const bad =
      (...argv: string[]) =>
      () =>
        parseOptions(argv, machine);
    expect(bad("--dimensions", "plane")).toThrow(
      /^--dimensions: "plane" is not one of surface, curved, sphere, torus, boundary, polyhedra, balls or all$/,
    );
    expect(bad("--dimensions", "all", "--spaces", "all")).toThrow(/same option/);
    expect(bad("--only-dimensions")).toThrow(/--only-dimensions needs --dimensions LIST/);
    expect(bad("--only-dimensions", "--dimensions", "all", "--M", "4")).toThrow(/which --only-dimensions leaves out/);
    const help = helpText(machine);
    expect(help).toContain("--dimensions LIST");
    expect(help).toContain("--only-dimensions");
    expect(help).toContain("/dimensions.html");
  });
});

const target = (id: string, priority: number, leader_id: number | null = null): SpaceTarget => {
  const p = parseSpaceId(id)!;
  return {
    space: p.space,
    id,
    P: p.P,
    priority,
    best_score: 1,
    bound: null,
    leader: leader_id === null ? "certified" : "site",
    leader_id,
  };
};

function spaceLine(id: string, time: string, extra: Partial<SpaceHistoryLine> = {}): SpaceHistoryLine {
  const p = parseSpaceId(id)!;
  return {
    time,
    space: p.space,
    id,
    P: p.P,
    priority: 1,
    leader_before: { id: null, score: 1, source: "certified" },
    leader_after: null,
    bound: null,
    best: null,
    jobs: 1,
    stopped: "time",
    active_s: 1,
    engine_seed: 1,
    dry_run: false,
    submitted: false,
    decision: "not better than the problem's best",
    status: null,
    response: null,
    version: "test",
    ...extra,
  };
}

describe("the spaces' draw", () => {
  it("filters by space and --max-P, skips, and leaves out recent searches with the same best", () => {
    const list = [
      target("sphere/3/13", 3),
      target("torus/sq/0/7", 2),
      target("sphere/0/30", 5),
      target("surface/cube/fold/0/2", 1, 7),
    ];
    const now = Date.parse("2026-10-24T12:00:00Z");
    const recent = recentFromHistory([
      spaceLine("surface/cube/fold/0/2", "2026-10-24T11:00:00Z", {
        leader_before: { id: 7, score: 1, source: "site" },
      }),
    ]);
    const ids = (spaces: string[], maxP: number | null, skip: string[] = []) =>
      [
        ...eligibleSpaceTargets(list, {
          filters: { spaces: spaces as never, maxP },
          recent,
          skip: new Set(skip),
          now,
        }).values(),
      ]
        .flat()
        .map((t) => t.id);
    // by space, in the filter's order, each space's highest priorities first
    expect(ids(["torus", "sphere", "surface"], null)).toEqual(["torus/sq/0/7", "sphere/0/30", "sphere/3/13"]);
    expect(ids(["sphere"], 20)).toEqual(["sphere/3/13"]);
    expect(ids(["sphere", "torus"], null, ["sphere/0/30"])).toEqual(["sphere/3/13", "torus/sq/0/7"]);
    // a new site leader brings the problem back
    const changed = [{ ...list[3], leader_id: 9 }];
    expect(
      eligibleSpaceTargets(changed, { filters: { spaces: ["surface"], maxP: null }, recent, skip: new Set(), now }).get(
        "surface",
      ),
    ).toHaveLength(1);
  });

  // Review D1: the server scales each space's priorities to the same sum, so a space with many
  // problems has the smallest priorities. A cut of the whole list to its 50 highest left it out.
  it("draws the space first, so that a space with many problems is reached", () => {
    // as the server scales them: each space's priorities sum to 1/2
    const solids = ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"];
    const shapes = [0, 3, 4, 5, 6, 8];
    const sphere = Array.from({ length: 60 }, (_, k) =>
      target(`sphere/${shapes[k % 6]}/${2 + Math.floor(k / 6)}`, 0.5 / 60),
    );
    const surface = Array.from({ length: 500 }, (_, k) =>
      target(`surface/${solids[k % 5]}/fold/${shapes[Math.floor(k / 5) % 6]}/${1 + Math.floor(k / 30)}`, 0.5 / 500),
    );
    const list = [...sphere, ...surface];
    expect(new Set(list.map((t) => t.id)).size).toBe(560);
    // the 50 highest priorities of the whole list hold no surface problem: the old rule never reached one
    expect(
      [...list]
        .sort((x, y) => y.priority - x.priority)
        .slice(0, 50)
        .some((t) => t.space === "surface"),
    ).toBe(false);
    let a = 7;
    const random = () => {
      // mulberry32, seeded
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const now = Date.parse("2026-10-24T12:00:00Z");
    const recent = new Map();
    const drawn: string[] = [];
    for (let k = 0; k < 20; k++) {
      const t = pickSpaceTarget(list, {
        filters: { spaces: ["surface", "sphere"], maxP: null },
        recent,
        skip: new Set(),
        now,
        random,
      })!;
      drawn.push(t.space);
      // each problem drawn counts as searched, as in the client
      noteSearch(recent, spaceLine(t.id, "2026-10-24T11:00:00Z"));
    }
    expect(drawn.slice(0, 4)).toContain("surface");
    const n = drawn.filter((s) => s === "surface").length;
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(15);
  });

  it("keys space and polygon history apart", () => {
    const recent = new Map();
    noteSearch(recent, spaceLine("sphere/4/12", "2026-10-24T11:00:00Z"));
    expect([...recent.keys()]).toEqual(["sphere/4/12"]);
  });
});

describe("the state directory with space lines", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pv-spaces-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const polygonLine = (P: number): HistoryLine => ({
    time: "2026-10-24T10:00:00.000Z",
    N: 4,
    M: 4,
    P,
    reason: "slack",
    priority: 1,
    leader_before: null,
    leader_after: null,
    published: null,
    best: null,
    jobs: 1,
    stopped: "time",
    active_s: 1,
    engine_seed: 1,
    submitted: false,
    decision: "no strict packing",
    status: null,
    response: null,
    version: "0.1.0",
  });

  it("reads an older file unchanged, keeps both kinds apart and through compaction", () => {
    // a history written before the spaces option: polygon lines only
    writeFileSync(join(dir, "history.jsonl"), [1, 2].map((P) => JSON.stringify(polygonLine(P))).join("\n") + "\n");
    let state = StateDir.open(dir, { maxHistory: 4 });
    expect(state.initialHistory.map((l) => l.P)).toEqual([1, 2]);
    expect(state.initialSpaceHistory).toEqual([]);
    state.appendHistory(spaceLine("sphere/4/12", "2026-10-24T11:00:00Z"));
    for (const P of [3, 4, 5, 6]) state.appendHistory(polygonLine(P));
    // cut back while running to the last four lines of both kinds, then one more line
    expect(state.readAllHistory().map((l) => ("space" in l ? l.id : l.P))).toEqual(["sphere/4/12", 3, 4, 5, 6]);
    state.close();
    state = StateDir.open(dir, { maxHistory: 4 });
    expect(state.initialHistory.map((l) => l.P)).toEqual([3, 4, 5, 6]);
    expect(state.initialSpaceHistory.map((l) => l.id)).toEqual([]);
    state.appendHistory(spaceLine("torus/sq/0/7", "2026-10-24T12:00:00Z"));
    expect(state.readSpaceHistory().map((l) => l.id)).toEqual(["torus/sq/0/7"]);
    expect(state.readHistory().map((l) => l.P)).toEqual([3, 4, 5, 6]);
    state.close();
  });

  it("writes space lines that an older client skips", () => {
    // the older client's test: integer N, M and P
    const old = (v: Record<string, unknown>) => Number.isInteger(v.N) && Number.isInteger(v.M) && Number.isInteger(v.P);
    for (const id of ["sphere/4/12", "curved/-1/3/4/7", "surface/cube/fold/0/2", "torus/hex/5/8"])
      expect(old(JSON.parse(JSON.stringify(spaceLine(id, "2026-10-24T11:00:00Z"))))).toBe(false);
  });

  it("keeps a space problem's best configuration and refuses one that does not fit", () => {
    const state = StateDir.open(dir);
    const p = parseSpaceId("sphere/3/13")!;
    const config = recordConfig("sphere", "sphere/3/13");
    const f = {
      space: "sphere" as const,
      id: p.id,
      P: 13,
      score: config.rho as number,
      method: "sphere basin hopping",
      seed: 5,
      budget: { time_s: 3, evals: 100 },
      kind: "iterate",
      found_at: "2026-10-24T11:00:00.000Z",
      version: "test",
      config,
    };
    state.writeSpaceBest(f);
    expect(state.spaceBestPath(p.id)).toBe(join(dir, "best", "spaces", "sphere_3_13.json"));
    expect(state.readSpaceBest(p)).toMatchObject({ id: p.id, seed: 5, score: config.rho });
    expect(state.readSpaceBest(parseSpaceId("sphere/3/12")!)).toBeNull();
    writeFileSync(state.spaceBestPath(p.id), JSON.stringify({ ...f, config: { rho: 1, pieces: [] } }));
    expect(state.readSpaceBest(p)).toBeNull();
    state.close();
    expect(JSON.parse(readFileSync(join(dir, "best", "spaces", "sphere_3_13.json"), "utf8")).config.rho).toBe(1);
  });
});

describe("the submission rule", () => {
  const p = parseSpaceId("sphere/3/13")!;
  const config = recordConfig("sphere", "sphere/3/13");
  const best = {
    config,
    score: config.rho as number,
    job: { space: "sphere", id: p.id, method: "m", seed: 1, budget: { time_s: 1 }, kind: "iterate" } as SpaceJob,
  };
  const check = checkSpaceConfig(p.space, p.id, config);
  const decide = (o: Partial<Parameters<typeof decideSpaceSubmission>[0]>) =>
    decideSpaceSubmission({ best, check, open: true, bestScore: best.score * 1.01, bound: null, dryRun: false, ...o })
      .reason;
  it("submits only a valid configuration that beats the best by more than the tie tolerance", () => {
    expect(decide({})).toBe("better than the problem's best");
    expect(decide({ bestScore: best.score * (1 + 5e-10) })).toBe("not better than the problem's best");
    expect(decide({ check: { valid: false, score: 1, reasons: ["pieces 1 and 2 overlap"] } })).toMatch(/not valid/);
    expect(decide({ open: false })).toBe("the problem is closed");
    expect(decide({ bound: best.score * 1.001 })).toBe("below the problem's lower bound");
    expect(decide({ dryRun: true })).toBe("dry run: would submit");
    expect(decide({ best: null })).toBe("no valid configuration");
  });

  it("follows the server's keep rule with a record margin: polyhedra records are beaten by more than 1e-6", () => {
    const s = best.score;
    const record = (space: "polyhedra" | "sphere", certified: number | null, leader: number | null = null) => ({
      record: { space, certified, leader },
    });
    // 5e-7 below a polyhedra record: valid, but the server would not keep it
    expect(decide({ bestScore: s / (1 - 5e-7), ...record("polyhedra", s / (1 - 5e-7)) })).toBe(
      "not below the research record by the space's margin",
    );
    expect(decide({ bestScore: s / (1 - 2e-6), ...record("polyhedra", s / (1 - 2e-6)) })).toBe(
      "better than the problem's best",
    );
    // the other spaces keep the tie tolerance; a site leader is beaten by the tie tolerance
    expect(decide({ bestScore: s / (1 - 5e-7), ...record("sphere", s / (1 - 5e-7)) })).toBe(
      "better than the problem's best",
    );
    expect(decide({ bestScore: s / (1 - 5e-9), ...record("polyhedra", s / (1 - 2e-6), s / (1 - 5e-9)) })).toBe(
      "better than the problem's best",
    );
  });

  it("names the method as the spaces' records read: the kind's own search for auto, else the kind and the method", () => {
    const named = (method: string | undefined) => {
      const job = { ...best.job, method };
      const o = { name: "Ada", note: "", software: "test" };
      return [spaceSubmissionBody(p, { ...best, job }, o).method, spaceBestFileOf({ ...best, job }, 13, "v").method];
    };
    expect(named(undefined)).toEqual(["sphere basin hopping", "sphere basin hopping"]);
    expect(named("auto")).toEqual(["sphere basin hopping", "sphere basin hopping"]);
    expect(named("basin_hopping")).toEqual(["sphere basin_hopping", "sphere basin_hopping"]);
    // a name read back from a best file stays as it is
    expect(named("sphere basin_hopping")).toEqual(["sphere basin_hopping", "sphere basin_hopping"]);
  });

  it("keeps --space-params with the method: in full in the best file, in the submission when they fit", () => {
    const o = { name: "Ada", note: "", software: "test" };
    const job = { ...best.job, method: "penalty", params: { seedShare: 0.5 } };
    expect(spaceSubmissionBody(p, { ...best, job }, o).method).toBe('sphere penalty {"seedShare":0.5}');
    const file = spaceBestFileOf({ ...best, job }, 13, "v");
    expect(file).toMatchObject({ method: "sphere penalty", params: { seedShare: 0.5 } });
    // read back, it names the same method and parameters
    const again = spaceCandidateOf(file);
    expect(again.job.params).toEqual({ seedShare: 0.5 });
    expect(spaceSubmissionBody(p, again, o).method).toBe('sphere penalty {"seedShare":0.5}');
    // too long for the server's 80 characters: the name alone
    const long = { ...best.job, method: "penalty", params: { note: "x".repeat(80) } };
    expect(spaceSubmissionBody(p, { ...best, job: long }, o).method).toBe("sphere penalty");
    expect(spaceBestFileOf({ ...best, job: long }, 13, "v").params).toEqual({ note: "x".repeat(80) });
    // no parameters: no field
    expect(spaceBestFileOf(best, 13, "v")).not.toHaveProperty("params");
  });
});

describe("nofold problems as planar packings", () => {
  it("takes the fullest face as the start and copies a planar packing onto every face", () => {
    const p = parseSpaceId("surface/cube/nofold/4/7")! as never;
    const config = recordConfig("surface", "surface/cube/nofold/4/7");
    const f = faceProblem(p, config);
    expect(f.problem).toEqual({ N: 4, M: 4, P: 2 });
    expect(f.known?.score).toBeCloseTo(2, 9);
    const back = surfaceFromFace(p, f.known!.config)!;
    expect((back.pieces as unknown[]).length).toBe(7);
    const c = checkSpaceConfig(parseSpaceId("surface/cube/nofold/4/7")!.space, "surface/cube/nofold/4/7", back);
    expect(c.valid).toBe(true);
    expect(c.score!).toBeCloseTo(2, 9);
  });
});

/** A fake RunSpaceJob: answers each job after `seconds` of the fake clock with `score(job)`. */
function fakeRunner(clock: { t: number }, score: (job: SpaceJob, n: number) => number | null, seconds = 1) {
  const jobs: SpaceJob[] = [];
  const runJob = async (job: SpaceJob): Promise<SpaceJobResult> => {
    const n = jobs.length;
    jobs.push(job);
    await Promise.resolve();
    clock.t += Math.min(seconds, job.budget.time_s);
    const s = score(job, n);
    return {
      job,
      score: s,
      valid: s !== null,
      ...(s !== null ? { config: { rho: s, pieces: [] } } : {}),
      evaluations: 100,
      wallTime: seconds,
      termination: "evals",
      reasons: [],
    };
  };
  return { jobs, runJob };
}

describe("the space engine", () => {
  const input = (clock: { t: number }, o: Partial<SpaceSearchInput> = {}): SpaceSearchInput => ({
    space: "sphere",
    id: "sphere/3/13",
    known: { config: { rho: 2, pieces: [] }, score: 2, source: "certified" },
    bound: null,
    maxSeconds: 20,
    lanes: 1,
    seed: 42,
    now: () => clock.t,
    ...o,
  });
  const control = (): Control => ({ aborted: false, paused: false });

  it("starts from the known configuration, then from its own best, and stops on stagnation", async () => {
    const clock = { t: 0 };
    const r = fakeRunner(clock, (_job, n) => (n < 3 ? 1.9 - 0.1 * n : 1.7));
    const out = await searchSpaceProblem(input(clock), r.runJob, control());
    expect(out.best?.score).toBeCloseTo(1.7, 12);
    expect(out.stopped).toBe("stagnation");
    // the first job always starts from the known configuration
    expect(r.jobs[0]).toMatchObject({ kind: "iterate", start: { rho: 2, pieces: [] } });
    // later iterate jobs start from the engine's own best
    expect(r.jobs.slice(1).filter((j) => j.kind === "iterate")[0].start).toEqual({ rho: 1.9, pieces: [] });
    // each kind's own search, unless the client was given another method
    expect(r.jobs.every((j) => j.method === "auto" && j.params === undefined && j.budget.time_s >= 1)).toBe(true);
    // the first jobs have no evaluation cap; once the rate is known they do
    expect(r.jobs[0].budget.evals).toBeUndefined();
    expect(r.jobs.at(-1)!.budget.evals).toBeGreaterThan(0);
  });

  it("makes the same jobs for the same seed and the same answers", async () => {
    const runOnce = async () => {
      const clock = { t: 0 };
      const r = fakeRunner(clock, (_job, n) => 2 - 0.01 * n);
      await searchSpaceProblem(input(clock, { lanes: 2 }), r.runJob, control());
      return r.jobs.map((j) => [j.seed, j.kind, j.budget.time_s, j.budget.evals]);
    };
    const a = await runOnce();
    expect(a.length).toBeGreaterThan(3);
    expect(await runOnce()).toEqual(a);
  });

  it("stops at the time limit, at the bound and when aborted", async () => {
    let clock = { t: 0 };
    let r = fakeRunner(clock, (_job, n) => 2 - 0.01 * n);
    expect((await searchSpaceProblem(input(clock), r.runJob, control())).stopped).toBe("time");
    expect(clock.t).toBeLessThanOrEqual(20);

    clock = { t: 0 };
    r = fakeRunner(clock, () => 1.5);
    expect((await searchSpaceProblem(input(clock, { bound: 1.5 }), r.runJob, control())).stopped).toBe("bound");
    expect(r.jobs).toHaveLength(1);

    clock = { t: 0 };
    const c = control();
    r = fakeRunner(clock, (_job, n) => {
      if (n === 1) c.aborted = true;
      return 1.9;
    });
    expect((await searchSpaceProblem(input(clock), r.runJob, c)).stopped).toBe("aborted");
    expect(r.jobs).toHaveLength(2);
  });

  it("stops when a valid job ends at its search's own floor, which may lie above the problem's bound", async () => {
    const clock = { t: 0 };
    const jobs: SpaceJob[] = [];
    const answer = (job: SpaceJob, valid: boolean): SpaceJobResult => ({
      job,
      score: valid ? 1.000000000001 : null,
      valid,
      ...(valid ? { config: { s: 1.000000000001, pieces: [] } } : {}),
      evaluations: 0,
      wallTime: 0,
      termination: "bound",
      reasons: [],
    });
    const at = (valid: boolean) => async (job: SpaceJob) => {
      jobs.push(job);
      clock.t += 1;
      return answer(job, valid);
    };
    const floor = { ...input(clock), space: "boundary" as const, id: "boundary/tesseract/cube/4", bound: 0.79 };
    const out = await searchSpaceProblem(floor, at(true), control());
    expect(out).toMatchObject({ stopped: "bound", jobs: 1 });
    expect(out.best!.score).toBe(1.000000000001);
    // an invalid answer says nothing about the floor
    jobs.length = 0;
    clock.t = 0;
    expect((await searchSpaceProblem(floor, at(false), control())).stopped).not.toBe("bound");
    expect(jobs.length).toBeGreaterThan(1);
  });

  it("gives up after three failed jobs in a row", async () => {
    const clock = { t: 0 };
    const jobs: SpaceJob[] = [];
    const out = await searchSpaceProblem(
      input(clock),
      async (job) => {
        jobs.push(job);
        throw new Error("broken");
      },
      control(),
    );
    expect(out).toMatchObject({ best: null, stopped: "stagnation" });
    expect(jobs).toHaveLength(3);
  });
});

describe("one space job on this thread", () => {
  const job = (space: string, id: string, start: unknown, o: Partial<SpaceJob> = {}): SpaceJob => ({
    space: space as never,
    id,
    seed: 3,
    budget: { time_s: 20, evals: 400 },
    kind: "iterate",
    start: start as never,
    ...o,
  });
  const go: Control = { aborted: false, paused: false };

  for (const [space, id, mode] of [
    ["sphere", "sphere/3/13"],
    ["torus", "torus/hex/5/8"],
    ["curved", "curved/-1/3/4/3"],
    ["surface", "surface/cube/fold/0/2", "fold"],
  ] as const) {
    it(`${id}: returns a valid configuration at least as good as an enlarged start`, () => {
      const start = enlarged(space, recordConfig(space, id), 1.01, mode);
      const p = parseSpaceId(id)!;
      const startScore = checkSpaceConfig(p.space, p.id, start).score!;
      const r = runSpaceJob(
        job(space, id, start, space === "surface" || space === "curved" ? { budget: { time_s: 20, evals: 2 } } : {}),
        go,
      );
      expect(r.valid, r.reasons.join("; ")).toBe(true);
      expect(r.score!).toBeLessThanOrEqual(startScore);
      expect(checkSpaceConfig(p.space, p.id, r.config).valid).toBe(true);
      expect(r.termination).not.toBe("error");
    });
  }

  it("is reproducible from its seed and evaluation cap", () => {
    const start = enlarged("torus", recordConfig("torus", "torus/sq/0/7"), 1.02);
    const a = runSpaceJob(
      job("torus", "torus/sq/0/7", start, { kind: "fresh", start: undefined, budget: { time_s: 60, evals: 1500 } }),
      go,
    );
    const b = runSpaceJob(
      job("torus", "torus/sq/0/7", start, { kind: "fresh", start: undefined, budget: { time_s: 60, evals: 1500 } }),
      go,
    );
    expect(a.valid).toBe(true);
    expect(b.config).toEqual(a.config);
    expect(a.termination).toBe("evals");
  });

  it("ends at once when aborted, and refuses a start of another problem", () => {
    const start = recordConfig("sphere", "sphere/3/13");
    const r = runSpaceJob(job("sphere", "sphere/3/13", start, { budget: { time_s: 60 } }), {
      aborted: true,
      paused: false,
    });
    expect(r.termination).toBe("aborted");
    expect(r.valid).toBe(true); // the start itself
    const wrong = runSpaceJob(job("sphere", "sphere/3/12", start), go);
    expect(wrong).toMatchObject({ valid: false, termination: "error" });
    expect(runSpaceJob(job("sphere", "torus/sq/0/7", start), go)).toMatchObject({ termination: "error" });
  });

  it("does not count paused time", () => {
    let t = 0;
    let waited = 0;
    const control = {
      aborted: false,
      get paused() {
        return t >= 1 && waited < 5;
      },
      wait() {
        waited++;
        t += 10;
      },
    };
    const gate = new Gate(control, 2, () => t);
    t = 1;
    expect(gate.stop()).toBe(false); // paused here for 50 s of the clock, then resumed
    expect(waited).toBe(5);
    expect(gate.elapsed).toBeCloseTo(1, 12);
    t += 1.5;
    expect(gate.stop()).toBe(true);
    expect(gate.why).toBe("time");
  });
});

describe("range-domain problems in the volunteer client", () => {
  it("reads and checks new shapes at P = 100 without a research record", () => {
    for (const N of [3, 7, 12, 20, 100]) {
      const ids = [`curved/-1e-06/${N}/0/100`, `sphere/${N}/100`, `torus/hex/${N}/100`];
      for (const id of ids) {
        const p = parseSpaceId(id)!;
        expect(p).toMatchObject({ N, P: 100 });
        // The shared checker reaches the packing parser, rather than refusing the old P cap.
        expect(checkSpaceConfig(p.space, id, {}).reasons.join(" ")).not.toMatch(
          /above the largest P|bad sphere problem/,
        );
      }
    }
  });
});
