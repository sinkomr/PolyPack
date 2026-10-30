import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BALLS_CODES } from "@polypack/balls/catalogue";
import { PROBLEM_ORDER } from "@polypack/polyhedra/catalogue";
import { ALL_SOLID_NAMES } from "@polypack/surface";
import { TORUS_FAMILIES as TORUS_PACKAGE_FAMILIES } from "@polypack/torus";
import { describe, expect, it } from "vitest";
import {
  BOUNDARY_POLYTOPES,
  SPACE_MAX_COORD,
  SPACE_STRICT_REASON,
  SPACE_STRICT_TOL,
  SPACE_INFO,
  SPACE_MAX_P,
  SPACE_NAMES,
  SURFACE_MAX_CHAINS,
  SURFACE_SOLIDS,
  SpaceName,
  SpaceProblemEntry,
  TORUS_FAMILIES,
  acceptsSubmissions,
  SPACE_RECORD_MARGIN,
  beatsSpaceRecord,
  beatsSpaceScore,
  buildSpaceCatalogue,
  entryConfig,
  improvesSpaceBest,
  formatCurvature,
  formatSpaceId,
  parseSpaceId,
  problemOf,
  spaceProblemSummary,
  storedSpaceConfig,
  validateSpaceSubmission,
  validateSpaceSubmissionAsync,
} from "../src";
import {
  CONFIG_CACHE_BYTES,
  CONFIG_READS_AT_ONCE,
  configLoader,
  loadSpacesIndex,
  readEntryConfigSync,
} from "../src/load";

const root = resolve(__dirname, "../../..");
const index = loadSpacesIndex(root);
const cat = (space: SpaceName) => index[space]!;
/** A problem: its record, or a problem of the space's domain without one. */
const problem = (space: SpaceName, id: string): SpaceProblemEntry => {
  const parsed = parseSpaceId(space, id);
  const p = typeof parsed === "string" ? null : problemOf(cat(space), parsed);
  if (!p) throw new Error(`${id} is not in the catalogue`);
  return p;
};
const configOf = (p: SpaceProblemEntry) =>
  JSON.parse(p.configApart ? readEntryConfigSync(root, cat(p.id.split("/")[0] as SpaceName), p)! : p.config!);
/**
 * A fixed sample of a space's records, with their configurations read as the server reads them
 * (polyhedra configurations on demand): per family (the string fields of the id: solid and mode, lattice
 * family, polyhedron code, ...) its smallest and largest P and the middle one,
 * and a dozen spread over the catalogue. Every family and both ends of
 * every range are met; the validators themselves are checked against every stored record by
 * packages/polyhedra/test/validate.test.ts (float rule) and the certifiers' Python tests (interval rule).
 * Yields to the event loop now and then, so that a long loop does not hold up the test runner.
 */
async function* recordsOf(space: SpaceName): AsyncGenerator<[SpaceProblemEntry, unknown]> {
  const families = new Map<string, SpaceProblemEntry[]>();
  for (const p of cat(space).problems) {
    const key = Object.values(p.fields).filter((v) => typeof v === "string").join("/");
    families.set(key, [...(families.get(key) ?? []), p]);
  }
  // and, for the spaces whose ids are numbers only, a dozen spread over the whole catalogue
  const all = cat(space).problems;
  const picks = new Set<SpaceProblemEntry>(all.filter((_, i) => i % Math.ceil(all.length / 12) === 0));
  for (const list of families.values()) for (const p of [list[0], list[list.length >> 1], list[list.length - 1]]) picks.add(p);
  let n = 0;
  for (const list of [picks]) {
    for (const p of list) {
      const text = await entryConfig(cat(space), p);
      if (text === null) continue;
      if (++n % 20 === 0) await new Promise((r) => setImmediate(r));
      yield [p, JSON.parse(text)];
    }
  }
}
/** The wrapper as the server calls it: with the problem's bound and the catalogue's largest P. */
const check = (space: SpaceName, id: string, config: unknown) =>
  validateSpaceSubmission(space, id, config, { bound: problem(space, id).bound?.value ?? null, maxP: cat(space).maxP });

describe("problem ids", () => {
  it("parse into their fields and are written back the same, for every catalogue problem", () => {
    let n = 0;
    for (const space of SPACE_NAMES) {
      for (const p of cat(space).problems) {
        const parsed = parseSpaceId(space, p.id);
        expect(typeof parsed, p.id).toBe("object");
        if (typeof parsed === "string") continue;
        expect(parsed.fields).toEqual(p.fields);
        expect(parsed.P).toBe(p.P);
        expect(formatSpaceId(space, parsed.fields)).toBe(p.id);
        n++;
      }
    }
    // the balls space has a domain and no records
    // curved: 282 (the 52 records of radius-1 disks are archived in data/curved/archive)
    expect(n).toBe(2038 + 282 + 166 + 544 + 32 + 14850);
  });

  it("write K as the curved records do (Python's repr, integers without a point)", () => {
    const cases: [number, string][] = [
      [1, "1"],
      [-1, "-1"],
      [1e-6, "1e-06"],
      [-1e-6, "-1e-06"],
      [1e-5, "1e-05"],
      [0.0001, "0.0001"],
      [1.225778283313099, "1.225778283313099"],
      [-6.519717439579256, "-6.519717439579256"],
      [-2.5e-7, "-2.5e-07"],
      [1e16, "1e+16"],
      [1.5e300, "1.5e+300"],
      [123456.789, "123456.789"],
      [0.5, "0.5"],
    ];
    for (const [K, text] of cases) expect(formatCurvature(K)).toBe(text);
  });

  it("are accepted in their one written form only", () => {
    const bad: [SpaceName, string][] = [
      ["surface", "surface/cube/fold/04/12"],
      ["surface", "surface/cube/fold/4/+12"],
      ["surface", "surface/prism/fold/4/12"],
      ["surface", "surface/cube/folded/4/12"],
      ["surface", "surface/cube/fold/2/12"],
      ["surface", "surface/cube/fold/4/0"],
      ["surface", "surface/cube/fold/4"],
      ["surface", "torus/sq/0/2"],
      ["curved", "curved/1.0/0/0/2"],
      ["curved", "curved/0.000001/0/0/2"],
      ["curved", "curved/+1/0/0/2"],
      ["curved", "curved/inf/0/0/2"],
      ["curved", "curved/1/0/0/2/"],
      ["sphere", "sphere/4/012"],
      ["sphere", "sphere/4"],
      ["torus", "torus/square/0/2"],
      ["torus", "torus/sq/0/2/1"],
      ["boundary", "boundary/tesseract/ball/09"],
      ["boundary", "boundary/tesseract/sphere/9"],
      ["balls", "balls/ballinball/013"],
      ["balls", "balls/ballinballs/13"],
      ["balls", "balls/ballinball"],
      ["balls", "balls/ballinball/13/1"],
    ];
    for (const [space, id] of bad) expect(typeof parseSpaceId(space, id), id).toBe("string");
    expect(parseSpaceId("curved", "curved/0.000001/0/0/2")).toMatch(/written 1e-06/);
    expect(typeof parseSpaceId("torus", 7)).toBe("string");
  });

  it("use the solids and lattice families of their packages", () => {
    expect([...SURFACE_SOLIDS]).toEqual([...ALL_SOLID_NAMES]);
    expect([...TORUS_FAMILIES]).toEqual([...TORUS_PACKAGE_FAMILIES]);
  });
});

