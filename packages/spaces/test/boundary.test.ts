/**
 * The boundary space ("3D on 4D": unit balls and cubes on the boundary of a tesseract) in the
 * registry: its ids, catalogue, nofold extras, configuration parsing and the server's rule.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PIECES, POLYTOPES, formatBoundaryId, validateBoundary } from "@polypack/boundary";
import { describe, expect, it } from "vitest";
import {
  BOUNDARY_MAX_CHAINS,
  BOUNDARY_PIECES,
  BOUNDARY_POLYTOPES,
  SPACE_INFO,
  SPACE_MAX_COORD,
  SPACE_MAX_P,
  SPACE_STRICT_REASON,
  SPACE_TOL,
  SpaceProblemEntry,
  buildSpaceCatalogue,
  formatSpaceId,
  parseSpaceId,
  spaceOfId,
  spaceProblemSummary,
  storedSpaceConfig,
  validateSpaceSubmission,
} from "../src";
import { loadSpacesIndex } from "../src/load";
import {
  SPACE_METHOD,
  buildSpaceKnown,
  checkSpaceConfig,
  parseSearchProblem,
  readSpaceConfig,
  statedScore,
} from "../src/search";

const root = resolve(__dirname, "../../..");
const cat = loadSpacesIndex(root).boundary!;
const file = JSON.parse(readFileSync(resolve(root, "data/boundary/records.json"), "utf8"));
const raw = new Map<string, any>(file.records.map((r: any) => [r.id, r]));
const problem = (id: string): SpaceProblemEntry => {
  const p = cat.byId.get(id);
  if (!p) throw new Error(`${id} is not in the catalogue`);
  return p;
};
const configOf = (p: SpaceProblemEntry) => JSON.parse(p.config!);
/** The rule as the server applies it: the problem's bound, the catalogue's largest P and the certified size. */
const check = (id: string, config: unknown) => {
  const p = cat.byId.get(id);
  return validateSpaceSubmission("boundary", id, config, {
    bound: p?.bound?.value ?? null,
    maxP: cat.maxP,
    certified: p?.certified?.score ?? null,
  });
};
/** A configuration scaled about the cells' centres by f, its edge included. */
const scaled = (c: any, f: number) => ({
  s: c.s * f,
  pieces: c.pieces.map((q: any) => ({ ...q, u: q.u.map((x: number) => x * f) })),
});

describe("boundary problem ids", () => {
  it("parse into {polytope, piece, P} and are written back the same, for every catalogue problem", () => {
    for (const p of cat.problems) {
      const parsed = parseSpaceId("boundary", p.id);
      if (typeof parsed === "string") throw new Error(parsed);
      expect(parsed.fields).toEqual({ polytope: "tesseract", piece: p.fields.piece, P: p.P });
      expect(formatSpaceId("boundary", parsed.fields)).toBe(p.id);
      expect(formatBoundaryId({ polytope: "tesseract", piece: p.fields.piece as "ball" | "cube", P: p.P })).toBe(p.id);
      expect(spaceOfId(p.id)).toBe("boundary");
      // the searches read the same ids the same way
      expect(parseSearchProblem(p.id)).toEqual({ space: "boundary", id: p.id, P: p.P, ...parsed.fields });
    }
  });

  it("are accepted in their one written form only, by the registry and by the searches", () => {
    const bad = [
      "boundary/tesseract/ball/09",
      "boundary/tesseract/ball/+9",
      "boundary/tesseract/ball/0",
      "boundary/tesseract/ball/10000",
      "boundary/tesseract/ball/9.0",
      "boundary/tesseract/ball/1e1",
      "boundary/Tesseract/ball/9",
      "boundary/tesseract/Ball/9",
      "boundary/tesseract/sphere/9",
      "boundary/24-cell/ball/9",
      "boundary/tesseract/ball",
      "boundary/tesseract/ball/9/",
      "boundary//ball/9",
      " boundary/tesseract/ball/9",
      "boundary/tesseract/ball/9 ",
      "sphere/4/12",
      `boundary/tesseract/ball/${"1".repeat(200)}`,
    ];
    for (const id of bad) {
      expect(typeof parseSpaceId("boundary", id), id).toBe("string");
      if (id.startsWith("boundary")) expect(parseSearchProblem(id), id).toBeNull();
    }
    expect(typeof parseSpaceId("boundary", 9)).toBe("string");
    // the message names the form and, when the id has four parts, what is wrong
    expect(parseSpaceId("boundary", "boundary/tesseract/ball/09")).toMatch(
      /the form is boundary\/<polytope>\/<piece>\/<P>, polytope tesseract, piece ball or cube\. .*without leading zeros/,
    );
    expect(parseSpaceId("boundary", "boundary/tesseract/sphere/9")).toMatch(/Unknown piece "sphere"/);
    expect(parseSpaceId("sphere", "boundary/tesseract/ball/9")).toMatch(/starts with "sphere\/"/);
  });

  it("use the polytopes and pieces of the boundary package", () => {
    expect([...BOUNDARY_POLYTOPES]).toEqual([...POLYTOPES]);
    expect([...BOUNDARY_PIECES]).toEqual([...PIECES]);
  });
});

