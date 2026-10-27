import { afterEach, describe, expect, it, vi } from "vitest";
import { PROBLEM_NAMES } from "@polypack/polyhedra/catalogue";
import { SURFACE_CATALAN as PKG_CATALAN, SURFACE_PLATONIC as PKG_PLATONIC, SURFACE_SOLIDS } from "@polypack/spaces";
import {
  CLOSE_TO_BOUND,
  ListedSpaceProblem,
  STARTER_P,
  SURFACE_CATALAN,
  SURFACE_PLATONIC,
  SURFACE_PRISMS,
  dealtFromListing,
  drawSliceProblem,
  inSlice,
  polyhedraCodes,
  sliceOfId,
} from "../src/tighter/catalogue";
import { newDealer } from "../src/tighter/dealer";
import { FAMILY_FACTOR, SPACE_METHODS, UNITS_AT_20, rulesOf, spaceFields, unitsFor } from "../src/tighter/families";
import { SpaceKey, parseKey, poly } from "../src/tighter/frontier";
import { newGame, newProblem } from "../src/tighter/game";
import { normalizeOffer } from "../src/tighter/picks";
import { bucketOf, passes, rankCandidates } from "../src/tighter/rank";
import { fromJson, toJson } from "../src/tighter/save";
import { SLICES, SliceId } from "../src/tighter/slices";
import {
  classifySpaceAnswer,
  fetchSpaceProblem,
  plainConfig,
  readSpaceBody,
  spaceDealable,
  spaceStands,
  spaceSubmissionBody,
  spaceTier,
} from "../src/tighter/space-submission";

const T0 = 1_700_000_000_000;
const key = (id: string): SpaceKey => {
  const k = parseKey(id);
  if (!k || k.family === "polygon") throw new Error(id);
  return k;
};

describe("Tighter space titles and score words", () => {
  it("name each family's problems in plain words", () => {
    const title = (id: string) => rulesOf(key(id)).title(key(id));
    expect(title("surface/cube/fold/4/30")).toBe("30 squares on a cube, folded over its edges");
    expect(title("surface/rhombic_dodecahedron/nofold/3/20")).toBe(
      "20 triangles on a rhombic dodecahedron, kept inside its faces",
    );
    expect(title("surface/antiprism4/fold/0/9")).toBe("9 disks on a square antiprism, folded over its edges");
    expect(title("sphere/4/12")).toBe("12 squares on a sphere");
    expect(title("torus/hex/5/8")).toBe("8 pentagons on a hexagonal torus");
    expect(title("torus/sq/4/8")).toBe("8 squares on a square torus");
    expect(title("curved/-1/3/4/7")).toBe("7 triangles in a square at curvature −1");
    expect(title("curved/1/3/0/5")).toBe("5 triangles in a disk at curvature 1");
    expect(title("polyhedra/cubintet/12")).toBe("12 cubes in a tetrahedron");
    expect(title("balls/ballinball/13")).toBe("13 balls in a ball");
  });

  it("use the word the container's score is", () => {
    const word = (id: string) => rulesOf(key(id)).scoreWord(key(id));
    expect(word("surface/cube/fold/4/30")).toBe("edge");
    expect(word("sphere/4/12")).toBe("radius");
    expect(word("torus/hex/5/8")).toBe("side");
    expect(word("curved/-1/3/0/7")).toBe("radius");
    expect(word("curved/-1/3/4/7")).toBe("side");
    expect(word("polyhedra/cubintet/12")).toBe("scale");
    expect(word("balls/ballincub/9")).toBe("edge");
    expect(word("balls/tetinball/9")).toBe("radius");
  });

  it("read every id the packages write, and none that is another's", () => {
    expect(spaceFields("surface/cube/fold/4/30")).toMatchObject({
      family: "surface",
      solid: "cube",
      mode: "fold",
      N: 4,
      P: 30,
    });
    expect(spaceFields("curved/1e-06/3/4/7")).toMatchObject({ family: "curved", K: "1e-06", N: 3, M: 4, P: 7 });
    expect(spaceFields("24/30/60")).toBeNull();
    expect(spaceFields("sphere/x/12")).toBeNull();
  });
});

