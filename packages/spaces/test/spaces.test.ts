import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SOLID_NAMES } from "@polypack/surface";
import { TORUS_FAMILIES as TORUS_PACKAGE_FAMILIES } from "@polypack/torus";
import { describe, expect, it } from "vitest";
import {
  SPACE_MAX_COORD,
  SPACE_STRICT_REASON,
  SPACE_STRICT_TOL,
  SPACE_INFO,
  SPACE_MAX_P,
  SPACE_NAMES,
  SURFACE_SOLIDS,
  SpaceName,
  SpaceProblemEntry,
  TORUS_FAMILIES,
  acceptsSubmissions,
  beatsSpaceScore,
  buildSpaceCatalogue,
  formatCurvature,
  formatSpaceId,
  parseSpaceId,
  spaceProblemSummary,
  validateSpaceSubmission,
} from "../src";
import { loadSpacesIndex } from "../src/load";

const root = resolve(__dirname, "../../..");
const index = loadSpacesIndex(root);
const cat = (space: SpaceName) => index[space]!;
const problem = (space: SpaceName, id: string): SpaceProblemEntry => {
  const p = cat(space).byId.get(id);
  if (!p) throw new Error(`${id} is not in the catalogue`);
  return p;
};
const configOf = (p: SpaceProblemEntry) => JSON.parse(p.config!);
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
    expect(n).toBe(2038 + 334 + 166 + 544);
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
    ];
    for (const [space, id] of bad) expect(typeof parseSpaceId(space, id), id).toBe("string");
    expect(parseSpaceId("curved", "curved/0.000001/0/0/2")).toMatch(/written 1e-06/);
    expect(typeof parseSpaceId("torus", 7)).toBe("string");
  });

  it("use the solids and lattice families of their packages", () => {
    expect([...SURFACE_SOLIDS]).toEqual([...SOLID_NAMES]);
    expect([...TORUS_FAMILIES]).toEqual([...TORUS_PACKAGE_FAMILIES]);
  });
});