describe("the boundary catalogue", () => {
  it("loads all 32 records, balls then cubes, P = 1..16 each, none left out", () => {
    expect(cat.skipped).toEqual([]);
    expect(cat.generated).toBe(file.generated);
    expect(cat.maxP).toBe(16);
    expect(cat.maxP).toBeLessThanOrEqual(SPACE_MAX_P.boundary);
    const ids = cat.problems.map((p) => p.id);
    expect(ids).toEqual([
      ...Array.from({ length: 16 }, (_, i) => `boundary/tesseract/ball/${i + 1}`),
      ...Array.from({ length: 16 }, (_, i) => `boundary/tesseract/cube/${i + 1}`),
    ]);
  });

  it("keeps each record's fields, certified value, bound and configuration", () => {
    for (const p of cat.problems) {
      const r = raw.get(p.id);
      expect(p.space).toBe("boundary");
      expect(p.fields).toEqual({ polytope: r.polytope, piece: r.piece, P: r.P });
      expect(p.status).toBe("best_known");
      expect(p.closed_reason).toBeNull();
      expect(p.certified).toEqual({ score: r.score_cert, display: r.display, status: "best_known" });
      expect(p.bound).toEqual({ value: r.bound.value, label: r.bound.label });
      expect(p.bound!.label).toMatch(/^\[CALC\] (volume|one ball|inscribed ball)/);
      expect(p.bound!.value).toBeLessThanOrEqual(p.certified!.score);
      // stored at score_cert, in the submission format with its known fields only
      const c = configOf(p);
      expect(c).toEqual(r.config);
      expect(c.s).toBe(p.certified!.score);
      expect(Object.keys(c)).toEqual(["s", "pieces"]);
      for (const q of c.pieces) expect(["cell", "u", "q"]).toEqual(expect.arrayContaining(Object.keys(q)));
    }
  });

  it("leaves out a record whose fields differ from its id, or whose configuration is malformed", () => {
    const good = raw.get("boundary/tesseract/ball/3");
    const c = buildSpaceCatalogue("boundary", {
      records: [
        { ...good, piece: "cube" },
        { ...good, P: 4 },
        { ...good, id: "boundary/tesseract/ball/03" },
        { ...good, config: { ...good.config, pieces: good.config.pieces.map(() => ({ cell: 9, u: [0, 0, 0] })) } },
        good,
      ],
    });
    expect(c.problems.map((p) => p.id)).toEqual(["boundary/tesseract/ball/3"]);
    expect(c.skipped.length).toBe(4);
    expect(c.skipped[0]).toMatch(/the id's piece differs from the record's \(cube\)/);
    expect(c.skipped[3]).toMatch(/cell must be an integer from 0 to 7/);
  });
});