describe("Tighter space weights, bounds and units", () => {
  it("weigh pieces by distinctness and the others 1, times the family factor", () => {
    for (const f of Object.values(FAMILY_FACTOR)) expect(f).toBe(1);
    expect(rulesOf(key("sphere/40/12")).weight(key("sphere/40/12"))).toBeCloseTo(0.5, 12);
    expect(rulesOf(key("sphere/4/12")).weight(key("sphere/4/12"))).toBe(1);
    expect(rulesOf(key("curved/-1/40/50/7")).weight(key("curved/-1/40/50/7"))).toBeCloseTo(0.5 * 0.4, 12);
    expect(rulesOf(key("polyhedra/cubintet/12")).weight(key("polyhedra/cubintet/12"))).toBe(1);
  });

  it("take a space problem's bound from the server", () => {
    const k = key("sphere/4/12");
    expect(rulesOf(k).bound({ ...k, bound: 1.7 })).toBe(1.7);
    expect(rulesOf(k).bound({ ...k, bound: null })).toBeNull();
    expect(rulesOf(k).bound(k)).toBeNull();
  });

  it("size a game evaluation to about 5 ms: U = max(1, round(base x 20 / P))", () => {
    expect(unitsFor(400, 20)).toBe(400);
    expect(unitsFor(400, 40)).toBe(200);
    expect(unitsFor(6, 100)).toBe(1);
    expect(unitsFor(8, 400)).toBe(1);
    const u = (id: string) => rulesOf(key(id)).unitsPerEvaluation(key(id));
    expect(u("sphere/4/20")).toBe(UNITS_AT_20.sphere);
    expect(u("torus/hex/4/10")).toBe(1200);
    expect(u("balls/ballinball/50")).toBe(400);
    expect(u("balls/cubinball/20")).toBe(UNITS_AT_20["balls:solid"]);
    expect(u("curved/-1/3/4/20")).toBe(40);
    expect(u("surface/cube/fold/4/20")).toBe(6);
    expect(u("surface/rhombic_dodecahedron/nofold/4/20")).toBe(60);
    expect(u("polyhedra/cubintet/60")).toBe(10);
    expect(rulesOf(poly(24, 30, 60)).unitsPerEvaluation(poly(24, 30, 60))).toBe(1);
  });

  it("offer the generic methods, mc_compress first and without seed", () => {
    expect(SPACE_METHODS[0]).toBe("mc_compress");
    expect(SPACE_METHODS).not.toContain("seed");
    expect(SPACE_METHODS).not.toContain("ls_growth");
    expect(rulesOf(key("sphere/4/12")).methods).toEqual(SPACE_METHODS);
  });
});

