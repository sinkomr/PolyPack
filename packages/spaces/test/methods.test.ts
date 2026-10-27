/**
 * The methods a space problem offers and one job's dispatch to them (src/search/methods.ts,
 * kernels.ts, run.ts): Auto runs the space's own search unchanged, an unknown method or bad
 * parameters give an error result, and a generic method runs end to end on a kernel: on a test
 * kernel that stands in for one problem (generic-fixtures.ts), so that the tests do not depend on a
 * space's kernel, and on the real ones. The balls kernel's validate() rebuilds the server's rule, because
 * the balls package does not depend on this one; here the two are compared.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BALLS_FAMILY_SAMPLE, BALLS_ORIGINAL_CODES, type BallsConfig, ballsKernel, searchBalls, getBallsProblem } from "@polypack/balls";
import { listMethods, mulberry32, squeeze } from "@polypack/methods";
import { registry as polygonRegistry } from "@polypack/solver";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTO,
  AUTO_TEXT,
  type Control,
  SPACE_METHOD,
  type SpaceJob,
  type SpaceJobResult,
  checkSpaceConfig,
  checkSpaceMethod,
  chooseSpaceMethod,
  parseSearchProblem,
  runSpaceJob,
  searchMethodName,
  searchSpaceProblem,
  setKernelFactoryForTests,
  spaceKernel,
  setNofoldMethods,
  spaceKernelError,
  spaceMethodName,
  spaceMethodNote,
  spaceMethodsFor,
} from "../src/search";
import { SPACE_DOMAINS } from "../src/domain";
import { parseSpaceId } from "../src/ids";
import { loadSpacesIndex, readEntryConfigSync } from "../src/load";
import { validateSpaceSubmission } from "../src/validate";
import { useNofoldMethods } from "../src/search/nofold-methods";
import {
  DISKS,
  disksRule as rule,
  grownDisks as grown,
  probe,
  probeSeen,
  restarts,
  swapper,
  withDisks,
  withoutKernels,
} from "./generic-fixtures";

const root = resolve(__dirname, "../../..");
const index = loadSpacesIndex(root);
/** A problem's research record, from the catalogue. */
const recordOf = (id: string) => {
  const space = id.split("/")[0] as SpaceJob["space"];
  const cat = index[space]!;
  return JSON.parse(readEntryConfigSync(root, cat, cat.byId.get(id)!)!);
};

afterEach(() => setKernelFactoryForTests(null));
useNofoldMethods();