describe("the nofold extras of a boundary summary", () => {
  it("give every problem its nofold value with its source, and the record's fold gain", () => {
    // ball values are in diameter-1 units (half the old radius-1 ones)
    const halfDiagonal = 1 + 1 / Math.sqrt(3);
    for (const p of cat.problems) {
      const r = raw.get(p.id);
      const extra = spaceProblemSummary(p, null).extra!;
      const nofold = p.fields.piece === "ball" ? (p.P <= 8 ? 1 : halfDiagonal) : p.P <= 8 ? 1 : 2;
      expect(extra.nofold!.value, p.id).toBeCloseTo(nofold, 14);
      expect(extra.nofold!.label).toBe(r.nofold.source);
      expect(extra.nofold!.label).toMatch(/^\[(CALC|EST)\] /);
      expect(extra.fold_gain).toBe(r.fold_gain);
      // fold_gain = 1 - score_float / nofold
      expect(extra.fold_gain!).toBeCloseTo(1 - r.score_float / r.nofold.value, 12);
      expect(extra.fold_gain!).toBeGreaterThanOrEqual(0);
      expect(extra.fold_gain!).toBeLessThan(1);
    }
    expect(spaceProblemSummary(problem("boundary/tesseract/ball/9"), null).extra).toEqual({
      nofold: { value: halfDiagonal, label: raw.get("boundary/tesseract/ball/9").nofold.source },
      fold_gain: raw.get("boundary/tesseract/ball/9").fold_gain,
    });
  });

  it("are sent for boundary problems only, and stay with a site entry", () => {
    const p = problem("boundary/tesseract/cube/12");
    const site = { id: 4, score: p.certified!.score - 0.01, name: "a", created_at: "2026-10-25T00:00:00.000Z" };
    const summary = spaceProblemSummary(p, site);
    expect(summary.best_score).toBe(site.score);
    expect(JSON.parse(JSON.stringify(summary)).extra.nofold.value).toBe(2);
    const sphere = loadSpacesIndex(root).sphere!.byId.get("sphere/4/12")!;
    expect("extra" in JSON.parse(JSON.stringify(spaceProblemSummary(sphere, null)))).toBe(false);
  });

  it("are null where a record has no usable nofold value or gain", () => {
    const good = raw.get("boundary/tesseract/ball/5");
    const c = buildSpaceCatalogue("boundary", {
      records: [{ ...good, nofold: { value: "2", source: 3 }, fold_gain: null }],
    });
    expect(c.problems[0].extra).toEqual({ nofold: null, fold_gain: null });
  });
});