describe("Tighter catalogue", () => {
  const sample = (slice: SliceId, n: number, starter = false, listings = {}) => {
    const d = newDealer(7);
    const out: SpaceKey[] = [];
    const exclude = new Set<string>();
    for (let i = 0; i < n; i++) {
      const k = drawSliceProblem(d, slice, { listings, exclude, starter });
      if (!k) break;
      exclude.add(k.id);
      out.push(k);
    }
    return out;
  };

  it("lists the solids as the spaces package does", () => {
    expect([...SURFACE_PLATONIC]).toEqual([...PKG_PLATONIC]);
    expect([...SURFACE_CATALAN].sort()).toEqual([...PKG_CATALAN].sort());
    const solids = [...SURFACE_PLATONIC, ...SURFACE_CATALAN, ...SURFACE_PRISMS].sort();
    expect(solids).toEqual([...SURFACE_SOLIDS].sort());
  });

  it("never deals a surface without folding on a Platonic solid, a prism or an antiprism", () => {
    for (const slice of SLICES.filter((s) => s.family === "surface"))
      for (const k of sample(slice.id, 120)) {
        const f = spaceFields(k.id)!;
        if (f.family !== "surface") throw new Error(k.id);
        if (f.mode === "nofold") expect(SURFACE_CATALAN).toContain(f.solid);
        expect(inSlice(slice.id, k.id)).toBe(true);
      }
    for (const solid of [...SURFACE_PLATONIC, ...SURFACE_PRISMS])
      expect(sliceOfId(`surface/${solid}/nofold/4/12`)).toBeNull();
  });

  it("puts sample ids in their slices", () => {
    expect(sliceOfId("surface/cube/fold/4/12")).toBe("surf-platonic");
    expect(sliceOfId("surface/prism5/fold/4/12")).toBe("surf-prisms");
    expect(sliceOfId("surface/antiprism12/fold/0/12")).toBe("surf-prisms");
    expect(sliceOfId("surface/rhombic_dodecahedron/fold/4/12")).toBe("surf-catalan-a");
    expect(sliceOfId("surface/triakis_octahedron/fold/4/12")).toBe("surf-catalan-a");
    expect(sliceOfId("surface/rhombic_triacontahedron/fold/4/12")).toBe("surf-catalan-b");
    expect(sliceOfId("surface/pentakis_dodecahedron/fold/4/12")).toBe("surf-catalan-b");
    expect(sliceOfId("surface/disdyakis_triacontahedron/fold/4/12")).toBe("surf-catalan-c");
    expect(sliceOfId("surface/tetrakis_hexahedron/nofold/4/12")).toBe("surf-nofold-catalan");
    expect(sliceOfId("sphere/4/12")).toBe("sphere");
    expect(sliceOfId("torus/hex/5/8")).toBe("torus");
    expect(sliceOfId("curved/-1/3/4/7")).toBe("curved");
    expect(sliceOfId("balls/ballinball/13")).toBe("balls");
    expect(sliceOfId("polyhedra/tteintte/12")).toBe("poly-archimedean");
    expect(sliceOfId("polyhedra/cubintet/12")).toBe("poly-platonic");
    expect(sliceOfId("polyhedra/kttinktt/12")).toBe("poly-catalan");
    expect(sliceOfId("polyhedra/pr3inpr3/12")).toBe("poly-prisms");
    expect(sliceOfId("polyhedra/pr3incub/12")).toBe("poly-cube");
    expect(sliceOfId("polyhedra/pr3l15incub/12")).toBe("poly-elongated");
    expect(sliceOfId("polyhedra/bp3inbp3/12")).toBe("poly-duals");
    expect(sliceOfId("polyhedra/tz4incub/12")).toBe("poly-duals");
    expect(sliceOfId("polyhedra/nonsense/12")).toBeNull();
    expect(sliceOfId("24/30/60")).toBeNull();
  });

  it("puts each of the 150 polyhedra codes in exactly one slice", () => {
    const slices = SLICES.filter((s) => s.family === "polyhedra").map((s) => s.id);
    const all = slices.flatMap((s) => polyhedraCodes(s));
    expect(all).toHaveLength(PROBLEM_NAMES.length);
    expect(new Set(all).size).toBe(all.length);
    expect(polyhedraCodes("poly-platonic")).toHaveLength(25);
  });

  it("draws the same problems from the same seed, and none twice", () => {
    for (const slice of ["surf-platonic", "surf-catalan-c", "balls"] as const) {
      const a = sample(slice, 30);
      const b = sample(slice, 30);
      expect(a).toEqual(b);
      expect(new Set(a.map((k) => k.id)).size).toBe(a.length);
    }
  });

  it("draws surfaces within N 0 or 3 to 100 and P 1 to 100, and balls within P 2 to 100", () => {
    for (const k of sample("surf-platonic", 200)) {
      const f = spaceFields(k.id)!;
      if (f.family !== "surface") throw new Error(k.id);
      expect(f.N === 0 || (f.N >= 3 && f.N <= 100)).toBe(true);
      expect(f.P).toBeGreaterThanOrEqual(1);
      expect(f.P).toBeLessThanOrEqual(100);
      expect(f.P).toBe(k.P);
    }
    for (const k of sample("balls", 100)) {
      expect(k.P).toBeGreaterThanOrEqual(2);
      expect(k.P).toBeLessThanOrEqual(100);
    }
  });

  it("draws a starter corner of few pieces and simple shapes", () => {
    for (const slice of ["surf-platonic", "balls"] as const)
      for (const k of sample(slice, 20, true)) {
        expect(k.P).toBeGreaterThanOrEqual(STARTER_P.min);
        expect(k.P).toBeLessThanOrEqual(STARTER_P.max);
        const f = spaceFields(k.id)!;
        if (f.family === "surface") {
          expect(f.N).toBeLessThanOrEqual(6);
          expect(["tetrahedron", "cube", "octahedron"]).toContain(f.solid);
        }
      }
  });

  const entry = (id: string, over: Partial<ListedSpaceProblem> = {}): ListedSpaceProblem => ({
    id,
    P: Number(id.split("/").at(-1)),
    accepts_submissions: true,
    certified: { score: 2, status: "best_known" },
    bound: { value: 1.5 },
    ...over,
  });

  it("deals records' problems from the listing, leaving out the closed, proven and the ones at their bound", () => {
    expect(dealtFromListing(entry("sphere/4/12"))).toBe(true);
    expect(dealtFromListing(entry("sphere/4/12", { accepts_submissions: false }))).toBe(false);
    expect(dealtFromListing(entry("sphere/4/12", { status: "proven" }))).toBe(false);
    expect(dealtFromListing(entry("sphere/4/12", { certified: { score: 2, status: "infeasible" } }))).toBe(false);
    expect(dealtFromListing(entry("sphere/4/12", { certified: { score: 1.5 * (1 + CLOSE_TO_BOUND / 2) } }))).toBe(
      false,
    );
    expect(dealtFromListing(entry("sphere/4/12", { certified: { score: 1.5 * (1 + 10 * CLOSE_TO_BOUND) } }))).toBe(
      true,
    );
    expect(dealtFromListing(entry("sphere/4/12", { certified: null, bound: null }))).toBe(true);
    const listings = {
      sphere: [
        entry("sphere/4/12"),
        entry("sphere/4/14", { status: "proven" }),
        entry("sphere/4/30"),
        entry("sphere/3/16"),
      ],
    };
    const ids = sample("sphere", 10, false, listings).map((k) => k.id);
    expect(ids.sort()).toEqual(["sphere/3/16", "sphere/4/12", "sphere/4/30"]);
    // a starter takes the small ones while there are
    expect(sample("sphere", 1, true, listings)[0].P).toBeLessThanOrEqual(STARTER_P.max);
    // without a listing, nothing
    expect(sample("sphere", 3)).toEqual([]);
    expect(sample("poly-platonic", 3)).toEqual([]);
  });

  it("deals a polyhedra slice's problems from the listing by code group", () => {
    const listings = {
      polyhedra: [entry("polyhedra/cubintet/12"), entry("polyhedra/tteintte/9"), entry("polyhedra/pr3incub/10")],
    };
    expect(sample("poly-platonic", 5, false, listings).map((k) => k.id)).toEqual(["polyhedra/cubintet/12"]);
    expect(sample("poly-cube", 5, false, listings).map((k) => k.id)).toEqual(["polyhedra/pr3incub/10"]);
  });
});