describe("the catalogues", () => {
  it("load every record of the six files, none left out", () => {
    const counts = Object.fromEntries(SPACE_NAMES.map((s) => [s, cat(s).problems.length]));
    expect(counts).toEqual({ surface: 2038, curved: 282, sphere: 166, torus: 544, boundary: 32, polyhedra: 14850, balls: 0 });
    expect(cat("balls").domain!.info.problems).toBe(18711);
    for (const s of SPACE_NAMES) expect(cat(s).skipped).toEqual([]);
  });

  it("stay within the work bounds measured for the validators", () => {
    // if a catalogue grows beyond SPACE_MAX_P, measure the worst validation time again and raise it
    for (const s of SPACE_NAMES) expect(cat(s).maxP).toBeLessThanOrEqual(SPACE_MAX_P[s]);
  });

  it("close proven and infeasible problems and nothing else", () => {
    const closed = (s: SpaceName) => cat(s).problems.filter((p) => !acceptsSubmissions(p));
    expect(closed("surface")).toEqual([]);
    // the torus records with a published proof of the exact case (docs/spaces/TORUS.md, sec. 7)
    const torus = closed("torus");
    expect(torus.length).toBe(52);
    expect(torus.every((p) => p.status === "proven" && /is proven \(.+, doi:10\./.test(p.closed_reason!))).toBe(true);
    expect(torus.find((p) => p.id === "torus/sq/0/2")!.closed_reason).toBe(
      "its optimum 1.414214 is proven (Brandt et al. 2019, Thm 1.1, doi:10.1016/j.disc.2019.111597)",
    );
    expect(closed("boundary")).toEqual([]);
    // the balls space has no records yet: every problem is open, without a certified value
    expect(closed("balls")).toEqual([]);
    // any problem of its domain is open, without a record and with its bound
    for (const id of [...cat("balls").domain!.sample(693), "balls/ballinpkd/20", "balls/pr3l15inball/7", "balls/ballintz12/100", "balls/ap5inball/2"]) {
      const p = problem("balls", id);
      expect(p.status === "no_record" && p.certified === null && p.bound !== null && acceptsSubmissions(p), id).toBe(
        true,
      );
    }
    expect(closed("sphere").map((p) => p.id)).toEqual([
      ...Array.from({ length: 13 }, (_, i) => `sphere/0/${i + 2}`),
      "sphere/0/24",
    ]);
    expect(closed("sphere").every((p) => p.status === "proven" && /is proven/.test(p.closed_reason!))).toBe(true);
    const infeasible = closed("curved");
    expect(infeasible.length).toBe(24);
    for (const p of infeasible) {
      expect(p.status).toBe("infeasible");
      expect(p.certified).toBeNull();
      expect(p.config).toBeNull();
      expect(p.closed_reason).toMatch(/^no packing exists/);
    }
  });

  it("normalise bounds to {value, label} from `value` or, for curved, `lower`", () => {
    // a curved record: its bound is the record's `lower`; a disk problem has no record, only its domain's bound
    const curved = problem("curved", "curved/-1/3/0/2");
    expect(curved.bound!.value).toBe(1.1405796542282387);
    expect(curved.bound!.label).toMatch(/\[CALC\] rigorous/);
    expect(problem("curved", "curved/-1/0/0/2").bound!.value).toBe(1.999999999998);
    expect(problem("surface", "surface/tetrahedron/fold/0/1").bound!.label).toBe("one piece bound; [CALC]");
    expect(problem("torus", "torus/sq/0/1").bound).toEqual({
      value: 1,
      label: "[CALC] one disk: the shortest lattice vector L must be >= 1 (the diameter)",
    });
    for (const s of SPACE_NAMES)
      for (const p of cat(s).problems)
        if (p.status !== "infeasible" && p.status !== "no_record") {
          expect(p.bound, p.id).not.toBeNull();
          expect(p.bound!.value).toBeLessThanOrEqual(p.certified!.score);
        }
  });

  it("keep the configuration as JSON text in the submission format, unknown fields dropped", () => {
    const s = configOf(problem("surface", "surface/cube/fold/4/12"));
    expect(Object.keys(s)).toEqual(["s", "pieces"]);
    expect(Object.keys(s.pieces[0])).toEqual(["face", "x", "y", "theta"]);
    expect(Object.keys(configOf(problem("curved", "curved/-1/3/0/2")))).toEqual(["size", "pieces"]);
    expect(Object.keys(configOf(problem("sphere", "sphere/4/12")))).toEqual(["rho", "pieces"]);
    const t = configOf(problem("torus", "torus/free/5/8"));
    expect(Object.keys(t)).toEqual(["lattice", "poses"]);
    expect(Object.keys(t.lattice)).toEqual(["b1", "b2"]);
    const b = configOf(problem("boundary", "boundary/tesseract/cube/12"));
    expect(Object.keys(b)).toEqual(["s", "pieces"]);
    expect(Object.keys(b.pieces[0])).toEqual(["cell", "u"]);
  });

  it("summarise a problem with the smaller of the certified and the site value", () => {
    const p = problem("torus", "torus/hex/5/8");
    const none = spaceProblemSummary(p, null);
    expect(none.best_score).toBe(p.certified!.score);
    expect(none.accepts_submissions).toBe(true);
    const site = { id: 3, score: p.certified!.score - 0.01, name: "a", created_at: "2026-10-24T00:00:00.000Z" };
    expect(spaceProblemSummary(p, site).best_score).toBe(site.score);
    // a closed problem shows no site entry
    const closed = spaceProblemSummary(problem("sphere", "sphere/0/2"), site);
    expect(closed.site_best).toBeNull();
    expect(closed.accepts_submissions).toBe(false);
  });

  it("list each space in its own field order: a named field by its space's list, a number ascending", () => {
    // written out apart from records.ts, so that a change of order shows here
    const keys: Record<SpaceName, [string, readonly string[] | null][]> = {
      surface: [
        ["solid", SURFACE_SOLIDS],
        ["mode", ["fold", "nofold"]],
        ["N", null],
        ["P", null],
      ],
      curved: [
        ["K", null],
        ["N", null],
        ["M", null],
        ["P", null],
      ],
      sphere: [
        ["N", null],
        ["P", null],
      ],
      torus: [
        ["family", TORUS_FAMILIES],
        ["N", null],
        ["P", null],
      ],
      boundary: [
        ["polytope", BOUNDARY_POLYTOPES],
        ["piece", ["ball", "cube"]],
        ["P", null],
      ],
      // polyhedra's fields include a piece, which is not a sort key there
      polyhedra: [
        ["code", PROBLEM_ORDER],
        ["P", null],
      ],
      balls: [
        ["code", BALLS_CODES],
        ["P", null],
      ],
    };
    for (const s of SPACE_NAMES) {
      const rank = (p: SpaceProblemEntry) =>
        keys[s].map(([k, order]) => {
          if (!order) return Number(p.fields[k]);
          const r = order.indexOf(String(p.fields[k]));
          expect(r, `${p.id}: ${k}`).toBeGreaterThanOrEqual(0);
          return r;
        });
      const problems = cat(s).problems;
      for (let i = 1; i < problems.length; i++) {
        const [a, b] = [rank(problems[i - 1]), rank(problems[i])];
        const d = a.findIndex((x, j) => x !== b[j]);
        expect(d === -1 || a[d] < b[d], `${problems[i - 1].id} before ${problems[i].id}`).toBe(true);
      }
    }
  });

  it("log one line per space", () => {
    const logs: string[] = [];
    loadSpacesIndex(root, (m) => logs.push(m));
    // a space with a domain (surface) says how many of its problems have a record
    expect(logs).toEqual(
      SPACE_NAMES.map((s) => expect.stringMatching(new RegExp(`^\\[spaces\\] ${s}: (a domain of )?\\d+ problems`))),
    );
  });

  it("leave a space out when its records file is missing, unless it has a domain", () => {
    const empty = mkdtempSync(join(tmpdir(), "polypack-spaces-"));
    const logs: string[] = [];
    const loaded = loadSpacesIndex(empty, (m) => logs.push(m));
    // Domain spaces load even without records; balls ships no records file at all
    expect(Object.keys(loaded).sort()).toEqual(["balls", "curved", "polyhedra", "sphere", "surface", "torus"]);
    expect(loaded.polyhedra!.problems).toHaveLength(0);
    expect(loaded.polyhedra!.domain!.info.problems).toBe(4409164);
    expect(loaded.balls!.problems).toHaveLength(0);
    expect(loaded.balls!.domain!.info.problems).toBe(18711);
    expect(loaded.surface!.problems).toHaveLength(0);
    expect(loaded.surface!.domain!.info.problems).toBe(2791800);
    expect(logs).toEqual(
      SPACE_NAMES.map((s) =>
        s === "balls"
          ? "[spaces] balls: a domain of 18711 problems, 0 with a record (no records file)"
          : s === "surface"
            ? "[spaces] surface: a domain of 2791800 problems, 0 with a record (no records file)"
            : loaded[s]?.domain
              ? `[spaces] ${s}: a domain of ${loaded[s]!.domain!.info.problems} problems, 0 with a record (no records file)`
              : `[spaces] no ${s} records (${join("data", s, "records.json")} is missing)`,
      ),
    );
  });

  it("leave out records that do not match their id or format, with reasons", () => {
    const c = buildSpaceCatalogue("torus", {
      records: [
        { problem: "torus/sq/0/1", family: "hex", N: 0, P: 1, status: "best_known" },
        { problem: "torus/sq/0/01", family: "sq", N: 0, P: 1, status: "best_known" },
        { problem: "torus/sq/0/1", family: "sq", N: 0, P: 1, status: "guessed" },
        { problem: "torus/sq/0/1", family: "sq", N: 0, P: 1, status: "best_known", score_cert: 2, display: "2" },
        "nonsense",
      ],
    });
    expect(c.problems).toEqual([]);
    expect(c.skipped.length).toBe(5);
    expect(buildSpaceCatalogue("sphere", null).skipped).toEqual(["the file has no records list"]);
  });
});

describe("beating a research record needs the strict tolerance", () => {
  /** A configuration shrunk about the origin by the factor f, its size included (sphere: rho only). */
  const shrunk = (space: SpaceName, c: any, f: number): any =>
    space === "surface"
      ? { s: c.s * f, pieces: c.pieces.map((q: any) => ({ ...q, x: q.x * f, y: q.y * f })) }
      : space === "curved"
        ? { size: c.size * f, pieces: c.pieces.map((q: any) => ({ ...q, x: q.x * f, y: q.y * f })) }
        : space === "sphere"
          ? { rho: c.rho * f, pieces: c.pieces }
          : space === "boundary"
            ? { s: c.s * f, pieces: c.pieces.map((q: any) => ({ ...q, u: q.u.map((x: number) => x * f) })) }
            : {
                lattice:
                  "L" in c.lattice
                    ? { L: c.lattice.L * f }
                    : { b1: c.lattice.b1.map((x: number) => x * f), b2: c.lattice.b2.map((x: number) => x * f) },
                poses: c.poses.map(([x, y, t]: number[]) => [x * f, y * f, t]),
              };

  it(`every record passes at ${SPACE_STRICT_TOL} at its stated size`, async () => {
    const failures: string[] = [];
    for (const space of SPACE_NAMES)
      for await (const [p, config] of recordsOf(space)) {
        // a certified size of Infinity makes every configuration "beat" it, so the strict check runs
        const v = validateSpaceSubmission(space, p.id, config, {
          bound: p.bound?.value ?? null,
          certified: Infinity,
        });
        if (!v.valid) failures.push(`${p.id}: ${v.reasons.join("; ")}`);
      }
    expect(failures).toEqual([]);
  });

  it("refuses a record's own configuration shrunk by 1.05e-9, which passes at the touching tolerance", () => {
    for (const id of ["torus/sq/3/2", "sphere/3/5", "curved/-1/3/0/2", "surface/tetrahedron/fold/3/5"]) {
      const space = id.split("/")[0] as SpaceName;
      const p = problem(space, id);
      const copy = shrunk(space, configOf(p), 1 - 1.05e-9);
      const loose = check(space, id, copy);
      expect(loose.valid, id).toBe(true);
      expect(beatsSpaceScore(loose.score!, p.certified!.score), id).toBe(true);
      const v = validateSpaceSubmission(space, id, copy, { bound: p.bound!.value, certified: p.certified!.score });
      expect(v.valid, id).toBe(false);
      expect(v.malformed).toBe(false);
      expect(v.reasons[0]).toBe(SPACE_STRICT_REASON);
      expect(v.reasons.length).toBeGreaterThan(1);
      // not beating the record, the same configuration needs no strict check
      expect(validateSpaceSubmission(space, id, copy, { certified: loose.score! * (1 + 1e-12) }).valid, id).toBe(true);
    }
  });
});

describe("every research record's own configuration is valid in floats", () => {
  // The float validators of the spaces must accept what the interval certificates proved: each
  // record's stored configuration at its stated size, and (surface, torus, whose certificates
  // shrink the pieces) the configuration scaled up to score_cert.
  for (const space of SPACE_NAMES) {
    it(`${space}: at the stated size, which is score_cert or below it`, async () => {
      const failures: string[] = [];
      for await (const [p, config] of recordsOf(space)) {
        const v = check(space, p.id, config);
        if (!v.valid) failures.push(`${p.id}: ${v.reasons.join("; ")}`);
        else if (!(v.score! <= p.certified!.score))
          failures.push(`${p.id}: size ${v.score} above score_cert ${p.certified!.score}`);
        if (space === "curved" || space === "sphere" || space === "boundary") expect(v.score).toBe(p.certified!.score);
      }
      expect(failures).toEqual([]);
    });
  }

  it("surface: scaled to score_cert (centres scaled with the faces)", () => {
    const failures: string[] = [];
    for (const p of cat("surface").problems) {
      const c = configOf(p);
      const k = p.certified!.score / c.s;
      const scaled = { s: p.certified!.score, pieces: c.pieces.map((q: any) => ({ ...q, x: q.x * k, y: q.y * k })) };
      const v = check("surface", p.id, scaled);
      if (!v.valid) failures.push(`${p.id}: ${v.reasons.join("; ")}`);
    }
    expect(failures).toEqual([]);
  });

  it("torus: scaled to score_cert (lattice and positions scaled together)", () => {
    const failures: string[] = [];
    for (const p of cat("torus").problems) {
      const c = configOf(p);
      const family = p.fields.family;
      const size =
        family === "free"
          ? Math.sqrt(Math.abs(c.lattice.b1[0] * c.lattice.b2[1] - c.lattice.b1[1] * c.lattice.b2[0]))
          : c.lattice.L;
      const k = p.certified!.score / size;
      const lattice =
        family === "free"
          ? { b1: c.lattice.b1.map((x: number) => x * k), b2: c.lattice.b2.map((x: number) => x * k) }
          : { L: c.lattice.L * k };
      const scaled = { lattice, poses: c.poses.map(([x, y, t]: number[]) => [x * k, y * k, t]) };
      const v = check("torus", p.id, scaled);
      if (!v.valid) failures.push(`${p.id}: ${v.reasons.join("; ")}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("the touching rule: touching and overlaps up to 1e-9 pass, an overlap of 1e-6 does not", () => {
  const SQ = Math.PI / 4;
  it("surface, nofold and fold: two unit squares side by side on every cube face", () => {
    const at = (dx: number) => ({
      s: 2,
      pieces: Array.from({ length: 12 }, (_, i) => ({ face: i >> 1, x: i % 2 ? 0.5 - dx : -0.5, y: 0, theta: SQ })),
    });
    for (const mode of ["nofold", "fold"]) {
      const id = `surface/cube/${mode}/4/12`;
      expect(check("surface", id, at(0)).valid).toBe(true);
      expect(check("surface", id, at(1e-10)).valid).toBe(true);
      const v = check("surface", id, at(1e-6));
      expect(v.valid).toBe(false);
      expect(v.reasons[0]).toMatch(/overlap/);
    }
    // a piece leaving its face (nofold) or with its centre outside its face (fold)
    const out = at(0);
    out.pieces[1].x = 0.5 + 1e-6;
    expect(check("surface", "surface/cube/nofold/4/12", out).reasons[0]).toMatch(/leaves face/);
    out.pieces[1].x = 1 + 1e-6;
    expect(check("surface", "surface/cube/fold/4/12", out).reasons[0]).toMatch(/centre of piece 1 is outside its face/);
  });

  it("curved: two disks of diameter 1 in a disk of diameter 2 at K = -1", () => {
    // r is the distance between the two centres, on a geodesic through the container's centre
    const at = (r: number, size = 2) => ({
      size,
      pieces: [
        { x: r / 2, y: 0, theta: 0 },
        { x: -r / 2, y: 0, theta: 0 },
      ],
    });
    expect(check("curved", "curved/-1/0/0/2", at(1)).valid).toBe(true);
    expect(check("curved", "curved/-1/0/0/2", at(1 - 2e-10)).valid).toBe(true);
    const v = check("curved", "curved/-1/0/0/2", at(1 - 1e-6));
    expect(v.valid).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/pieces overlap by 0\.000001/);
    // pushed out through the rim
    expect(check("curved", "curved/-1/0/0/2", at(1 + 1e-6)).reasons.join(" ")).toMatch(/protrudes/);
    expect(check("curved", "curved/-1/0/0/2", at(3)).reasons[0]).toMatch(/outside the container/);
  });

  it("sphere: a record whose sphere shrinks by 1e-10 still passes, by 1e-6 it does not", () => {
    for (const id of ["sphere/0/20", "sphere/4/12", "sphere/8/12"]) {
      const c = configOf(problem("sphere", id));
      expect(check("sphere", id, { ...c, rho: c.rho * (1 - 1e-10) }).valid, id).toBe(true);
      const v = check("sphere", id, { ...c, rho: c.rho * (1 - 1e-6) });
      expect(v.valid, id).toBe(false);
      expect(v.reasons[0]).toMatch(/overlap/);
    }
  });

  it("torus: two disks of diameter 1 on the square torus of side sqrt 2", () => {
    const L = Math.SQRT2;
    const at = (d: number) => ({
      lattice: { L },
      poses: [
        [0, 0, 0],
        [Math.SQRT2 / 2 - d, Math.SQRT2 / 2 - d, 0],
      ],
    });
    expect(check("torus", "torus/sq/0/2", at(0)).valid).toBe(true);
    expect(check("torus", "torus/sq/0/2", at(1e-10 / Math.SQRT2)).valid).toBe(true);
    const v = check("torus", "torus/sq/0/2", at(1e-6 / Math.SQRT2));
    expect(v.valid).toBe(false);
    expect(v.reasons[0]).toMatch(/pieces 0 and 1 overlap .* by 9\.99\d*e-7/);
    // a piece and its own translate: one disk on a square torus of side below 1, overlapping
    // itself by 0.9e-9 (touching within the tolerance) and by 1.1e-9 (an overlap)
    const one = (L: number) => check("torus", "torus/sq/0/1", { lattice: { L }, poses: [[0, 0, 0]] });
    expect(one(1 - 0.9e-9).valid).toBe(true);
    // the problem's lower bound is L >= 1 (the diameter), checked before any geometry
    expect(one(1 - 1.1e-9).reasons[0]).toMatch(/below the lower bound 1 of this problem/);
    expect(
      validateSpaceSubmission("torus", "torus/sq/0/1", { lattice: { L: 1 - 1.1e-9 }, poses: [[0.3, 0.2, 0]] }).valid,
    ).toBe(false);
  });
});

describe("tampered and malformed configurations are rejected", () => {
  const records: [SpaceName, string][] = [
    ["surface", "surface/icosahedron/fold/3/20"],
    ["curved", "curved/-1/3/4/7"],
    ["sphere", "sphere/5/12"],
    ["torus", "torus/free/5/8"],
  ];
  const pieceKey = (space: SpaceName) => (space === "torus" ? "poses" : "pieces");

  it("with a piece missing or added: an invalid packing, not a malformed body", () => {
    for (const [space, id] of records) {
      const c = configOf(problem(space, id));
      const k = pieceKey(space);
      for (const list of [c[k].slice(1), [...c[k], c[k][0]]]) {
        const v = check(space, id, { ...c, [k]: list });
        expect(v.valid).toBe(false);
        expect(v.malformed).toBe(false);
        expect(v.reasons[0]).toMatch(/^expected \d+ pieces/);
      }
    }
  });

  it("with NaN, infinite, giant or non-numeric values: malformed", () => {
    const spoil = (space: SpaceName, c: any, value: unknown) => {
      const d = structuredClone(c);
      if (space === "torus") d.poses[0][0] = value;
      else if (space === "sphere") d.pieces[0].q[1] = value;
      else d.pieces[0].x = value;
      return d;
    };
    for (const [space, id] of records) {
      const c = configOf(problem(space, id));
      for (const value of [NaN, Infinity, -Infinity, 1e300, 2 * SPACE_MAX_COORD, "1", null, undefined]) {
        const v = check(space, id, spoil(space, c, value));
        expect(v.valid, `${id} ${String(value)}`).toBe(false);
        expect(v.malformed).toBe(true);
      }
    }
    expect(check("sphere", "sphere/5/12", { rho: 2, pieces: Array(12).fill({ q: [0, 0, 0, 0] }) }).reasons[0]).toMatch(
      /norm/,
    );
    expect(
      check("torus", "torus/sq/0/2", {
        lattice: { b1: [3, 0], b2: [0, 3] },
        poses: [
          [0, 0, 0],
          [1, 1, 0],
        ],
      }).malformed,
    ).toBe(true);
    expect(check("torus", "torus/free/0/1", { lattice: { L: 3 }, poses: [[0, 0, 0]] }).malformed).toBe(true);
    expect(
      check("torus", "torus/free/0/1", { lattice: { b1: [3, 0], b2: [6, 0] }, poses: [[0, 0, 0]] }).reasons[0],
    ).toMatch(/linearly independent/);
    expect(
      check("surface", "surface/cube/fold/4/1", { s: 1, pieces: [{ face: 6, x: 0, y: 0, theta: 0 }] }).reasons[0],
    ).toMatch(/face must be an integer from 0 to 5/);
    for (const raw of [null, [], "config", 3]) expect(check("sphere", "sphere/5/12", raw).malformed).toBe(true);
  });

  it("with a size below the problem's lower bound, before any geometry", () => {
    // torus/sq/0/1 meets its bound L = 1 (the diameter) exactly
    const v = check("torus", "torus/sq/0/1", { lattice: { L: 1 - 1e-6 }, poses: [[0, 0, 0]] });
    expect(v.valid).toBe(false);
    expect(v.malformed).toBe(false);
    expect(v.reasons[0]).toMatch(/below the lower bound 1 of this problem/);
    for (const [space, id] of records) {
      const p = problem(space, id);
      const c = configOf(p);
      const small = p.bound!.value * 0.99;
      const d =
        space === "surface"
          ? { ...c, s: small }
          : space === "curved"
            ? { ...c, size: small }
            : space === "sphere"
              ? { ...c, rho: small }
              : null;
      if (d) expect(check(space, id, d).reasons[0]).toMatch(/below the lower bound/);
    }
  });

  it("for a P above the catalogue's, an unknown id or another space's id", () => {
    expect(validateSpaceSubmission("torus", "torus/sq/0/501", { lattice: { L: 99 }, poses: [] }).reasons[0]).toMatch(
      /above the largest P/,
    );
    expect(validateSpaceSubmission("sphere", "sphere/0/3", {}, { maxP: 2 }).reasons[0]).toMatch(/above the largest P/);
    expect(validateSpaceSubmission("sphere", "torus/sq/0/2", {}).malformed).toBe(true);
  });
});

describe("work limits", () => {
  it("surface: the fold check gives up on a solid far too small for its pieces", () => {
    // without the bound check (which the server always applies) a tiny solid reaches the chain cap
    const v = validateSpaceSubmission("surface", "surface/cube/fold/4/1", {
      s: 0.01,
      pieces: [{ face: 0, x: 0, y: 0, theta: 0 }],
    });
    expect(v.valid).toBe(false);
    expect(v.reasons[0]).toMatch(new RegExp(`^the fold check gave up: more than ${SURFACE_MAX_CHAINS} chains`));
    // with the bound it is refused at once
    expect(
      check("surface", "surface/cube/fold/4/1", { s: 0.01, pieces: [{ face: 0, x: 0, y: 0, theta: 0 }] }).reasons[0],
    ).toMatch(/below the lower bound/);
  });

  it("torus: a skewed basis and a lattice vector shorter than the piece are refused with a reason", () => {
    const p = problem("torus", "torus/free/0/2");
    const c = configOf(p);
    const { b1, b2 } = c.lattice;
    // the same lattice, written with b2 + 1000 b1
    const skewed = { ...c, lattice: { b1, b2: [b2[0] + 1000 * b1[0], b2[1] + 1000 * b1[1]] } };
    expect(check("torus", p.id, skewed).reasons[0]).toMatch(/too skewed/);
    // the same lattice, a little skewed, is checked as usual
    const mild = { ...c, lattice: { b1, b2: [b2[0] + b1[0], b2[1] + b1[1]] } };
    expect(check("torus", p.id, mild).valid).toBe(true);
    const thin = {
      lattice: { b1: [0.75, 0], b2: [0.15, 2.5] },
      poses: [
        [0, 0, 0],
        [0, 1.25, 0],
      ],
    };
    expect(check("torus", p.id, thin).reasons[0]).toMatch(
      /shorter than the piece's width 1: every piece overlaps its own translate/,
    );
  });
});

describe("balls submissions", () => {
  // balls have diameter 1: two of them touch with centres at +-1/2, and a ball container is scored by its diameter
  const two = (d: number, s: number) => ({
    s,
    pieces: [
      [d, 0, 0],
      [-d, 0, 0],
    ],
  });
  it("check balls and solids by the space's rule, and tell malformed input from invalid packings", () => {
    expect(check("balls", "balls/ballinball/2", two(0.5, 2)).valid).toBe(true);
    // an overlap within the touching tolerance passes, a deeper one does not
    expect(check("balls", "balls/ballinball/2", two(0.5 - 2e-10, 2)).valid).toBe(true);
    const v = check("balls", "balls/ballinball/2", two(0.5 - 2e-9, 2));
    expect(v).toMatchObject({ valid: false, malformed: false });
    expect(v.reasons[0]).toMatch(/^pieces 0 and 1 overlap by/);
    // below the lower bound 2: refused unchecked
    expect(check("balls", "balls/ballinball/2", two(0.45, 1.9)).reasons[0]).toMatch(/below the lower bound/);
    expect(check("balls", "balls/ballinball/2", { s: 2, pieces: [[1, 0, 0]] })).toMatchObject({
      valid: false,
      malformed: false,
    });
    for (const bad of [
      { s: 2 },
      { s: "2", pieces: [] },
      {
        s: 2,
        pieces: [
          [1, 0],
          [0, 1],
        ],
      },
      {
        s: 2,
        pieces: [
          [1, 0, NaN],
          [-1, 0, 0],
        ],
      },
    ])
      expect(check("balls", "balls/ballinball/2", bad).malformed, JSON.stringify(bad)).toBe(true);
    // a solid's pose has 7 numbers; extra fields are dropped from the stored configuration
    const cubes = {
      s: 2 * Math.sqrt(1.5), // a ball container is scored by its diameter
      pieces: [
        [-0.5, 0, 0, 1, 0, 0, 0],
        [0.5, 0, 0, 1, 0, 0, 0],
      ],
      extra: 1,
    };
    const c = check("balls", "balls/cubinball/2", cubes);
    expect(c.valid).toBe(true);
    expect(c.config).toEqual({ s: cubes.s, pieces: cubes.pieces });
    expect(
      check("balls", "balls/cubinball/2", {
        ...cubes,
        pieces: [
          [-0.5, 0, 0],
          [0.5, 0, 0],
        ],
      }).malformed,
    ).toBe(true);
    expect(validateSpaceSubmission("balls", "balls/ballinball/101", two(0.5, 2)).malformed).toBe(true);
  });
});

describe("space metadata", () => {
  it("names a viewer and the notes on GitHub for every space", () => {
    for (const s of SPACE_NAMES) {
      const i = SPACE_INFO[s];
      // the balls space has no standalone viewer: the board draws its problems
      expect(i.viewer).toBe(s === "balls" ? "/#space=balls" : `/spaces/${s}.html`);
      expect(i.docs).toMatch(/^https:\/\/github\.com\/sinkomr\/PolyPack\/blob\/main\/docs\/spaces\/[A-Z_]+\.md$/);
      expect(i.conventions.configuration).toBeTruthy();
      expect(i.conventions.validity).toMatch(/1e-9/);
      // polyhedra records keep a clearance, so beating one takes a relative 1e-6 (SPACE_RECORD_MARGIN)
      expect(i.conventions.improvement).toMatch(
        s === "polyhedra"
          ? /leader's by more than a relative 1e-9 and below the research record's certified s by more than a relative 1e-6: .*one below the research record must also be valid with overlaps of at most 1e-11$/
          : /by more than a relative 1e-9; one below the research record must also be valid with overlaps of at most 1e-11$/,
      );
    }
  });

  it("states the limits as the parser applies them", () => {
    expect(SPACE_INFO.sphere.conventions.pose).toMatch(
      /^\{q: \[w, x, y, z\]\}: a quaternion of norm at least 1e-6, each component at most 10000/,
    );
    expect(SPACE_INFO.torus.conventions.work_limit).toMatch(
      /x, y and theta of each pose are each at most 10000 in absolute value$/,
    );
    // the parser agrees: a norm just below the limit and a coordinate just above it are refused
    const q = (n: number) => ({ rho: 2, pieces: Array.from({ length: 12 }, () => ({ q: [n, 0, 0, 0] })) });
    expect(check("sphere", "sphere/5/12", q(0.9e-6)).reasons[0]).toMatch(/norm of at least/);
    expect(check("sphere", "sphere/5/12", q(1.1e-6)).malformed).toBe(false);
    const far = {
      lattice: { L: 5 },
      poses: [
        [0, 0, 0],
        [10000.5, 0, 0],
      ],
    };
    expect(check("torus", "torus/sq/0/2", far).reasons[0]).toMatch(/poses\[1\]\[0\] must be at most 10000/);
  });

  it("compares scores with the main site's tie rule", () => {
    expect(beatsSpaceScore(1, null)).toBe(true);
    expect(beatsSpaceScore(1 - 2e-9, 1)).toBe(true);
    expect(beatsSpaceScore(1 - 5e-10, 1)).toBe(false);
  });
});

describe("the stored form of a free torus", () => {
  const p = problem("torus", "torus/free/6/30");
  const opts = { bound: p.bound!.value, maxP: cat("torus").maxP };
  const c = configOf(p);
  const det = (l: { b1: number[]; b2: number[] }) => l.b1[0] * l.b2[1] - l.b1[1] * l.b2[0];
  const n2 = (v: number[]) => v[0] ** 2 + v[1] ** 2;

  it("keeps a reduced, right-handed basis as it was sent, and every other space's configuration", () => {
    expect(storedSpaceConfig("torus", p.id, c, opts)).toBe(c);
    const sq = configOf(problem("torus", "torus/sq/5/7"));
    expect(storedSpaceConfig("torus", "torus/sq/5/7", sq, opts)).toBe(sq);
    const sphere = configOf(problem("sphere", "sphere/4/12"));
    expect(storedSpaceConfig("sphere", "sphere/4/12", sphere)).toBe(sphere);
  });

  it("stores a skewed or left-handed basis reduced, with det > 0, the same score and the same poses", () => {
    const { b1, b2 } = c.lattice;
    for (const [k, sign] of [
      [40, 1],
      [0, -1],
      [7, -1],
    ]) {
      const sent = { ...c, lattice: { b1, b2: [sign * (b2[0] + k * b1[0]), sign * (b2[1] + k * b1[1])] } };
      const v = check("torus", p.id, sent);
      expect(v.valid, `k=${k}`).toBe(true);
      const stored = storedSpaceConfig("torus", p.id, sent, opts) as typeof c;
      expect(stored).not.toBe(sent);
      expect(det(stored.lattice)).toBeGreaterThan(0);
      // Lagrange-Gauss reduced: |b1| <= |b2| and |b1 . b2| <= |b1|^2 / 2
      const { b1: r1, b2: r2 } = stored.lattice;
      expect(n2(r1)).toBeLessThanOrEqual(n2(r2) * (1 + 1e-12));
      expect(Math.abs(r1[0] * r2[0] + r1[1] * r2[1])).toBeLessThanOrEqual((n2(r1) / 2) * (1 + 1e-12));
      expect(stored.poses).toEqual(sent.poses);
      const again = check("torus", p.id, stored);
      expect(again.valid).toBe(true);
      expect(Math.abs(again.score! - v.score!)).toBeLessThanOrEqual(1e-12 * v.score!);
    }
  });
});

describe("polyhedra (3D in 3D)", () => {
  /** P unit cubes in a row along x, `gap` apart (negative: overlapping), in a cube of edge s. */
  const row = (P: number, gap: number, s: number) => ({
    s,
    pieces: Array.from({ length: P }, (_, i) => [(i - (P - 1) / 2) * (1 + gap), 0, 0, 1, 0, 0, 0]),
  });

  it("ids name a wiki problem and P, in their one written form", () => {
    expect(parseSpaceId("polyhedra", "polyhedra/cubintet/12")).toEqual({
      space: "polyhedra",
      id: "polyhedra/cubintet/12",
      fields: { code: "cubintet", piece: "cube", container: "tetrahedron", P: 12 },
      P: 12,
    });
    for (const bad of [
      "polyhedra/cubintet/012",
      "polyhedra/blob/3",
      "polyhedra/cubintet",
      "polyhedra/cubintet/0",
      "polyhedra/CUBINTET/3",
    ])
      expect(typeof parseSpaceId("polyhedra", bad), bad).toBe("string");
    expect(formatSpaceId("polyhedra", { code: "pr3l15incub", P: 7 })).toBe("polyhedra/pr3l15incub/7");
  });

  it("touching passes, an overlap or a protrusion of 1e-6 does not", () => {
    // two unit cubes in a cube of edge 2: the bound is 2^(1/3), so the size check passes
    expect(check("polyhedra", "polyhedra/cubincub/2", row(2, 0, 2)).valid).toBe(true);
    expect(check("polyhedra", "polyhedra/cubincub/2", row(2, -5e-10, 2)).valid).toBe(true);
    const v = check("polyhedra", "polyhedra/cubincub/2", row(2, -1e-6, 2));
    expect(v.valid).toBe(false);
    expect(v.reasons[0]).toMatch(/pieces 0 and 1 overlap by/);
    const out = check("polyhedra", "polyhedra/cubincub/2", row(2, 0, 2 - 2e-6));
    expect(out.valid).toBe(false);
    expect(out.reasons[0]).toMatch(/sticks out of the container/);
  });

  it("beating a record takes a relative 1e-6, site entries the tie tolerance", () => {
    expect(SPACE_RECORD_MARGIN.polyhedra).toBe(1e-6);
    // every other space beats its records by the tie tolerance
    for (const s of SPACE_NAMES) if (s !== "polyhedra") expect(SPACE_RECORD_MARGIN[s], s).toBe(1e-9);
    // boundary: 1e-12 below a record is a tie, 2e-9 below beats it
    expect(improvesSpaceBest("boundary", 1 - 1e-12, 1, null)).toBe(false);
    expect(improvesSpaceBest("boundary", 1 - 2e-9, 1, null)).toBe(true);
    expect(beatsSpaceRecord("polyhedra", 1 - 5e-7, 1)).toBe(false);
    expect(beatsSpaceRecord("polyhedra", 1 - 2e-6, 1)).toBe(true);
    expect(beatsSpaceRecord("torus", 1 - 2e-9, 1)).toBe(true);
    expect(improvesSpaceBest("polyhedra", 1 - 2e-6, 1, null)).toBe(true);
    // against a site leader, the tie tolerance: 1 - 2e-6 beats 1 - 1.5e-6, not 1 - 1.9995e-6
    expect(improvesSpaceBest("polyhedra", 1 - 2e-6, 1, 1 - 1.5e-6)).toBe(true);
    expect(improvesSpaceBest("polyhedra", 1 - 2e-6, 1, 1 - 1.9995e-6)).toBe(false);
    expect(improvesSpaceBest("polyhedra", 1 - 5e-7, 1, null)).toBe(false);
    expect(improvesSpaceBest("surface", 1 - 5e-7, 1, null)).toBe(true);
    // the strict check runs only below the record by the margin: an overlap of 5e-10 passes above it
    const c = row(2, -5e-10, 2);
    expect(validateSpaceSubmission("polyhedra", "polyhedra/cubincub/2", c, { certified: 2 * (1 + 5e-7) }).valid).toBe(
      true,
    );
    const strict = validateSpaceSubmission("polyhedra", "polyhedra/cubincub/2", c, { certified: 2 * (1 + 2e-6) });
    expect(strict.valid).toBe(false);
    expect(strict.reasons[0]).toBe(SPACE_STRICT_REASON);
  });

  it("refuses malformed poses, a wrong count and a P above the catalogue's", () => {
    const base = row(2, 0, 2);
    const bad = (piece: unknown[]) =>
      check("polyhedra", "polyhedra/cubincub/2", { s: 2, pieces: [base.pieces[0], piece] });
    expect(bad([0.5, 0, 0, 1e101, 0, 0, 0]).malformed).toBe(true);
    expect(bad([0.5, 0, 0, 0, 0, 0, 0]).reasons[0]).toMatch(/quaternion must have a norm of at least/);
    expect(bad([0.5, 0, Number.NaN, 1, 0, 0, 0]).malformed).toBe(true);
    expect(bad([0.5, 0, 0, 1, 0, 0]).malformed).toBe(true);
    expect(bad([20000, 0, 0, 1, 0, 0, 0]).reasons[0]).toMatch(/at most 10000/);
    // a large quaternion is only a direction: the records store exact rational rotations with large integers
    expect(bad([0.5, 0, 0, 3e40, 0, 0, 0]).valid).toBe(true);
    const short = check("polyhedra", "polyhedra/cubincub/3", base);
    expect(short.malformed).toBe(false);
    expect(short.reasons[0]).toMatch(/expected 3 pieces/);
    const big = validateSpaceSubmission("polyhedra", "polyhedra/cubincub/501", row(501, 0, 600));
    expect(big.malformed).toBe(true);
    expect(big.reasons[0]).toMatch(/P = 501 is above the largest P of the polyhedra catalogue \(500\)/);
  });

  it("accepts P = 100 records, and checks the largest records within the work bound", () => {
    expect(SPACE_MAX_P.polyhedra).toBe(500);
    expect(cat("polyhedra").maxP).toBe(500);
    // 100 cubes in a row in a cube of edge 100, touching
    expect(check("polyhedra", "polyhedra/cubincub/100", row(100, 0, 100)).valid).toBe(true);
    // the largest solids (120 and 92 vertices) at P = 100
    for (const id of ["polyhedra/tidintid/100", "polyhedra/phcinphc/100"]) {
      const p = problem("polyhedra", id);
      const c = configOf(p);
      expect(c.pieces).toHaveLength(100);
      const t0 = performance.now();
      expect(check("polyhedra", p.id, c).valid, id).toBe(true);
      expect(performance.now() - t0, id).toBeLessThan(3000);
    }
  });
});

describe("the asynchronous check of a server", () => {
  it("gives the verdicts of the synchronous check, in many short slices of work", async () => {
    const id = "polyhedra/tidintid/100";
    const p = problem("polyhedra", id);
    const config = configOf(p);
    // the record below a certified value 0.1 % worse: both checks run, the strict one too
    const opts = { bound: p.bound!.value, certified: p.certified!.score * 1.001 };
    const v = await validateSpaceSubmissionAsync("polyhedra", id, config, opts);
    expect(v.valid, v.reasons.join("; ")).toBe(true);
    expect(v.workMs).toBeGreaterThan(0);
    // [CALC] about 0.3 s of work in slices of 20 ms; measured inside the slicer, so a loaded machine does
    // not fail it, while one block of the whole check (about 0.15 s each) would
    expect(v.slices).toBeGreaterThan(5);
    expect(v.longestSliceMs).toBeLessThan(100);
    const { workMs: _, slices: _s, longestSliceMs: _l, ...verdict } = v;
    expect(verdict).toEqual(validateSpaceSubmission("polyhedra", id, config, opts));
    // an overlap, a protrusion, malformed input and another space give the same answers as well
    const moved = {
      ...config,
      pieces: config.pieces.map((q: number[], i: number) => (i === 1 ? [...config.pieces[0]] : q)),
    };
    const cases: [SpaceName, string, unknown][] = [
      ["polyhedra", id, moved],
      ["polyhedra", id, { ...config, s: config.s * 0.99 }],
      ["polyhedra", id, { s: 1 }],
      ["sphere", "sphere/4/12", configOf(problem("sphere", "sphere/4/12"))],
    ];
    for (const [space, pid, c] of cases) {
      const {
        workMs: __,
        slices: _s2,
        longestSliceMs: _l2,
        ...a
      } = await validateSpaceSubmissionAsync(space, pid, c, {
        bound: problem(space, pid).bound!.value,
      });
      expect(a, pid).toEqual(validateSpaceSubmission(space, pid, c, { bound: problem(space, pid).bound!.value }));
    }
  });
});

describe("polyhedra configurations, read on demand", () => {
  const polyhedra = () => cat("polyhedra");
  const entry = (id: string) => problem("polyhedra", id);

  it("keep the catalogue to its index: no polyhedra configuration is held in memory", () => {
    expect(polyhedra().problems.every((p) => p.config === null && p.configApart === true)).toBe(true);
    expect(polyhedra().problems.every((p) => p.configAt![1] > 0 && p.configAt![1] < 100_000)).toBe(true);
    expect(cat("sphere").problems.every((p) => typeof p.config === "string" && !p.configApart)).toBe(true);
    expect(typeof polyhedra().loadConfig).toBe("function");
  });

  it("read a record of 100 pieces alone from its problem's file, then from the cache", async () => {
    const { load, cached, stats } = configLoader(root, polyhedra());
    const p = entry("polyhedra/phcinphc/100");
    let t0 = performance.now();
    const cold = await load(p);
    const coldMs = performance.now() - t0;
    t0 = performance.now();
    const warm = await load(p);
    const warmMs = performance.now() - t0;
    expect(cold).not.toBeNull();
    expect(warm).toBe(cold);
    expect(JSON.parse(cold!).pieces).toHaveLength(100);
    expect(cached()).toEqual(["polyhedra/phcinphc/100"]);
    // one read of that line only: the bytes kept are the configuration's own
    expect(stats()).toEqual({ reads: 1, peakAtOnce: 1, bytes: cold!.length });
    expect(warmMs).toBeLessThan(Math.max(5, coldMs));
    // the same configuration the catalogue's own loader and the synchronous reader give
    expect(await entryConfig(polyhedra(), p)).toBe(cold);
    expect(readEntryConfigSync(root, polyhedra(), p)).toBe(cold);
  });

  it(`keep at most ${CONFIG_CACHE_BYTES} bytes, read at most ${CONFIG_READS_AT_ONCE} at once, and share a read in progress`, async () => {
    expect(CONFIG_CACHE_BYTES).toBe(4_000_000);
    expect(CONFIG_READS_AT_ONCE).toBe(4);
    const sizes = new Map<string, number>();
    for (const code of ["tidintid", "phcinphc", "dtcindtc", "cubincub"])
      sizes.set(code, readEntryConfigSync(root, polyhedra(), entry(`polyhedra/${code}/100`))!.length);
    // room for two of the largest
    const limit = sizes.get("tidintid")! + sizes.get("phcinphc")! + 10;
    const { load, cached, stats } = configLoader(root, polyhedra(), () => {}, limit, 2);
    const [a, b] = await Promise.all([load(entry("polyhedra/tidintid/100")), load(entry("polyhedra/tidintid/100"))]);
    expect(a).toBe(b);
    expect(stats().reads).toBe(1);
    await load(entry("polyhedra/phcinphc/100"));
    expect(cached()).toEqual(["polyhedra/tidintid/100", "polyhedra/phcinphc/100"]);
    // a third evicts the least recently used one
    await load(entry("polyhedra/dtcindtc/100"));
    expect(cached()).toEqual(["polyhedra/phcinphc/100", "polyhedra/dtcindtc/100"]);
    expect(stats().bytes).toBeLessThanOrEqual(limit);
    // many at once: at most two reads run together
    const ids = Array.from({ length: 30 }, (_, k) => entry(`polyhedra/cubincub/${k + 2}`));
    const all = await Promise.all(ids.map((e) => load(e)));
    expect(all.every((c, k) => JSON.parse(c!).pieces.length === k + 2)).toBe(true);
    expect(stats().peakAtOnce).toBe(2);
    expect(stats().bytes).toBeLessThanOrEqual(limit);
    // entries of other spaces keep their configuration in the catalogue
    const sphere = problem("sphere", "sphere/4/12");
    expect(await load(sphere)).toBe(sphere.config);
  });

  it("never keep a failed read, and leave out a line that is not the record's, with a line in the log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polypack-configs-"));
    mkdirSync(join(dir, "data", "polyhedra", "configs"), { recursive: true });
    const lines = [
      JSON.stringify({
        P: 2,
        config: {
          s: 2,
          pieces: [
            [-0.5, 0, 0, 1, 0, 0, 0],
            [0.5, 0, 0, 1, 0, 0, 0],
          ],
        },
      }),
      JSON.stringify({ P: 3, config: { s: 2, pieces: [[0, 0, 0, 1, 0, 0, 0]] } }),
      JSON.stringify({ P: 5, config: { s: 2, pieces: [] } }),
    ];
    const at = (k: number) => [lines.slice(0, k).reduce((n, l) => n + l.length + 1, 0), lines[k].length];
    const rec = (P: number, k: number) => ({
      id: `polyhedra/cubincub/${P}`,
      code: "cubincub",
      piece: "cube",
      container: "cube",
      family: "platonic",
      P,
      score_float: 2,
      score_cert: 2,
      display: "2.000000",
      status: "best_known",
      config_at: at(k),
      bound: { value: Math.cbrt(P), kind: "volume" },
    });
    const small = buildSpaceCatalogue("polyhedra", { generated: "test", records: [rec(2, 0), rec(3, 1), rec(4, 2)] });
    expect(small.skipped).toEqual([]);
    const log: string[] = [];
    const { load, cached } = configLoader(dir, small, (m) => log.push(m));
    const e = (P: number) => small.byId.get(`polyhedra/cubincub/${P}`)!;
    // the file is missing: null, and nothing kept
    expect(await load(e(2))).toBeNull();
    expect(cached()).toEqual([]);
    expect(log.join("\n")).toMatch(/polyhedra\/cubincub\/2: configuration not read/);
    // once the file is there, the same loader reads it
    writeFileSync(join(dir, "data", "polyhedra", "configs", "cubincub.jsonl"), lines.join("\n") + "\n");
    expect(JSON.parse((await load(e(2)))!)).toEqual({
      s: 2,
      pieces: [
        [-0.5, 0, 0, 1, 0, 0, 0],
        [0.5, 0, 0, 1, 0, 0, 0],
      ],
    });
    // a configuration that is not valid input, and a line of another P, are left out and not kept
    expect(await load(e(3))).toBeNull();
    expect(log.join("\n")).toMatch(/polyhedra\/cubincub\/3: configuration left out: .*3 pieces/);
    expect(await load(e(4))).toBeNull();
    expect(log.join("\n")).toMatch(
      /polyhedra\/cubincub\/4: configuration left out: the line at config_at is not the configuration of P = 4/,
    );
    expect(cached()).toEqual(["polyhedra/cubincub/2"]);
    // a line whose size is not the index's certified score is left out, logged once, and not kept
    const stale = buildSpaceCatalogue("polyhedra", {
      generated: "test",
      records: [{ ...rec(2, 0), score_cert: 2.002, score_float: 2.002, display: "2.002000" }],
    });
    const staleLog: string[] = [];
    const staleLoader = configLoader(dir, stale, (m) => staleLog.push(m));
    const se = stale.byId.get("polyhedra/cubincub/2")!;
    expect(await staleLoader.load(se)).toBeNull();
    expect(await staleLoader.load(se)).toBeNull();
    expect(staleLoader.cached()).toEqual([]);
    expect(staleLog).toEqual([
      "[spaces] polyhedra/cubincub/2: configuration left out: its size 2 is not the certified 2.002 of the index",
    ]);
    expect(readEntryConfigSync(dir, stale, se)).toBeNull();
    // a record without config_at is left out of the catalogue
    const { config_at: _, ...bare } = rec(2, 0);
    expect(buildSpaceCatalogue("polyhedra", { generated: "test", records: [bare] }).skipped[0]).toMatch(/no config_at/);
  });
});