describe("boundary configurations under the server's rule", () => {
  it("accept every research record at its certified edge, also at the strict tolerance", () => {
    for (const p of cat.problems) {
      const v = check(p.id, configOf(p));
      expect(v.valid, `${p.id}: ${v.reasons.join("; ")}`).toBe(true);
      expect(v.score).toBe(p.certified!.score);
      const strict = validateSpaceSubmission("boundary", p.id, configOf(p), {
        bound: p.bound!.value,
        certified: Infinity,
      });
      expect(strict.valid, p.id).toBe(true);
    }
  });

  it("refuse every record shrunk by 1e-6, as an invalid packing with a reason", () => {
    for (const p of cat.problems) {
      const v = check(p.id, scaled(configOf(p), 1 - 1e-6));
      expect(v.valid, p.id).toBe(false);
      expect(v.malformed).toBe(false);
      expect(v.reasons[0]).toMatch(/edge|overlap|below the lower bound/);
    }
  });

  it("refuse a configuration below the record that passes only at the touching tolerance", () => {
    // P unit cubes at the centres of P cells of edge 1 - 1.05e-9 (P <= 7, whose records are at least
    // 1, the edge below which no aligned unit cube fits): every cube pokes through its cell's faces
    // by about 5e-10, so edges lie inside it by that depth, within 1e-9 but not within 1e-11
    for (const id of ["boundary/tesseract/cube/4", "boundary/tesseract/cube/7"]) {
      const p = problem(id);
      const copy = { s: 1 - 1.05e-9, pieces: Array.from({ length: p.P }, (_, cell) => ({ cell, u: [0, 0, 0] })) };
      expect(p.certified!.score).toBeGreaterThanOrEqual(1);
      const loose = validateSpaceSubmission("boundary", id, copy, { bound: p.bound!.value });
      expect(loose.valid, id).toBe(true);
      const v = check(id, copy);
      expect(v.valid, id).toBe(false);
      expect(v.malformed).toBe(false);
      expect(v.reasons[0]).toBe(SPACE_STRICT_REASON);
      expect(v.reasons.length).toBeGreaterThan(1);
    }
  });

  it("refuse a wrong number of pieces as an invalid packing, not malformed input", () => {
    const c = configOf(problem("boundary/tesseract/ball/9"));
    for (const pieces of [c.pieces.slice(1), [...c.pieces, c.pieces[0]]]) {
      const v = check("boundary/tesseract/ball/9", { ...c, pieces });
      expect(v.valid).toBe(false);
      expect(v.malformed).toBe(false);
      expect(v.reasons[0]).toBe(`expected 9 pieces for this problem, got ${pieces.length}`);
    }
    // the configuration of ball/10 sent for ball/9
    expect(check("boundary/tesseract/ball/9", configOf(problem("boundary/tesseract/ball/10"))).reasons[0]).toBe(
      "expected 9 pieces for this problem, got 10",
    );
  });

  it("refuse malformed input as malformed, with what is wrong", () => {
    const ball = configOf(problem("boundary/tesseract/ball/3"));
    const cube = configOf(problem("boundary/tesseract/cube/3"));
    const spoil = (c: any, f: (d: any) => void) => {
      const d = structuredClone(c);
      f(d);
      return d;
    };
    const cases: [string, any, RegExp][] = [
      ["ball/3", null, /config must be an object/],
      ["ball/3", [], /config must be an object/],
      ["ball/3", "config", /config must be an object/],
      ["ball/3", { s: 2 }, /pieces must be an array/],
      ["ball/3", spoil(ball, (d) => (d.s = NaN)), /s must be a finite number/],
      ["ball/3", spoil(ball, (d) => (d.s = "2")), /s must be a finite number/],
      ["ball/3", spoil(ball, (d) => (d.s = 0)), /s must be positive/],
      ["ball/3", spoil(ball, (d) => (d.s = -2)), /s must be positive/],
      ["ball/3", spoil(ball, (d) => (d.s = 2e4)), /s must be at most 10000/],
      ["ball/3", spoil(ball, (d) => (d.pieces[0] = 7)), /pieces\[0\] must be an object \{cell, u\}/],
      ["ball/3", spoil(ball, (d) => (d.pieces[0].cell = 8)), /pieces\[0\]\.cell must be an integer from 0 to 7/],
      ["ball/3", spoil(ball, (d) => (d.pieces[0].cell = -1)), /cell must be an integer/],
      ["ball/3", spoil(ball, (d) => (d.pieces[0].cell = 1.5)), /cell must be an integer/],
      ["ball/3", spoil(ball, (d) => (d.pieces[0].cell = "0")), /cell must be an integer/],
      ["ball/3", spoil(ball, (d) => (d.pieces[1].u = [0, 0])), /pieces\[1\]\.u must be \[u0, u1, u2\]/],
      ["ball/3", spoil(ball, (d) => (d.pieces[1].u = [0, 0, 0, 0])), /u must be \[u0, u1, u2\]/],
      ["ball/3", spoil(ball, (d) => (d.pieces[1].u = "0,0,0")), /u must be \[u0, u1, u2\]/],
      ["ball/3", spoil(ball, (d) => (d.pieces[1].u[2] = NaN)), /pieces\[1\]\.u\[2\] must be a finite number/],
      ["ball/3", spoil(ball, (d) => (d.pieces[1].u[2] = Infinity)), /u\[2\] must be a finite number/],
      ["ball/3", spoil(ball, (d) => (d.pieces[1].u[2] = null)), /u\[2\] must be a finite number/],
      ["ball/3", spoil(ball, (d) => (d.pieces[1].u[2] = "1")), /u\[2\] must be a finite number/],
      ["ball/3", spoil(ball, (d) => (d.pieces[1].u[2] = 2 * SPACE_MAX_COORD)), /u\[2\] must be at most 10000/],
      ["ball/3", spoil(ball, (d) => (d.pieces[1].u = [0, , 0])), /u\[1\] must be a finite number/],
      ["ball/3", spoil(ball, (d) => (d.pieces[2].q = [1, 0, 0, 0])), /pieces\[2\] is a ball and has no rotation q/],
      ["ball/3", spoil(ball, (d) => (d.pieces[2].q = null)), /is a ball and has no rotation q/],
      ["cube/3", spoil(cube, (d) => (d.pieces[0].q = [1, 0, 0])), /pieces\[0\]\.q must be a unit quaternion \[w, x, y, z\]/],
      ["cube/3", spoil(cube, (d) => (d.pieces[0].q = null)), /q must be a unit quaternion/],
      ["cube/3", spoil(cube, (d) => (d.pieces[0].q = [2, 0, 0, 0])), /q must be a unit quaternion \(norm within 1e-9 of 1\)/],
      ["cube/3", spoil(cube, (d) => (d.pieces[0].q = [1 + 2e-9, 0, 0, 0])), /norm within 1e-9 of 1/],
      ["cube/3", spoil(cube, (d) => (d.pieces[0].q = [NaN, 0, 0, 1])), /q\[0\] must be a finite number/],
      ["cube/3", spoil(cube, (d) => (d.pieces[0].q = [0, 0, 0, 1e300])), /q\[3\] must be at most 10000/],
    ];
    for (const [short, config, reason] of cases) {
      const id = `boundary/tesseract/${short}`;
      const v = check(id, config);
      expect(v.valid, `${id} ${JSON.stringify(config)?.slice(0, 80)}`).toBe(false);
      expect(v.malformed, `${id} ${reason}`).toBe(true);
      expect(v.reasons.join("; "), `${id}`).toMatch(reason);
    }
    // a unit quaternion within 1e-9 is read; a rotated cube in the record's place is then judged as a packing
    const turned = spoil(cube, (d) => (d.pieces[0].q = [Math.SQRT1_2, Math.SQRT1_2 * (1 + 1e-10), 0, 0]));
    expect(check("boundary/tesseract/cube/3", turned).malformed).toBe(false);
  });

  it("refuse a centre outside its cell and an edge below the lower bound as invalid packings", () => {
    const c = configOf(problem("boundary/tesseract/ball/3"));
    const out = structuredClone(c);
    out.pieces[0].u = [c.s, 0, 0];
    const v = check("boundary/tesseract/ball/3", out);
    expect(v.valid).toBe(false);
    expect(v.malformed).toBe(false);
    expect(v.reasons[0]).toMatch(new RegExp(`centre lies outside its anchor cell ${c.pieces[0].cell} by `));
    const cubes = problem("boundary/tesseract/cube/16");
    const below = cubes.bound!.value * 0.95;
    const small = check(cubes.id, { ...configOf(cubes), s: below });
    expect(small.valid).toBe(false);
    expect(small.malformed).toBe(false);
    expect(small.reasons[0]).toBe(`the size ${below} is below the lower bound ${cubes.bound!.value} of this problem`);
  });

  it("refuse a P above the space's or the catalogue's largest, and another space's id", () => {
    expect(SPACE_MAX_P.boundary).toBe(64);
    const v = validateSpaceSubmission("boundary", "boundary/tesseract/ball/65", { s: 9, pieces: [] });
    expect(v.malformed).toBe(true);
    expect(v.reasons[0]).toBe("P = 65 is above the largest P of the boundary catalogue (64)");
    expect(check("boundary/tesseract/ball/17", { s: 9, pieces: [] }).reasons[0]).toMatch(/above the largest P .* \(16\)/);
    expect(validateSpaceSubmission("boundary", "sphere/4/12", {}).malformed).toBe(true);
  });

  it("store a kept configuration with its known fields only, otherwise as sent", () => {
    const c = configOf(problem("boundary/tesseract/cube/5"));
    const sent = { ...c, note: "x", pieces: c.pieces.map((q: any) => ({ ...q, colour: "red" })) };
    const v = check("boundary/tesseract/cube/5", sent);
    expect(v.valid).toBe(true);
    expect(v.config).toEqual(c);
    expect(storedSpaceConfig("boundary", "boundary/tesseract/cube/5", v.config!)).toBe(v.config);
    // a cube's rotation is kept as sent
    const turned = { ...c, pieces: c.pieces.map((q: any) => ({ ...q, q: [-1, 0, 0, 0] })) };
    const w = check("boundary/tesseract/cube/5", turned);
    expect(w.valid, w.reasons.join("; ")).toBe(true);
    expect((w.config!.pieces as any[])[0].q).toEqual([-1, 0, 0, 0]);
  });
});