describe("Tighter space problems read from the server", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    space: "sphere",
    id: "sphere/4/12",
    accepts_submissions: true,
    status: "best_known",
    certified: { score: 3, status: "best_known" },
    bound: { value: 2.5, label: "area" },
    site_best: null,
    certified_config: { rho: 3, pieces: [] },
    site_config: null,
    ...over,
  });

  it("deal a problem without a record as open, and one with a record as a site record to beat", () => {
    const open = readSpaceBody("sphere/4/12", body({ certified: null, status: "no_record", certified_config: null }))!;
    expect(spaceDealable(open)).toBe(true);
    expect(spaceTier(open)).toBe("open");
    expect(open.leader).toBeNull();
    expect(open.bound).toBe(2.5);
    const rec = readSpaceBody("sphere/4/12", body())!;
    expect(spaceTier(rec)).toBe("batch");
    expect(rec.leader).toEqual({ score: 3, name: "the research record", id: null });
    expect(rec.config).toEqual({ rho: 3, pieces: [] });
  });

  it("take the smaller of the research record and the site's best as the leader", () => {
    const site = { id: 9, score: 2.9, name: "Ada", created_at: "2026-10-26" };
    const better = readSpaceBody("sphere/4/12", body({ site_best: site, site_config: { rho: 2.9, pieces: [] } }))!;
    expect(better.leader).toEqual({ score: 2.9, name: "Ada", id: 9 });
    expect(better.config).toEqual({ rho: 2.9, pieces: [] });
    const worse = readSpaceBody("sphere/4/12", body({ site_best: { ...site, score: 3.5 } }))!;
    expect(worse.leader!.id).toBeNull();
    expect(worse.leader!.score).toBe(3);
  });

  it("never deal a closed problem or one without a bound", () => {
    for (const over of [
      { accepts_submissions: false },
      { status: "proven" },
      { status: "infeasible" },
      { bound: null },
    ]) {
      const r = readSpaceBody("sphere/4/12", body(over))!;
      expect(spaceDealable(r)).toBe(false);
    }
    expect(spaceDealable(null)).toBe(false);
  });

  it("reject an answer that is not this problem's", () => {
    expect(readSpaceBody("sphere/4/14", body())).toBeNull();
    expect(readSpaceBody("sphere/4/12", { id: "sphere/4/12" })).toBeNull();
    expect(readSpaceBody("sphere/4/12", null)).toBeNull();
    expect(plainConfig([1])).toBeNull();
    expect(plainConfig({ pieces: "x".repeat(500_000) })).toBeNull();
    expect(plainConfig({ rho: 1 })).toEqual({ rho: 1 });
  });

  it("find an offer standing while it takes entries and has the leader it had", () => {
    const rec = readSpaceBody("sphere/4/12", body())!;
    expect(spaceStands(rec, { tier: "batch", leader: { score: 3 } })).toBe(true);
    expect(spaceStands(rec, { tier: "batch", leader: { score: 2.8 } })).toBe(false);
    expect(spaceStands(rec, { tier: "open", leader: null })).toBe(false);
    const open = readSpaceBody("sphere/4/12", body({ certified: null }))!;
    expect(spaceStands(open, { tier: "open", leader: null })).toBe(true);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("read GET /api/spaces/<space>/problems/<id> with the id's slashes kept", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(body()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchSpaceProblem("sphere", "sphere/4/12");
    expect(fetchMock).toHaveBeenCalledWith("/api/spaces/sphere/problems/sphere/4/12");
    expect(r.status).toBe(200);
    expect(r.read!.bound).toBe(2.5);
    vi.stubGlobal("fetch", async () => new Response("no", { status: 404 }));
    expect(await fetchSpaceProblem("sphere", "sphere/4/12")).toEqual({ status: 404, read: null });
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await fetchSpaceProblem("sphere", "sphere/4/12")).toEqual({ status: null, read: null });
  });
});