const go = { aborted: false, paused: false };
const job = (id: string, o: Partial<SpaceJob> = {}): SpaceJob => ({
  space: id.split("/")[0] as SpaceJob["space"],
  id,
  seed: 3,
  budget: { time_s: 60, evals: 3000 },
  kind: "iterate",
  rule,
  ...o,
});
describe("the methods a problem offers", () => {
  it("is Auto alone while the space builds no kernel, with the space's own description", () => {
    withoutKernels();
    for (const id of ["sphere/4/12", "torus/hex/5/8", DISKS, "surface/cube/fold/4/12", "boundary/tesseract/ball/9"]) {
      const p = parseSearchProblem(id)!;
      expect(spaceKernel(p), id).toBeNull();
      const methods = spaceMethodsFor(p);
      expect(
        methods.map((m) => m.name),
        id,
      ).toEqual([AUTO]);
      expect(methods[0]).toMatchObject({ title: "Auto", summary: AUTO_TEXT[p.space], defaults: {} });
    }
  });

  it("lists the kernel's methods after Auto once there is a kernel, leaving out those it lacks a capability for", () => {
    withDisks();
    const p = parseSearchProblem(DISKS)!;
    const names = spaceMethodsFor(p).map((m) => m.name);
    expect(names[0]).toBe(AUTO);
    expect(names).toContain(restarts.name);
    expect(names).not.toContain(swapper.name);
    expect(spaceMethodsFor(p).find((m) => m.name === restarts.name)).toMatchObject({
      title: restarts.title,
      summary: restarts.summary,
      schema: restarts.schema,
      defaults: restarts.defaults,
    });
    // another problem of the space still has no kernel
    expect(spaceMethodsFor(parseSearchProblem("curved/-1/0/0/7")!).map((m) => m.name)).toEqual([AUTO]);
  });

  it("lists every method whose capabilities a space's own kernel has, on a problem of each space", () => {
    for (const id of [
      "sphere/4/12",
      "torus/sq/5/7",
      "curved/-1/3/4/5",
      "surface/cube/fold/0/10",
      "boundary/tesseract/ball/9",
      "boundary/tesseract/cube/16",
      "polyhedra/cubincub/11",
      "balls/ballinball/13",
      "balls/ballincub/8",
      "balls/tetinball/5",
      "balls/dodinball/20",
    ]) {
      const p = parseSearchProblem(id)!;
      const k = spaceKernel(p);
      expect(k, `${id}: ${spaceKernelError(p)}`).not.toBeNull();
      const expected = listMethods()
        .filter((m) => m.requires.every((c) => k!.capabilities.includes(c)))
        .map((m) => m.name);
      const names = spaceMethodsFor(p).map((m) => m.name);
      expect(names, id).toEqual([AUTO, ...expected]);
      for (const name of ["penalty", "mc_compress", "asc", "basin_hopping", "shrink_repair", "seed"])
        expect(names, id).toContain(name);
      // soft shapes: every kernel here but the cubes'
      if (k!.capabilities.includes("shape")) expect(names, id).toEqual(expect.arrayContaining(["harden", "morph"]));
    }
  });

  it("says why a problem whose space cannot model it offers no generic method", () => {
    // no unit octagon exists at curvature 1
    const p = parseSearchProblem("curved/1/8/0/3")!;
    expect(spaceKernel(p)).toBeNull();
    expect(spaceMethodsFor(p).map((m) => m.name)).toEqual([AUTO]);
    expect(checkSpaceMethod(p, "penalty")).toBe(
      "curved/1/8/0/3 offers no generic method (no unit piece N=8 exists at K=1): use auto",
    );
  });

  it("offers the polygon solver's methods on a nofold problem, once they are loaded", () => {
    const p = parseSearchProblem("surface/cube/nofold/4/13")!;
    setNofoldMethods([]);
    expect(spaceMethodsFor(p).map((m) => m.name)).toEqual([AUTO]);
    useNofoldMethods();
    const methods = spaceMethodsFor(p);
    expect(methods[0]).toMatchObject({ name: AUTO, summary: AUTO_TEXT.nofold });
    const names = methods.slice(1).map((m) => m.name);
    expect(names).toEqual(
      polygonRegistry
        .list()
        .map((m) => m.name)
        .filter((n) => n !== "identity"),
    );
    expect(names).toContain("basin_hopping");
    for (const m of methods.slice(1)) {
      expect(m.summary, m.name).toMatch(/^[A-Z].*\.$/);
      expect(m.summary.slice(0, -1), m.name).not.toMatch(/\.\s/);
    }
  });
});

describe("a method and its parameters", () => {
  const sphere = parseSearchProblem("sphere/4/12")!;
  const nofold = parseSearchProblem("surface/cube/nofold/4/13")!;
  const disks = parseSearchProblem(DISKS)!;

  it("takes Auto without parameters, under any of its names", () => {
    expect(checkSpaceMethod(sphere, undefined)).toBeNull();
    expect(checkSpaceMethod(sphere, "auto", {})).toBeNull();
    expect(checkSpaceMethod(sphere, SPACE_METHOD.sphere)).toBeNull();
    expect(checkSpaceMethod(sphere, "auto", { hops: 3 })).toMatch(/takes no parameters/);
    expect(checkSpaceMethod(sphere, "auto", [1] as never)).toMatch(/JSON object/);
  });

  it("refuses an unknown method, and a generic one before the space has a kernel, in a sentence", () => {
    withoutKernels();
    expect(checkSpaceMethod(sphere, "no_such_method")).toMatch(
      /^unknown method "no_such_method" for sphere\/4\/12; it offers auto$/,
    );
    expect(checkSpaceMethod(sphere, restarts.name)).toMatch(/offers no generic method \(no kernel\): use auto/);
    expect(checkSpaceMethod(nofold, restarts.name)).toMatch(/unknown method/);
  });

  it("checks a method's parameters against its schema", () => {
    withDisks();
    expect(checkSpaceMethod(disks, restarts.name)).toBeNull();
    expect(checkSpaceMethod(disks, restarts.name, { mu: 100 })).toBeNull();
    expect(checkSpaceMethod(disks, restarts.name, { mu: -1 })).toMatch(/^spaces_test_restarts: params\.mu: /);
    expect(checkSpaceMethod(disks, restarts.name, { nope: 1 })).toMatch(/unknown parameter nope/);
    expect(checkSpaceMethod(disks, swapper.name)).toMatch(/needs a kernel capability \(swap\)/);
    // the polygon methods' own schemas on a nofold problem
    expect(checkSpaceMethod(nofold, "basin_hopping")).toBeNull();
    expect(checkSpaceMethod(nofold, "basin_hopping", { nope: 1 })).toMatch(
      /^basin_hopping: params: unknown parameter nope/,
    );
  });

  it("names a result's method as the spaces' earlier names read", () => {
    expect(spaceMethodName("sphere")).toBe("sphere basin hopping");
    expect(spaceMethodName("sphere", "auto")).toBe("sphere basin hopping");
    expect(spaceMethodName("boundary", "basin_hopping")).toBe("boundary basin_hopping");
    expect(spaceMethodName("torus", SPACE_METHOD.torus)).toBe("torus basin hopping");
    // a description kept from an older record
    expect(spaceMethodName("surface", "nofold face packing: penalty")).toBe("nofold face packing: penalty");
    expect(searchMethodName(nofold, "auto")).toBe("surface nofold: basin hopping on one face");
    expect(searchMethodName(nofold, "mc_compress")).toBe("surface nofold: mc_compress on one face");
    expect(searchMethodName(sphere, "penalty")).toBe("sphere penalty");
  });
});