describe("boundary work bounds", () => {
  it("every research record passes with 128 chains per piece, an eighth of the cap", () => {
    expect(BOUNDARY_MAX_CHAINS).toBe(8 * 128);
    for (const p of cat.problems) {
      const problemOf = { polytope: "tesseract" as const, piece: p.fields.piece as "ball" | "cube", P: p.P };
      expect(validateBoundary(problemOf, configOf(p), { tol: SPACE_TOL, maxChains: 128 }).ok, p.id).toBe(true);
    }
  });

  it("checks 64 pieces, the largest P accepted: a valid grid and piles that overlap", () => {
    // 8 balls of diameter 1 per cell on the 2 x 2 x 2 grid of a cell of edge 2: the nofold packing f(8) = 2
    const grid = {
      s: 2,
      pieces: Array.from({ length: 64 }, (_, i) => {
        const k = i % 8;
        return { cell: i >> 3, u: [k & 1 ? 0.5 : -0.5, k & 2 ? 0.5 : -0.5, k & 4 ? 0.5 : -0.5] };
      }),
    };
    expect(validateSpaceSubmission("boundary", "boundary/tesseract/ball/64", grid).valid).toBe(true);
    const pile = { s: 2, pieces: Array.from({ length: 64 }, () => ({ cell: 0, u: [0, 0, 0] })) };
    const v = validateSpaceSubmission("boundary", "boundary/tesseract/ball/64", pile);
    expect(v.valid).toBe(false);
    expect(v.reasons.length).toBe(20);
    const cubes = {
      s: 2,
      pieces: Array.from({ length: 64 }, (_, i) => ({ cell: i % 8, u: [0, 0, 0], q: [Math.SQRT1_2, 0, Math.SQRT1_2, 0] })),
    };
    expect(validateSpaceSubmission("boundary", "boundary/tesseract/cube/64", cubes).reasons[0]).toMatch(/overlap/);
  });
});

