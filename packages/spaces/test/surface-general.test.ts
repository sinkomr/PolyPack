/**
 * The surface space beyond the Platonic solids: ids, the server's check and the search jobs (budget,
 * seed, stop and pause) on Catalan solids, prisms and antiprisms. The test packings come from
 * python/surface/fixtures/general_packings.json (packages/surface/scripts/build-test-packings.ts).
 * Assertions are on properties, not on seeded outcomes (CI runs another Node version).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_SOLID_NAMES, getSolid } from "@polypack/surface";
import { describe, expect, it } from "vitest";
import { SURFACE_SOLIDS, formatSpaceId, parseSpaceId, validateSpaceSubmission } from "../src";
import {
  SPACE_METHOD,
  SURFACE_NOFOLD_METHOD,
  type SpaceJob,
  checkSpaceConfig,
  methodOf,
  nofoldOnPolygonEngine,
  parseSearchProblem,
  readSpaceConfig,
  runSpaceJob,
} from "../src/search";

const packings = JSON.parse(
  readFileSync(resolve(__dirname, "../../../python/surface/fixtures/general_packings.json"), "utf8"),
).records as { id: string; solid: string; mode: string; N: number; P: number; s: number; pieces: { face: number; x: number; y: number; theta: number }[] }[];
const packing = (id: string) => {
  const r = packings.find((x) => x.id === id);
  if (!r) throw new Error(`no test packing ${id}`);
  return { s: r.s, pieces: r.pieces };
};
const grown = (c: { s: number; pieces: { face: number; x: number; y: number; theta: number }[] }, f: number) => ({
  s: c.s * f,
  pieces: c.pieces.map((q) => ({ ...q, x: q.x * f, y: q.y * f })),
});
const job = (id: string, o: Partial<SpaceJob> = {}): SpaceJob => ({
  space: "surface",
  id,
  method: methodOf("surface", id),
  seed: 5,
  budget: { time_s: 60, evals: 2 },
  kind: "iterate",
  ...o,
});
const go = { aborted: false, paused: false };
const yieldToRunner = () => new Promise((r) => setTimeout(r, 0));

describe("surface ids beyond the Platonic solids", () => {
  it("lists every solid of the surface package, and parses and writes back their ids", () => {
    expect([...SURFACE_SOLIDS]).toEqual([...ALL_SOLID_NAMES]);
    for (const solid of SURFACE_SOLIDS)
      for (const mode of ["fold", "nofold"]) {
        const id = `surface/${solid}/${mode}/6/24`;
        const p = parseSpaceId("surface", id);
        expect(typeof p).not.toBe("string");
        if (typeof p === "string") continue;
        expect(p.fields).toEqual({ solid, mode, N: 6, P: 24 });
        expect(formatSpaceId("surface", p.fields)).toBe(id);
        const q = parseSearchProblem(id);
        expect(q).toMatchObject({ space: "surface", solid, mode, N: 6, P: 24 });
        expect(nofoldOnPolygonEngine(q!)).toBe(mode === "nofold" && getSolid(solid as never).uniform);
      }
    for (const id of ["surface/prism4/fold/0/3", "surface/antiprism3/fold/0/3", "surface/Prism5/fold/0/3", "surface/prism05/fold/0/3", "surface/truncated_cube/fold/0/3", "surface/prism5/fold/2/3"]) {
      expect(typeof parseSpaceId("surface", id)).toBe("string");
      expect(parseSearchProblem(id)).toBeNull();
    }
    expect(methodOf("surface", "surface/prism5/nofold/0/3")).toBe(SURFACE_NOFOLD_METHOD);
    expect(methodOf("surface", "surface/cube/nofold/0/3")).toBe(SPACE_METHOD.surface);
    expect(methodOf("surface", "surface/prism5/fold/0/3")).toBe(SPACE_METHOD.surface);
  });

  it("reads configurations with face indices up to the largest solid's 120 faces", () => {
    const p = parseSearchProblem("surface/disdyakis_triacontahedron/fold/0/1")!;
    expect(readSpaceConfig(p, { s: 3, pieces: [{ face: 119, x: 0, y: 0, theta: 0 }] })).not.toBeNull();
    const v = validateSpaceSubmission("surface", p.id, { s: 3, pieces: [{ face: 120, x: 0, y: 0, theta: 0 }] });
    expect(v.valid).toBe(false);
    expect(v.reasons[0]).toMatch(/from 0 to 119/);
  });
});

describe("the server's check on the new solids", () => {
  it("accepts every test packing in its mode, and refuses it 1e-6 smaller", () => {
    for (const r of packings) {
      const config = { s: r.s, pieces: r.pieces };
      expect(checkSpaceConfig("surface", r.id, config).valid, r.id).toBe(true);
      const shrunk = { s: r.s * (1 - 1e-6), pieces: r.pieces };
      expect(checkSpaceConfig("surface", r.id, shrunk).valid, r.id).toBe(false);
    }
  });

  it("refuses a folding test packing as a nofold one, and accepts a nofold one as folding", () => {
    for (const r of packings) {
      const other = r.id.replace(`/${r.mode}/`, r.mode === "fold" ? "/nofold/" : "/fold/");
      expect(checkSpaceConfig("surface", other, { s: r.s, pieces: r.pieces }).valid, other).toBe(r.mode === "nofold");
    }
  });
});

describe("search jobs on the new solids", () => {
  it("a fold job from an enlarged test packing returns a valid, better packing within its evaluations", async () => {
    for (const id of ["surface/rhombic_dodecahedron/fold/0/3", "surface/antiprism4/fold/3/3"]) {
      const start = grown(packing(id), 1.03);
      const r = runSpaceJob(job(id, { start }), go);
      expect(r.valid, r.reasons.join("; ")).toBe(true);
      expect(r.score!).toBeLessThan(start.s);
      expect(checkSpaceConfig("surface", id, r.config)).toMatchObject({ valid: true, score: r.score });
      expect(r.evaluations).toBeLessThanOrEqual(3);
      await yieldToRunner();
    }
  });

  it("a nofold job keeps every piece in its face, from a start and from nothing", async () => {
    const id = "surface/deltoidal_icositetrahedron/nofold/3/26";
    const start = grown(packing(id), 1.05);
    const r = runSpaceJob(job(id, { start }), go);
    expect(r.valid, r.reasons.join("; ")).toBe(true);
    expect(r.score!).toBeLessThan(start.s);
    expect(checkSpaceConfig("surface", id, r.config).valid).toBe(true);
    await yieldToRunner();
    for (const id2 of ["surface/prism5/nofold/0/9", "surface/rhombic_dodecahedron/nofold/6/5"]) {
      const fresh = runSpaceJob(job(id2, { kind: "fresh", budget: { time_s: 60, evals: 3 } }), go);
      expect(fresh.valid, fresh.reasons.join("; ")).toBe(true);
      expect(checkSpaceConfig("surface", id2, fresh.config).valid).toBe(true);
      await yieldToRunner();
    }
    // a Platonic nofold problem is the polygon engine's
    expect(runSpaceJob(job("surface/cube/nofold/0/7"), go)).toMatchObject({ valid: false, termination: "error" });
  });

  it("is reproducible from its seed and evaluation cap", async () => {
    const id = "surface/prism5/fold/0/3";
    const fresh = job(id, { kind: "fresh", seed: 11, budget: { time_s: 120, evals: 2 } });
    const a = runSpaceJob(fresh, go);
    await yieldToRunner();
    const b = runSpaceJob(fresh, go);
    expect(a.valid).toBe(true);
    expect(b.config).toEqual(a.config);
    expect(b.score).toBe(a.score);
  });

  it("stops on its active time, at once when aborted, and does not count a pause", async () => {
    const id = "surface/deltoidal_icositetrahedron/fold/6/3";
    let t = 0;
    const clock = () => (t += 0.01);
    const timed = runSpaceJob(job(id, { kind: "fresh", budget: { time_s: 1 } }), go, clock);
    expect(timed.termination).toBe("time");
    // the search stops at four fifths of the budget and its final stage at most 1.5 s later
    expect(timed.wallTime).toBeGreaterThanOrEqual(0.8);
    expect(timed.wallTime).toBeLessThan(1 + 1.5 + 0.5);
    await yieldToRunner();
    const start = packing(id);
    const aborted = runSpaceJob(job(id, { start, budget: { time_s: 60 } }), { aborted: true, paused: false });
    expect(aborted.termination).toBe("aborted");
    expect(aborted.valid).toBe(true); // the start itself
    expect(aborted.score).toBe(start.s);
    await yieldToRunner();
    // paused for the first polls: the wait is not active time
    let polls = 0;
    let waited = 0;
    const control = {
      aborted: false,
      get paused() {
        return ++polls < 4;
      },
      wait(ms: number) {
        waited += ms;
      },
    };
    let u = 0;
    const paused = runSpaceJob(job(id, { start, budget: { time_s: 0.5 } }), control, () => (u += 0.01));
    expect(waited).toBeGreaterThan(0);
    expect(paused.valid).toBe(true);
    expect(paused.termination).toBe("time");
    // a start of another problem is refused
    expect(runSpaceJob(job("surface/prism5/fold/6/3", { start }), go)).toMatchObject({ valid: false, termination: "error" });
  });
});