describe("Tighter space submissions", () => {
  it("send the board with the name, the software, the method and the seed", () => {
    const run = { method: "basin_hopping", params: {}, seed: 1234, budget: { evals: 300 } };
    expect(spaceSubmissionBody({ family: "sphere", id: "sphere/4/12" }, { rho: 3, pieces: [] }, "Ada", run)).toEqual({
      space: "sphere",
      id: "sphere/4/12",
      config: { rho: 3, pieces: [] },
      name: "Ada",
      software: "tighter/0.1",
      method: "sphere basin_hopping",
      seed: 1234,
    });
  });

  it("map the server's answers to outcomes", () => {
    const ok = { valid: true, reasons: [], score: 2.9, leader: true, best_score: 2.9, id: 5, beats_certified: true };
    expect(classifySpaceAnswer(200, ok)).toEqual({ kind: "leader", score: 2.9, id: 5, pending: false });
    expect(classifySpaceAnswer(200, { ...ok, leader: false, id: null, best_score: 2.8 })).toEqual({
      kind: "behind",
      score: 2.9,
      leaderScore: 2.8,
    });
    // valid and leader but not kept: not a leader
    expect(classifySpaceAnswer(200, { ...ok, id: null })).toMatchObject({ kind: "behind" });
    // polyhedra: an entry that cannot be kept is not checked
    expect(
      classifySpaceAnswer(200, {
        valid: false,
        checked: false,
        score: 3,
        best_score: 2.5,
        reasons: [],
        leader: false,
        id: null,
      }),
    ).toEqual({ kind: "behind", score: 3, leaderScore: 2.5 });
    expect(classifySpaceAnswer(409, { reasons: ["proven"] })).toEqual({ kind: "closed", reasons: ["proven"] });
    expect(classifySpaceAnswer(400, { reasons: ["bad"] })).toEqual({ kind: "refused", status: 400, reasons: ["bad"] });
    expect(classifySpaceAnswer(422, { reasons: ["overlap"] })).toMatchObject({ kind: "refused", status: 422 });
    expect(classifySpaceAnswer(429, {})).toMatchObject({ kind: "rate-limited" });
    expect(classifySpaceAnswer(503, {})).toMatchObject({ kind: "rate-limited" });
    expect(classifySpaceAnswer(500, {})).toEqual({ kind: "offline" });
    expect(classifySpaceAnswer(null, null)).toEqual({ kind: "offline" });
    expect(classifySpaceAnswer(200, { valid: false, reasons: ["x"] })).toMatchObject({ kind: "refused" });
  });
});