describe("boundary problems as the searches see them", () => {
  const p = parseSearchProblem("boundary/tesseract/cube/12")!;

  it("read a configuration into a clean copy, or null", () => {
    expect(p).toEqual({ space: "boundary", id: "boundary/tesseract/cube/12", P: 12, polytope: "tesseract", piece: "cube" });
    const c = configOf(problem(p.id));
    const copy = readSpaceConfig(p, { ...c, extra: 1, pieces: c.pieces.map((q: any) => ({ ...q, colour: 1 })) });
    expect(copy).toEqual(c);
    expect((copy!.pieces as any[])[0].u).not.toBe(c.pieces[0].u);
    expect(statedScore(p, copy!)).toBe(c.s);
    const turned = { ...c, pieces: c.pieces.map((q: any) => ({ ...q, q: [1, 0, 0, 0] })) };
    expect((readSpaceConfig(p, turned)!.pieces as any[])[0].q).toEqual([1, 0, 0, 0]);
    const bad = [
      null,
      { ...c, s: 0 },
      { ...c, s: Infinity },
      { ...c, pieces: c.pieces.slice(1) },
      { ...c, pieces: c.pieces.map((q: any, i: number) => (i ? q : { ...q, cell: 8 })) },
      { ...c, pieces: c.pieces.map((q: any, i: number) => (i ? q : { ...q, u: [0, 0] })) },
      { ...c, pieces: c.pieces.map((q: any, i: number) => (i ? q : { ...q, u: [0, NaN, 0] })) },
      { ...c, pieces: c.pieces.map((q: any, i: number) => (i ? q : { ...q, u: [0, , 0] })) },
      { ...c, pieces: c.pieces.map((q: any, i: number) => (i ? q : { ...q, q: [1, 0, 0] })) },
    ];
    for (const v of bad) expect(readSpaceConfig(p, v)).toBeNull();
    // a ball has no rotation
    const ball = parseSearchProblem("boundary/tesseract/ball/3")!;
    const bc = configOf(problem(ball.id));
    expect(readSpaceConfig(ball, bc)).toEqual(bc);
    expect(readSpaceConfig(ball, { ...bc, pieces: bc.pieces.map((q: any) => ({ ...q, q: [1, 0, 0, 0] })) })).toBeNull();
  });

  it("check results by the server's rule and start from the problem's best", () => {
    const c = configOf(problem(p.id));
    const rule = { bound: problem(p.id).bound!.value, certified: problem(p.id).certified!.score };
    expect(checkSpaceConfig("boundary", p.id, c, rule)).toEqual({ valid: true, score: c.s, reasons: [] });
    const shrunk = checkSpaceConfig("boundary", p.id, scaled(c, 1 - 1e-6), rule);
    expect(shrunk.valid).toBe(false);
    expect(shrunk.score).toBe(c.s * (1 - 1e-6));
    expect(checkSpaceConfig("boundary", p.id, { s: "x" }, rule).score).toBeNull();
    expect(SPACE_METHOD.boundary).toBe("boundary compression search");
    const known = buildSpaceKnown({
      certified: { score: c.s },
      certified_config: c,
      site_best: null,
      site_config: null,
    });
    expect(known).toEqual({ config: c, score: c.s, source: "certified" });
  });
});

describe("boundary metadata", () => {
  it("names the space, its viewer, its notes and its limits", () => {
    const i = SPACE_INFO.boundary;
    expect(i.title).toBe("Polytope boundaries");
    expect(i.viewer).toBe("/spaces/boundary.html");
    expect(i.docs).toBe("https://github.com/sinkomr/PolyPack/blob/main/docs/spaces/BOUNDARY.md");
    expect(i.problem_id).toBe("boundary/<polytope>/<piece>/<P>");
    expect(i.summary).toMatch(/tesseract/);
    expect(i.score).toMatch(/edge length s of the polytope; smaller is better/);
    expect(i.conventions.configuration).toBe("{s, pieces: [{cell, u, q?}, ...]} with P pieces");
    expect(i.conventions.cells).toMatch(/^cell 2 i \+ \(sigma > 0\) is the cube x_i = sigma s\/2/);
    expect(i.conventions.work_limit).toMatch(/^s is at most 10000; .* more than 1024 chains of cells/);
  });
});