describe("the catalogues", () => {
  it("load every record of the four files, none left out", () => {
    const counts = Object.fromEntries(SPACE_NAMES.map((s) => [s, cat(s).problems.length]));
    expect(counts).toEqual({ surface: 2038, curved: 334, sphere: 166, torus: 544 });
    for (const s of SPACE_NAMES) expect(cat(s).skipped).toEqual([]);
  });

  it("stay within the work bounds measured for the validators", () => {
    // if a catalogue grows beyond SPACE_MAX_P, measure the worst validation time again and raise it
    for (const s of SPACE_NAMES) expect(cat(s).maxP).toBeLessThanOrEqual(SPACE_MAX_P[s]);
  });

  it("close proven and infeasible problems and nothing else", () => {
    const closed = (s: SpaceName) => cat(s).problems.filter((p) => !acceptsSubmissions(p));
    expect(closed("surface")).toEqual([]);
    expect(closed("torus")).toEqual([]);
    expect(closed("sphere").map((p) => p.id)).toEqual([
      ...Array.from({ length: 13 }, (_, i) => `sphere/0/${i + 2}`),
      "sphere/0/24",
    ]);
    expect(closed("sphere").every((p) => p.status === "proven" && /is proven/.test(p.closed_reason!))).toBe(true);
    const infeasible = closed("curved");
    expect(infeasible.length).toBe(35);
    for (const p of infeasible) {
      expect(p.status).toBe("infeasible");
      expect(p.certified).toBeNull();
      expect(p.config).toBeNull();
      expect(p.closed_reason).toMatch(/^no packing exists/);
    }
  });

  it("normalise bounds to {value, label} from `value` or, for curved, `lower`", () => {
    const curved = problem("curved", "curved/-1/0/0/2");
    expect(curved.bound!.value).toBe(1.999999999999998);
    expect(curved.bound!.label).toMatch(/2 rho; \[CALC\] rigorous/);
    expect(problem("surface", "surface/tetrahedron/fold/0/1").bound!.label).toBe("one piece bound; [CALC]");
    expect(problem("torus", "torus/sq/0/1").bound).toEqual({
      value: 2,
      label: "[CALC] one disk: the shortest lattice vector L must be >= 2",
    });
    for (const s of SPACE_NAMES)
      for (const p of cat(s).problems)
        if (p.status !== "infeasible") {
          expect(p.bound, p.id).not.toBeNull();
          expect(p.bound!.value).toBeLessThanOrEqual(p.certified!.score);
        }
  });

  it("keep the configuration as JSON text in the submission format, unknown fields dropped", () => {
    const s = configOf(problem("surface", "surface/cube/fold/4/12"));
    expect(Object.keys(s)).toEqual(["s", "pieces"]);
    expect(Object.keys(s.pieces[0])).toEqual(["face", "x", "y", "theta"]);
    expect(Object.keys(configOf(problem("curved", "curved/-1/0/0/2")))).toEqual(["size", "pieces"]);
    expect(Object.keys(configOf(problem("sphere", "sphere/4/12")))).toEqual(["rho", "pieces"]);
    const t = configOf(problem("torus", "torus/free/5/8"));
    expect(Object.keys(t)).toEqual(["lattice", "poses"]);
    expect(Object.keys(t.lattice)).toEqual(["b1", "b2"]);
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

  it("log one line per space", () => {
    const logs: string[] = [];
    loadSpacesIndex(root, (m) => logs.push(m));
    expect(logs).toEqual(
      SPACE_NAMES.map((s) => expect.stringMatching(new RegExp(`^\\[spaces\\] ${s}: \\d+ problems`))),
    );
  });

  it("leave a space out when its records file is missing", () => {
    const empty = mkdtempSync(join(tmpdir(), "polypack-spaces-"));
    const logs: string[] = [];
    expect(loadSpacesIndex(empty, (m) => logs.push(m))).toEqual({});
    expect(logs).toEqual(
      SPACE_NAMES.map((s) => `[spaces] no ${s} records (${join("data", s, "records.json")} is missing)`),
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
          : {
              lattice:
                "L" in c.lattice
                  ? { L: c.lattice.L * f }
                  : { b1: c.lattice.b1.map((x: number) => x * f), b2: c.lattice.b2.map((x: number) => x * f) },
              poses: c.poses.map(([x, y, t]: number[]) => [x * f, y * f, t]),
            };

  it(`every record passes at ${SPACE_STRICT_TOL} at its stated size`, () => {
    const failures: string[] = [];
    for (const space of SPACE_NAMES)
      for (const p of cat(space).problems) {
        if (!p.config) continue;
        // a certified size of Infinity makes every configuration "beat" it, so the strict check runs
        const v = validateSpaceSubmission(space, p.id, configOf(p), {
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
    it(`${space}: at the stated size, which is score_cert or below it`, () => {
      const failures: string[] = [];
      for (const p of cat(space).problems) {
        if (!p.config) continue;
        const v = check(space, p.id, configOf(p));
        if (!v.valid) failures.push(`${p.id}: ${v.reasons.join("; ")}`);
        else if (!(v.score! <= p.certified!.score))
          failures.push(`${p.id}: size ${v.score} above score_cert ${p.certified!.score}`);
        if (space === "curved" || space === "sphere") expect(v.score).toBe(p.certified!.score);
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

  it("curved: two unit disks in a disk of radius 2 at K = -1", () => {
    const at = (r: number, size = 2) => ({
      size,
      pieces: [
        { x: r, y: 0, theta: 0 },
        { x: -r, y: 0, theta: 0 },
      ],
    });
    expect(check("curved", "curved/-1/0/0/2", at(1)).valid).toBe(true);
    expect(check("curved", "curved/-1/0/0/2", at(1 - 2e-10)).valid).toBe(true);
    const v = check("curved", "curved/-1/0/0/2", at(1 - 1e-6));
    expect(v.valid).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/pieces overlap by 0\.00000199/);
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

  it("torus: two disks on the square torus of side 2 sqrt 2", () => {
    const L = 2 * Math.SQRT2;
    const at = (d: number) => ({
      lattice: { L },
      poses: [
        [0, 0, 0],
        [Math.SQRT2 - d, Math.SQRT2 - d, 0],
      ],
    });
    expect(check("torus", "torus/sq/0/2", at(0)).valid).toBe(true);
    expect(check("torus", "torus/sq/0/2", at(1e-10 / Math.SQRT2)).valid).toBe(true);
    const v = check("torus", "torus/sq/0/2", at(1e-6 / Math.SQRT2));
    expect(v.valid).toBe(false);
    expect(v.reasons[0]).toMatch(/pieces 0 and 1 overlap .* by 9\.99\d*e-7/);
    // a piece and its own translate: one disk on a square torus of side below 2, overlapping
    // itself by 0.9e-9 (touching within the tolerance) and by 1.1e-9 (an overlap)
    const one = (L: number) => check("torus", "torus/sq/0/1", { lattice: { L }, poses: [[0, 0, 0]] });
    expect(one(2 - 0.9e-9).valid).toBe(true);
    expect(one(2 - 1.1e-9).reasons[0]).toMatch(/overlaps its own translate/);
    expect(
      validateSpaceSubmission("torus", "torus/sq/0/1", { lattice: { L: 2 - 1.1e-9 }, poses: [[0.3, 0.2, 0]] }).valid,
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
    // torus/sq/0/1 meets its bound L = 2 exactly
    const v = check("torus", "torus/sq/0/1", { lattice: { L: 2 * (1 - 1e-6) }, poses: [[0, 0, 0]] });
    expect(v.valid).toBe(false);
    expect(v.malformed).toBe(false);
    expect(v.reasons[0]).toMatch(/below the lower bound 2 of this problem/);
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
    expect(validateSpaceSubmission("torus", "torus/sq/0/50", { lattice: { L: 99 }, poses: [] }).reasons[0]).toMatch(
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
    expect(v.reasons[0]).toMatch(/^the fold check gave up: more than 200 chains/);
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
      lattice: { b1: [1.5, 0], b2: [0.3, 5] },
      poses: [
        [0, 0, 0],
        [0, 2.5, 0],
      ],
    };
    expect(check("torus", p.id, thin).reasons[0]).toMatch(
      /shorter than the piece's width 2: every piece overlaps its own translate/,
    );
  });
});

describe("space metadata", () => {
  it("names a viewer and the notes on GitHub for every space", () => {
    for (const s of SPACE_NAMES) {
      const i = SPACE_INFO[s];
      expect(i.viewer).toBe(`/spaces/${s}.html`);
      expect(i.docs).toMatch(/^https:\/\/github\.com\/sinkomr\/PolyPack\/blob\/main\/docs\/spaces\/[A-Z_]+\.md$/);
      expect(i.conventions.configuration).toBeTruthy();
      expect(i.conventions.validity).toMatch(/1e-9/);
      expect(i.conventions.improvement).toMatch(
        /by more than a relative 1e-9; one below the research record must also be valid with overlaps of at most 1e-11$/,
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