describe("one job's method", () => {
  // Auto is the spaces' own search, bit for bit as at commit bf769f2, under any of its names. The
  // stored results were recorded on Apple Silicon (darwin arm64): V8's Math functions may differ in
  // the last bit on other platforms, and a seeded search amplifies that, so elsewhere (CI's Linux
  // runner) the test checks what holds everywhere: the same result under every name, valid by the
  // server's rule.
  const pinned = JSON.parse(readFileSync(resolve(__dirname, "auto-bf769f2.json"), "utf8")).jobs as Record<
    string,
    { score: number | null; evaluations: number; termination: string; config: string }
  >;
  const recordedHere = process.platform === "darwin" && process.arch === "arm64";
  const names = [undefined, AUTO, "label"] as const;
  for (const [key, expected] of Object.entries(pinned)) {
    const [id, kind, evals] = key.split(" ");
    // async, yielding after each job: these synchronous searches add up to over a minute on CI's
    // 2-core runner, and Vitest's worker must answer its runner at least once a minute
    it(`runs Auto as at bf769f2, under each of its names: ${key}`, async () => {
      const space = id.split("/")[0] as SpaceJob["space"];
      const results = [];
      for (const name of names) {
        const method = name === "label" ? SPACE_METHOD[space] : name;
        const r = runSpaceJob(
          {
            space,
            id,
            ...(method === undefined ? {} : { method }),
            seed: 12345,
            budget: { time_s: 3000, evals: Number(evals) },
            kind: kind as SpaceJob["kind"],
            rule: {},
            ...(kind === "iterate" ? { start: recordOf(id) } : {}),
          },
          go,
        );
        const config = createHash("sha1")
          .update(JSON.stringify(r.config ?? null))
          .digest("hex")
          .slice(0, 16);
        results.push({ result: { score: r.score, evaluations: r.evaluations, termination: r.termination, config }, r });
        await new Promise((resolve) => setImmediate(resolve));
      }
      for (const { result } of results.slice(1)) expect(result).toEqual(results[0].result);
      if (recordedHere) expect(results[0].result).toEqual(expected);
      else if (results[0].r.config !== null) expect(results[0].r.valid).toBe(true);
    });
  }

  it("gives an error result for an unknown method or bad parameters, and does not run", () => {
    withoutKernels();
    const bad: [Partial<SpaceJob>, RegExp][] = [
      [{ method: "no_such_method" }, /unknown method/],
      [{ method: restarts.name }, /offers no generic method/],
      [{ method: "auto", params: { hops: 1 } }, /takes no parameters/],
    ];
    for (const [o, why] of bad) {
      const r = runSpaceJob(job("sphere/4/10", o), go);
      expect(r).toMatchObject({ valid: false, score: null, evaluations: 0, termination: "error" });
      expect(r.reasons[0]).toMatch(why);
    }
    withDisks();
    const r = runSpaceJob(job(DISKS, { method: restarts.name, params: { mu: "big" } }), go);
    expect(r.termination).toBe("error");
    expect(r.reasons[0]).toMatch(/^spaces_test_restarts: params\.mu: expected finite number$/);
  });

  it("runs a generic method end to end on the problem's kernel, checked by the server's rule", () => {
    withDisks();
    const start = grown();
    const startScore = checkSpaceConfig("curved", DISKS, start, rule).score!;
    const j = job(DISKS, { method: restarts.name, params: { mu: 1e5 }, start });
    const r = runSpaceJob(j, go);
    expect(r.valid, r.reasons.join("; ")).toBe(true);
    expect(r.score!).toBeLessThan(startScore);
    // within a few percent of the optimum, 3 [EST] (Packomania), and never below it
    expect(r.score!).toBeLessThan(3 * 1.03);
    expect(r.score!).toBeGreaterThanOrEqual(3 * (1 - 1e-9));
    expect(checkSpaceConfig("curved", DISKS, r.config, rule)).toMatchObject({ valid: true, score: r.score });
    expect(r.termination).toBe("evals");
    expect(r.evaluations).toBeGreaterThanOrEqual(3000);
    expect(r.evaluations).toBeLessThan(3100);
    // reproducible from the job
    const again = runSpaceJob(j, go);
    expect(again.config).toEqual(r.config);
    expect(again.evaluations).toBe(r.evaluations);
  });

  it("builds its own start in a fresh job, keeping the given one as a candidate", () => {
    withDisks();
    const r = runSpaceJob(job(DISKS, { method: restarts.name, kind: "fresh" }), go);
    expect(r.valid, r.reasons.join("; ")).toBe(true);
    expect(r.score!).toBeLessThan(3 * 1.1);
    // the method gets no start in a fresh job, and the job's start in any other
    const start = grown();
    const fresh = runSpaceJob(job(DISKS, { method: probe.name, kind: "fresh", start }), go);
    expect(probeSeen.start).toBe(false);
    expect(fresh.score!).toBeLessThanOrEqual(start.size);
    runSpaceJob(job(DISKS, { method: probe.name, kind: "iterate", start }), go);
    expect(probeSeen.start).toBe(true);
  });

  it("gives the method the job's parameters, and no evaluation cap when the job has none", () => {
    withDisks();
    runSpaceJob(job(DISKS, { method: probe.name, params: { mu: 123 } }), go);
    expect(probeSeen.params).toEqual({ mu: 123 });
    expect(probeSeen.remaining).toBe(3000);
    runSpaceJob(job(DISKS, { method: probe.name, budget: { time_s: 60 } }), go);
    expect(probeSeen.params).toEqual(probe.defaults);
    // a time budget alone: the method sizes nothing to a cap it does not have
    expect(probeSeen.remaining).toBe(Infinity);
  });

  it("keeps a method's improvement only when it passes the job's whole rule", () => {
    withDisks();
    // the problem's own bound: the squeezed packing (about 3) passes
    runSpaceJob(job(DISKS, { method: probe.name, kind: "fresh" }), go);
    expect(probeSeen.offered).toBeGreaterThan(2.99);
    // a rule whose bound lies above every packing the method finds: the server's rule refuses them
    // all, though the kernel's own check (with the problem's bound) would take them
    const r = runSpaceJob(job(DISKS, { method: probe.name, kind: "fresh", rule: { ...rule, bound: 3.5 } }), go);
    expect(probeSeen.offered).toBeNull();
    expect(r.valid).toBe(false);
  });

  it("ends at the gate: an aborted job returns its best so far, and the time budget counts active seconds", () => {
    withDisks();
    const start = grown();
    const aborted = runSpaceJob(job(DISKS, { method: restarts.name, start }), { aborted: true, paused: false });
    expect(aborted.termination).toBe("aborted");
    expect(aborted.score).toBe(checkSpaceConfig("curved", DISKS, start, rule).score);
    // a fake clock that moves 1 s at every read: the job ends on its 5 s
    let t = 0;
    const timed = runSpaceJob(job(DISKS, { method: restarts.name, start, budget: { time_s: 5 } }), go, () => t++);
    expect(timed.termination).toBe("time");
    expect(timed.valid).toBe(true);
  });
});

