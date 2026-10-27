/**
 * The polyhedra space's problems for every pair of its 94 solids: ids, the domain, the strict check of an entry,
 * and Auto and the generic methods through the polyhedra kernel on a sample of new pairs. P = 2 to 3, short budgets.
 */
import { describe, expect, it } from "vitest";
import { getProblem, volumeBound } from "@polypack/polyhedra";
import { SPACE_DOMAINS, domainId, formatSpaceId, parseSpaceId, problemOf, buildSpaceCatalogue, hasRecord, acceptsSubmissions, validateSpaceSubmissionAsync, parseSpaceConfig } from "../src";
import { AUTO, parseSearchProblem, runSpaceJob, spaceKernel, spaceLatticeStart, spaceMethodsFor, checkSpaceConfig, type SpaceJob } from "../src/search";

const CODES = ["kttinpkd", "pr12l3intet", "bp12inap4", "tz6inpr3l15", "tidinktt", "ap9inbp5", "pr7intz6", "dtcinbp3"];
const go = { aborted: false, paused: false };
const job = (id: string, o: Partial<SpaceJob> = {}): SpaceJob => ({
  space: "polyhedra", id, seed: 5, kind: "fresh", budget: { time_s: 30, evals: 2_500 }, ...o,
});

describe("polyhedra pairs without records", () => {
  it("are problems of the domain with their volume bound, open to entries, and have one id each", () => {
    const d = SPACE_DOMAINS.polyhedra!;
    const c = buildSpaceCatalogue("polyhedra", null, d);
    for (const code of CODES) {
      for (const P of [2, 3, 500]) {
        const parsed = parseSpaceId("polyhedra", `polyhedra/${code}/${P}`);
        if (typeof parsed === "string") throw new Error(parsed);
        expect(parsed.fields).toMatchObject({ code, P });
        expect(formatSpaceId("polyhedra", parsed.fields)).toBe(parsed.id);
        expect(domainId(d.info, parsed.fields)).toBe(parsed.id);
        // the id also reads from the menus' values alone
        expect(domainId(d.info, { piece: code.split("in")[0], container: code.split("in")[1], P })).toBe(parsed.id);
        const p = problemOf(c, parsed)!;
        expect(p).toMatchObject({ status: "no_record", certified: null, config: null });
        expect(hasRecord(p)).toBe(false);
        expect(acceptsSubmissions(p)).toBe(true);
        expect(p.bound!.value).toBeCloseTo(volumeBound(getProblem(code)!, P), 12);
        expect(p.bound!.label).toBe("volume bound; [CALC]");
      }
      const out = parseSpaceId("polyhedra", `polyhedra/${code}/501`);
      if (typeof out === "string") throw new Error(out);
      expect(problemOf(c, out)).toBeNull();
    }
    expect(typeof parseSpaceId("polyhedra", "polyhedra/kttinxyz/5")).toBe("string");
  });

  it("are checked strictly at the limits: the largest solids in the smallest, 500 pieces", async () => {
    for (const code of ["dtcintet", "pr12l3intet", "tidinbp3"]) {
      const p = parseSearchProblem(`polyhedra/${code}/500`)!;
      const c = spaceLatticeStart(p)!;
      const parsed = parseSpaceId("polyhedra", p.id);
      if (typeof parsed === "string") throw new Error(parsed);
      expect(parseSpaceConfig(parsed, c).ok, code).toBe(true);
      const v = await validateSpaceSubmissionAsync("polyhedra", p.id, c, { noRecord: true });
      expect(v.valid, `${code}: ${v.reasons.join("; ")}`).toBe(true);
    }
  }, 60_000);

  it("have a kernel, so that Auto and every generic method are offered, and run to valid packings", () => {
    for (const [i, code] of CODES.slice(0, 5).entries()) {
      const id = `polyhedra/${code}/${2 + (i % 2)}`;
      const p = parseSearchProblem(id)!;
      expect(spaceKernel(p), id).not.toBeNull();
      const names = spaceMethodsFor(p).map((m) => m.name);
      expect(names[0]).toBe(AUTO);
      for (const m of ["penalty", "mc_compress", "asc", "basin_hopping", "shrink_repair", "seed"]) expect(names, id).toContain(m);
      for (const method of [undefined, "penalty", "seed"]) {
        const r = runSpaceJob(job(id, method ? { method } : {}), go);
        expect(r.valid, `${id} ${method ?? "auto"}: ${r.reasons.join("; ")}`).toBe(true);
        expect(checkSpaceConfig("polyhedra", id, r.config, { bound: volumeBound(getProblem(code)!, p.P), certified: null })).toMatchObject({ valid: true, score: r.score });
        expect(r.score!, id).toBeGreaterThanOrEqual(volumeBound(getProblem(code)!, p.P) * (1 - 1e-9));
      }
    }
  }, 120_000);
});