describe("Tighter save with space problems", () => {
  it("round trips a space problem with its board and bound", () => {
    const g = newGame(T0, 1);
    const p = newProblem(key("sphere/4/12"), "batch", T0);
    p.bound = 2.5;
    p.phase = "ready";
    p.board = { rho: 3, pieces: [{ q: [1, 0, 0, 0] }] };
    p.best = 3;
    p.floor = 3;
    p.leader = { score: 3, name: "the research record", id: null };
    g.queue.push(p);
    g.focus = p.key;
    const r = fromJson(toJson(g), T0 + 1000);
    if (!r.ok) throw new Error("save not read");
    const q = r.state.queue[0];
    expect(q).toMatchObject({
      family: "sphere",
      id: "sphere/4/12",
      key: "sphere/4/12",
      bound: 2.5,
      phase: "ready",
      best: 3,
    });
    expect(q.board).toEqual({ rho: 3, pieces: [{ q: [1, 0, 0, 0] }] });
    expect(q.leader).toEqual({ score: 3, name: "the research record", id: null });
  });

  it("starts a problem bare when its board cannot be read, and drops one without a bound", () => {
    const g = newGame(T0, 1);
    const p = newProblem(key("torus/hex/5/8"), "open", T0);
    p.bound = 1.2;
    p.phase = "loaded";
    p.board = { pieces: [] };
    p.best = 2;
    g.queue.push(p);
    const raw = JSON.parse(toJson(g));
    raw.queue[0].board = [1, 2, 3];
    const bad = fromJson(JSON.stringify(raw), T0);
    if (!bad.ok) throw new Error("save not read");
    expect(bad.state.queue[0]).toMatchObject({ phase: "bare", board: null, best: null });
    raw.queue[0].board = { huge: "x".repeat(500_000) };
    const huge = fromJson(JSON.stringify(raw), T0);
    if (!huge.ok) throw new Error("save not read");
    expect(huge.state.queue[0].phase).toBe("bare");
    raw.queue[0].bound = null;
    const none = fromJson(JSON.stringify(raw), T0);
    if (!none.ok) throw new Error("save not read");
    expect(none.state.queue).toHaveLength(0);
  });

  it("keeps a space offer, a research record leader included", () => {
    const offer = {
      family: "sphere",
      id: "sphere/4/12",
      P: 12,
      tier: "batch",
      weakness: null,
      leader: { score: 3, name: "the research record", id: null },
      target: null,
      source: null,
      retake: false,
      bound: 2.5,
      score: 1,
      prior: 1,
      bucket: "batch|sphere|r6",
      at: 5,
    };
    expect(normalizeOffer(offer)).toMatchObject({
      family: "sphere",
      id: "sphere/4/12",
      bound: 2.5,
      leader: { id: null },
    });
    expect(normalizeOffer({ ...offer, leader: null })).toBeNull();
  });
});

describe("Tighter dealer given space candidates", () => {
  it("ranks, buckets and filters them without throwing", () => {
    const cands = [
      "sphere/4/12",
      "surface/cube/fold/4/30",
      "polyhedra/cubintet/12",
      "balls/ballinball/13",
      "curved/-1/3/4/7",
    ].map((id) => ({
      ...key(id),
      tier: id.startsWith("sphere") ? ("batch" as const) : ("open" as const),
      weakness: null,
      leader: null,
      target: null,
      source: null,
      retake: false,
      bound: 1.5,
    }));
    const ranked = rankCandidates(cands, null, () => 0.5);
    expect(ranked).toHaveLength(cands.length);
    for (const r of ranked) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThan(0);
      expect(r.bucket).toBe(bucketOf(r.candidate));
    }
    expect(() => rankCandidates(cands, {}, () => 0.3)).not.toThrow();
    for (const c of cands) expect(passes(null, c)).toBe(true);
    const filters = { pieces: [3], containers: [4], minP: 1, maxP: 500, tiers: ["open" as const] };
    expect(passes(filters, cands[1])).toBe(true);
    expect(passes(filters, cands[0])).toBe(false);
  });
});
