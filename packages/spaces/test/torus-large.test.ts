/** Torus problems up to 500 pieces: the domain, the lattice start, the checks and the searches at P = 500. */
import { describe, expect, it } from "vitest";
import { SPACE_DOMAINS, SPACE_MAX_P, domainId, parseSpaceConfig, parseSpaceId, validateSpaceSubmissionAsync } from "../src";
import {
  TORUS_LATTICE_START_FROM_P,
  hasLatticeStart,
  parseSearchProblem,
  runSpaceJob,
  searchSpaceProblem,
  spaceKernel,
  spaceLatticeStart,
  spaceMethodsFor,
} from "../src/search";

const tick = () => new Promise((r) => setImmediate(r));

describe("torus up to 500 pieces", () => {
  it("has 3 families, 99 shapes and P = 1 to 500, bounds and ids at both ends", () => {
    const d = SPACE_DOMAINS.torus!;
    expect(d.info.problems).toBe(3 * 99 * 500);
    expect(SPACE_MAX_P.torus).toBe(500);
    for (const P of [1, 100, 101, 500]) {
      const parsed = parseSpaceId("torus", `torus/hex/7/${P}`);
      if (typeof parsed === "string") throw new Error(parsed);
      expect(domainId(d.info, parsed.fields)).toBe(parsed.id);
      expect(d.bound(parsed)!.value).toBeGreaterThan(0);
    }
    const over = parseSpaceId("torus", "torus/hex/7/501");
    if (typeof over === "string") throw new Error(over);
    expect(d.bound(over)).toBeUndefined();
    // the work list's sample (and so the volunteers' default draw) stays within P <= 100
    expect(d.sample(2000).every((id) => Number(id.split("/").at(-1)) <= 100)).toBe(true);
  });

  it("offers the lattice start only above P = 100, and it is a configuration of the problem", async () => {
    expect(TORUS_LATTICE_START_FROM_P).toBe(100);
    expect(hasLatticeStart(parseSearchProblem("torus/hex/7/100")!)).toBe(false);
    expect(spaceLatticeStart(parseSearchProblem("torus/hex/7/100")!)).toBeNull();
    for (const id of ["torus/sq/0/500", "torus/hex/5/499", "torus/free/100/101", "torus/free/3/500"]) {
      const p = parseSearchProblem(id)!;
      expect(hasLatticeStart(p)).toBe(true);
      const c = spaceLatticeStart(p)!;
      const parsed = parseSpaceId("torus", id);
      if (typeof parsed === "string") throw new Error(parsed);
      expect(parseSpaceConfig(parsed, c).ok).toBe(true);
      const v = await validateSpaceSubmissionAsync("torus", id, c, { noRecord: true });
      expect(v.valid, `${id}: ${v.reasons}`).toBe(true);
      await tick();
    }
  });

  it("starts a volunteer job without a record from the lattice, and one at P <= 100 from nothing", async () => {
    const starts = async (id: string) => {
      let seconds = 0;
      const out: unknown[] = [];
      await searchSpaceProblem(
        { space: "torus", id, noRecord: true, bound: null, maxSeconds: 1, lanes: 1, seed: 1, now: () => seconds },
        async (job) => {
          out.push(job.start);
          seconds = 2;
          return { job, score: null, valid: false, evaluations: 0, wallTime: 2, termination: "time", reasons: [] };
        },
        { aborted: false, paused: false },
      );
      return out;
    };
    expect(await starts("torus/hex/5/300")).toEqual([spaceLatticeStart(parseSearchProblem("torus/hex/5/300")!)]);
    expect(await starts("torus/hex/5/30")).toEqual([undefined]);
  });

  it("runs the search and every generic method at P = 500 within a time limit, keeping a valid start", async () => {
    const id = "torus/hex/3/500";
    const p = parseSearchProblem(id)!;
    const start = spaceLatticeStart(p)!;
    expect(spaceKernel(p)).not.toBeNull();
    const start0 = runSpaceJob({ space: "torus", id, seed: 1, budget: { time_s: 5, evals: 3 }, kind: "iterate", start, rule: { bound: null, certified: null, noRecord: true } }, { aborted: false, paused: false });
    expect(start0.valid).toBe(true);
    for (const m of spaceMethodsFor(p)) {
      // a generic method's job ends on its time limit (a tenth of a second plus one evaluation) or its evaluations
      const r = runSpaceJob(
        { space: "torus", id, method: m.name, seed: 2, budget: { time_s: 0.1, evals: 20 }, kind: "iterate", start, rule: { bound: null, certified: null, noRecord: true } },
        { aborted: false, paused: false },
      );
      expect(r.termination, m.name).not.toBe("error");
      expect(r.valid, m.name).toBe(true);
      expect(r.score!, m.name).toBeLessThanOrEqual(start0.score! * (1 + 1e-9));
      expect(r.wallTime, m.name).toBeLessThan(10);
      await tick();
    }
  }, 60000);
});