describe("the volunteer's engine", () => {
  const control = (): Control => ({ aborted: false, paused: false });
  /** Jobs of a short search, answered at once with a fixed result on a fake clock. */
  async function jobsOf(method: string | undefined, params?: Record<string, unknown>) {
    const clock = { t: 0 };
    const jobs: SpaceJob[] = [];
    await searchSpaceProblem(
      {
        space: "curved",
        id: DISKS,
        bound: null,
        maxSeconds: 20,
        lanes: 1,
        seed: 1,
        now: () => clock.t,
        ...(method === undefined ? {} : { method }),
        ...(params ? { params } : {}),
      },
      async (j): Promise<SpaceJobResult> => {
        jobs.push(j);
        clock.t += 2;
        return { job: j, score: null, valid: false, evaluations: 10, wallTime: 2, termination: "evals", reasons: [] };
      },
      control(),
    );
    return jobs;
  }

  it("gives every job the chosen method and parameters where the problem offers it, else Auto", async () => {
    withoutKernels();
    expect((await jobsOf(undefined)).every((j) => j.method === AUTO && j.params === undefined)).toBe(true);
    // no kernel: Auto
    expect((await jobsOf(restarts.name, { mu: 10 })).every((j) => j.method === AUTO && j.params === undefined)).toBe(
      true,
    );
    withDisks();
    const jobs = await jobsOf(restarts.name, { mu: 10 });
    expect(jobs.length).toBeGreaterThan(2);
    expect(jobs.every((j) => j.method === restarts.name)).toBe(true);
    expect(jobs.every((j) => JSON.stringify(j.params) === JSON.stringify({ mu: 10 }))).toBe(true);
    // a method the kernel cannot run: Auto
    expect((await jobsOf(swapper.name)).every((j) => j.method === AUTO)).toBe(true);
  });

  it("says which method a problem's jobs run, and when it falls back to Auto", () => {
    withDisks();
    expect(chooseSpaceMethod("curved", DISKS, undefined)).toEqual({ method: AUTO, fallback: false });
    expect(chooseSpaceMethod("curved", DISKS, restarts.name)).toEqual({ method: restarts.name, fallback: false });
    expect(chooseSpaceMethod("curved", DISKS, swapper.name)).toEqual({ method: AUTO, fallback: true });
    expect(chooseSpaceMethod("curved", "curved/-1/0/0/7", restarts.name)).toEqual({ method: AUTO, fallback: true });
    expect(chooseSpaceMethod("surface", "surface/cube/nofold/4/13", "penalty")).toEqual({
      method: AUTO,
      fallback: true,
    });
  });

  it("hands a generic method that reached its kernel's bound over to Auto, and ends only on Auto's", async () => {
    withDisks();
    const clock = { t: 0 };
    const jobs: SpaceJob[] = [];
    const out = await searchSpaceProblem(
      {
        space: "curved",
        id: DISKS,
        bound: 2,
        known: { config: grown(), score: grown().size, source: "certified" },
        maxSeconds: 600,
        lanes: 1,
        seed: 1,
        now: () => clock.t,
        method: restarts.name,
        params: { mu: 10 },
      },
      async (j): Promise<SpaceJobResult> => {
        jobs.push(j);
        clock.t += 2;
        // the second job ends at its search's floor, 3, above the problem's bound 2; so does the fourth
        const n = jobs.length;
        const score = n >= 2 ? 3 : 3.1;
        return {
          job: j,
          score,
          valid: true,
          config: { size: score, pieces: [] },
          evaluations: 10,
          wallTime: 2,
          termination: n === 2 || n === 4 ? "bound" : "evals",
          reasons: [],
        };
      },
      control(),
    );
    expect(jobs.slice(0, 2).map((j) => j.method)).toEqual([restarts.name, restarts.name]);
    // after the generic job's "bound", auto, until auto's own "bound" ends the problem
    expect(jobs.slice(2).map((j) => j.method)).toEqual([AUTO, AUTO]);
    expect(jobs[2].params).toBeUndefined();
    expect(out.stopped).toBe("bound");
  });
});

describe("a method's name in a submission", () => {
  it("adds the parameters when they fit", () => {
    expect(spaceMethodNote("sphere", "penalty", { seedShare: 0.5 })).toBe('sphere penalty {"seedShare":0.5}');
    expect(spaceMethodNote("sphere", "penalty", {})).toBe("sphere penalty");
    expect(spaceMethodNote("sphere", "auto", undefined)).toBe("sphere basin hopping");
    expect(spaceMethodNote("sphere", "penalty", { x: "y".repeat(80) })).toBe("sphere penalty");
    expect(spaceMethodNote("sphere", "penalty", { x: "y".repeat(80) }, Infinity)).toMatch(
      /^sphere penalty \{"x":"y+"\}$/,
    );
  });
});

describe("the balls kernel", () => {
  /** The balls space's test packings, shared with its certifier's tests (python/balls/fixtures/packings.json). */
  const packings = JSON.parse(readFileSync(resolve(root, "python/balls/fixtures/packings.json"), "utf8"))
    .packings as { id: string; code: string; P: number; config: BallsConfig }[];
  /** The rule the server applies to a balls problem: its domain's bound, and the strict check (no research records). */
  const ruleOf = (id: string) => {
    const parsed = parseSpaceId("balls", id);
    if (typeof parsed === "string") throw new Error(parsed);
    return { bound: SPACE_DOMAINS.balls!.bound(parsed)!.value, noRecord: true };
  };
  const tick = () => new Promise((r) => setImmediate(r));

  /** A packing and its variants: valid, within each tolerance and beyond it, below the bound, malformed. */
  function variants(base: BallsConfig, bound: number): [string, unknown][] {
    const withS = (s: unknown) => ({ s, pieces: base.pieces });
    const first = (f: (p: number[]) => unknown) => ({ s: base.s, pieces: base.pieces.map((p, i) => (i === 0 ? f(p) : p)) });
    const holed: unknown[] = base.pieces.slice();
    delete holed[0];
    const solid = base.pieces[0].length === 7;
    const out: [string, unknown][] = [
      ["packing", base],
      // the packings keep a clearance of 1e-10: these shrink it to within the strict tolerance, the touching one, and beyond
      ["s (1 - 2e-11)", withS(base.s * (1 - 2e-11))],
      ["s (1 - 1e-10)", withS(base.s * (1 - 1e-10))],
      ["s (1 - 3e-10)", withS(base.s * (1 - 3e-10))],
      ["s (1 - 3e-9)", withS(base.s * (1 - 3e-9))],
      ["s (1 - 1e-6)", withS(base.s * (1 - 1e-6))],
      ["bound (1 - 0.9e-9)", withS(bound * (1 - 0.9e-9))],
      ["bound (1 - 1.1e-9)", withS(bound * (1 - 1.1e-9))],
      ["s 2e6", withS(2e6)],
      ["s 0", withS(0)],
      ["s negative", withS(-1)],
      ["s a string", withS("2")],
      ["s NaN", withS(NaN)],
      ["s missing", { pieces: base.pieces }],
      ["x0 + 1e-10", first((p) => [p[0] + 1e-10, ...p.slice(1)])],
      ["x0 + 1e-9", first((p) => [p[0] + 1e-9, ...p.slice(1)])],
      ["x0 + 1e-3", first((p) => [p[0] + 1e-3, ...p.slice(1)])],
      ["x0 + 50", first((p) => [p[0] + 50, ...p.slice(1)])],
      ["x0 2e4", first((p) => [2e4, ...p.slice(1)])],
      ["a piece short", first((p) => p.slice(0, -1))],
      ["a piece long", first((p) => [...p, 0])],
      ["a coordinate a string", first((p) => [String(p[0]), ...p.slice(1)])],
      ["two pieces at one place", { s: base.s, pieces: base.pieces.map((p, i) => (i === 1 ? base.pieces[0] : p)) }],
      ["a piece not an array", first(() => 3)],
      ["a hole in the list", { s: base.s, pieces: holed }],
      ["pieces not an array", { s: base.s, pieces: {} }],
      ["one piece fewer", { s: base.s, pieces: base.pieces.slice(1) }],
      ["unknown fields", { ...base, junk: 1 }],
      ["not an object", [base]],
      ["null", null],
    ];
    if (solid)
      out.push(
        ["q tiny", first((p) => [...p.slice(0, 3), 1e-7, 0, 0, 0])],
        ["q huge", first((p) => [...p.slice(0, 3), 1e101, 0, 0, 0])],
        ["q not unit", first((p) => [...p.slice(0, 3), ...p.slice(3).map((v) => 3 * v)])],
        ["q turned", first((p) => [...p.slice(0, 3), Math.cos(0.3), Math.sin(0.3), 0, 0])],
      );
    return out;
  }

  it("validates as the server does: on the test packings and their variants, and on configurations it finished", async () => {
    let compared = 0;
    let strictOnly = 0;
    for (const p of packings.filter((q) => q.P <= 30)) {
      const k = ballsKernel({ code: p.code, P: p.P });
      const rule = ruleOf(p.id);
      expect(k.bound).toBe(rule.bound);
      const same = (label: string, config: unknown) => {
        const server = validateSpaceSubmission("balls", p.id, config, rule);
        const mine = k.validate(config);
        expect({ id: p.id, label, ...mine }).toEqual({
          id: p.id,
          label,
          valid: server.valid,
          score: server.score,
          reasons: server.reasons,
        });
        // valid within the touching tolerance only: refused by the strict check of a problem without records
        if (!server.valid && validateSpaceSubmission("balls", p.id, config, { bound: rule.bound }).valid) strictOnly++;
        compared++;
      };
      for (const [label, config] of variants(p.config, rule.bound)) same(label, config);
      const rng = mulberry32(p.P);
      const s = k.randomStart(rng);
      squeeze(k, s, { maxIter: 60 });
      for (const q of [s, ...k.seeds!(rng, 2)]) {
        const f = k.finish(q);
        if (!f) continue;
        same("finished", f.config);
        same("finished, shrunk by 2e-11", { ...(f.config as object), s: f.score * (1 - 2e-11) });
        same("finished, shrunk by 2e-9", { ...(f.config as object), s: f.score * (1 - 2e-9) });
      }
      await tick();
    }
    expect(compared).toBeGreaterThan(28 * 30);
    expect(strictOnly).toBeGreaterThan(20);
  });

  it("validates the new problems as the server does: a found packing and its variants", async () => {
    let compared = 0;
    for (const code of BALLS_FAMILY_SAMPLE) {
      const P = 3;
      const id = `balls/${code}/${P}`;
      const rule = ruleOf(id);
      const k = ballsKernel({ code, P });
      expect(k.bound).toBe(rule.bound);
      const found = searchBalls(getBallsProblem(code)!, P, { seed: 5, maxEvals: 2500 }).config!;
      for (const [label, config] of variants(found, rule.bound)) {
        const server = validateSpaceSubmission("balls", id, config, rule);
        const mine = k.validate(config);
        expect({ id, label, ...mine }).toEqual({ id, label, valid: server.valid, score: server.score, reasons: server.reasons });
        compared++;
      }
      // the packing is valid by the server's rule, and so is the unchanged variant
      expect(validateSpaceSubmission("balls", id, found, rule).valid, id).toBe(true);
      await tick();
    }
    expect(compared).toBeGreaterThan(17 * 25);
  });

  it("runs Auto on the new problems at P = 2 to 4, and two generic methods, each result valid by the server's rule", async () => {
    for (const code of BALLS_FAMILY_SAMPLE)
      for (const P of [2, 3, 4]) {
        const id = `balls/${code}/${P}`;
        const rule = ruleOf(id);
        const k = ballsKernel({ code, P });
        const evals = 2 * (k.finishCost + k.validateCost!) + 1500;
        for (const method of P === 3 ? [AUTO, "basin_hopping", "harden"] : [AUTO]) {
          const r = runSpaceJob(job(id, { method, rule, kind: "fresh", budget: { time_s: 60, evals } }), go);
          expect(r.valid, `${id} ${method}: ${r.reasons.join("; ")}`).toBe(true);
          expect(validateSpaceSubmission("balls", id, r.config, rule), `${id} ${method}`).toMatchObject({ valid: true, score: r.score });
          expect(r.score!, `${id} ${method}`).toBeGreaterThanOrEqual(rule.bound * (1 - 1e-9));
        }
        await tick();
      }
  });

  it("runs generic methods on balls problems, each result valid by the server's rule for a problem without records", async () => {
    for (const code of BALLS_ORIGINAL_CODES) {
      const id = `balls/${code}/4`;
      const rule = ruleOf(id);
      const k = ballsKernel({ code, P: 4 });
      for (const method of ["basin_hopping", "harden"]) {
        const evals = 2 * (k.finishCost + k.validateCost!) + 2000;
        const r = runSpaceJob(job(id, { method, rule, kind: "fresh", budget: { time_s: 60, evals } }), go);
        expect(r.valid, `${id} ${method}: ${r.reasons.join("; ")}`).toBe(true);
        expect(validateSpaceSubmission("balls", id, r.config, rule), `${id} ${method}`).toMatchObject({
          valid: true,
          score: r.score,
        });
        expect(r.score!, `${id} ${method}`).toBeGreaterThanOrEqual(rule.bound);
        await tick();
      }
    }
  });
});
