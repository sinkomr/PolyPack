import { LeaderboardEntry, Pose, containerVertices, enclose, findOverlaps, pieceVertices } from "@polypack/geometry";
import { describe, expect, it } from "vitest";
import {
  AtlasRow,
  DEFAULT_VIEW,
  ListedRecord,
  chooseDrawable,
  containerOutline,
  drawPacking,
  drawableKey,
  hasHalfStep,
  layoutSize,
  normalizeView,
  parseView,
  safeHref,
  sizeRow,
  tileKey,
  tileLabel,
  tileStatus,
  tiltClass,
  tiltDegrees,
  tiltGroups,
  tiltLegend,
  tiltName,
  tiltOf,
  viewQuery,
} from "../src/atlas-model";

const PI = Math.PI;
const deg = (d: number) => (d * PI) / 180;

const lit = (value: number, extra: Partial<ListedRecord> = {}): ListedRecord => ({
  N: 4,
  M: 4,
  P: 5,
  value,
  display: String(value),
  display_precision: 6,
  status: "best_known",
  source_name: "test",
  source_url: "https://example.invalid",
  accessed: "2026-10-07",
  conversion_note: "none",
  ...extra,
});
const site = (score: number, extra: Partial<LeaderboardEntry> = {}): LeaderboardEntry => ({
  id: 9,
  name: "ann",
  agent: "human",
  agent_note: "",
  score,
  created_at: "2026-10-11T00:00:00Z",
  verification: "none",
  ...extra,
});

describe("tilt classes", () => {
  it("calls a square aligned when its sides are parallel to the square container's", () => {
    // an unrotated square piece stands on a vertex; theta = pi/4 lays a side flat
    expect(tiltClass(4, 4, tiltOf(4, 4, PI / 4, 0))).toBe(0);
    expect(tiltClass(4, 4, tiltOf(4, 4, 0, 0))).toBe(1);
    expect(tiltClass(4, 4, tiltOf(4, 4, deg(10), 0))).toBe(2);
    // the tilt is measured against the container, so turning both together changes nothing
    expect(tiltClass(4, 4, tiltOf(4, 4, PI / 4 + 0.3, 0.3))).toBe(0);
    expect(tiltClass(4, 4, tiltOf(4, 4, 0.3, 0.3))).toBe(1);
    expect(tiltClass(4, 4, tiltOf(4, 4, PI / 4, 0.3))).toBe(2);
  });

  it("reduces by the piece's rotational symmetry", () => {
    for (let k = -5; k <= 5; k++) {
      expect(tiltClass(4, 4, tiltOf(4, 4, PI / 4 + (k * PI) / 2, 0))).toBe(0);
      expect(tiltClass(3, 3, tiltOf(3, 3, (k * 2 * PI) / 3, 0))).toBe(0);
      expect(tiltClass(3, 3, tiltOf(3, 3, PI / 3 + (k * 2 * PI) / 3, 0))).toBe(1);
      expect(tiltOf(5, 4, 0.1 + (k * 2 * PI) / 5, 0)).toBeCloseTo(tiltOf(5, 4, 0.1, 0), 9);
    }
    expect(tiltOf(6, 6, 1.234, 0.5)).toBeGreaterThanOrEqual(0);
    expect(tiltOf(6, 6, 1.234, 0.5)).toBeLessThan(PI / 3);
  });

  it("is tolerant on both sides of the wrap-around", () => {
    for (const e of [-9e-7, -1e-9, 0, 1e-9, 9e-7]) {
      expect(tiltClass(4, 4, tiltOf(4, 4, PI / 4 + e, 0))).toBe(0);
      expect(tiltClass(4, 4, tiltOf(4, 4, e, 0))).toBe(1);
      expect(tiltClass(3, 0, tiltOf(3, 0, e, 0))).toBe(0);
    }
    expect(tiltClass(4, 4, tiltOf(4, 4, PI / 4 + 1e-4, 0))).toBe(2);
    expect(tiltClass(4, 4, tiltOf(4, 4, PI / 4 - 1e-4, 0))).toBe(2);
    expect(tiltClass(4, 4, 1e-3, 1e-2)).toBe(0); // a wider tolerance can be asked for
  });

  it("treats every container side as a way to be aligned", () => {
    // a pentagon in a square can lie flat against the bottom, the right, the top or the left side
    const flat = -PI - PI / 5; // theta that puts a pentagon side on the bottom side at phi = 0
    for (let j = 0; j < 4; j++) expect(tiltClass(5, 4, tiltOf(5, 4, flat + (j * PI) / 2, 0))).toBe(0);
    // the aligned tilts are 18 degrees apart here, so the half step (36 degrees) is itself aligned
    expect(tiltClass(5, 4, tiltOf(5, 4, flat + deg(36), 0))).toBe(0);
    expect(tiltClass(5, 4, tiltOf(5, 4, flat + deg(9), 0))).toBe(2);
    // a pentagon in a pentagon: side down is aligned, vertex down is the half step
    expect(tiltClass(5, 5, tiltOf(5, 5, 0, 0))).toBe(0);
    expect(tiltClass(5, 5, tiltOf(5, 5, deg(36), 0))).toBe(1);
    expect(tiltClass(5, 5, tiltOf(5, 5, deg(20), 0))).toBe(2);
    // an upright triangle in a triangle is aligned, an inverted one is the half step
    expect(tiltClass(3, 3, tiltOf(3, 3, 0, 0))).toBe(0);
    expect(tiltClass(3, 3, tiltOf(3, 3, PI, 0))).toBe(1);
  });

  it("uses the unrotated orientation in a circle container and one class for circles", () => {
    expect(tiltClass(4, 0, tiltOf(4, 0, 0, 0))).toBe(0);
    expect(tiltClass(4, 0, tiltOf(4, 0, PI / 4, 0))).toBe(1);
    expect(tiltClass(4, 0, tiltOf(4, 0, 0.2, 0))).toBe(2);
    expect(tiltClass(4, 0, tiltOf(4, 0, 0, 1.1))).toBe(0); // phi means nothing for a circle
    expect(tiltClass(0, 4, 0.7)).toBe(0);
    expect(
      tiltGroups(
        0,
        0,
        [
          { x: 0, y: 0, theta: 1 },
          { x: 2, y: 0, theta: 2 },
        ],
        0,
      ),
    ).toEqual([{ tilt: 0, cls: 0, count: 2 }]);
  });

  it("groups distinct tilts, merging across the wrap-around", () => {
    const at = (theta: number): Pose => ({ x: 0, y: 0, theta });
    const groups = tiltGroups(
      4,
      4,
      [at(PI / 4 + 1e-9), at(PI / 4 - 1e-9), at(-PI / 4), at(0), at(deg(10)), at(deg(10) + 1e-8), at(deg(100))],
      0,
    );
    expect(groups.map((g) => [g.cls, g.count])).toEqual([
      [0, 3],
      [2, 3],
      [1, 1],
    ]);
    expect(groups[0].tilt).toBe(0);
    expect(tiltDegrees(groups[1].tilt)).toBe("55°");
    expect(tiltDegrees(groups[2].tilt)).toBe("45°");
    expect(tiltGroups(4, 4, [], 0)).toEqual([]);
  });
});

describe("what the fill classes claim", () => {
  // Brute force from the corner coordinates: the direction a side faces is the direction of its
  // midpoint seen from the centre, for a piece and for a container alike.
  const directions = (v: Float64Array, cx = 0, cy = 0) => {
    const n = v.length / 2;
    const corners: number[] = [];
    const sides: number[] = [];
    for (let k = 0; k < n; k++) {
      const [x0, y0, x1, y1] = [v[2 * k], v[2 * k + 1], v[2 * ((k + 1) % n)], v[2 * ((k + 1) % n) + 1]];
      corners.push(Math.atan2(y0 - cy, x0 - cx));
      sides.push(Math.atan2((y0 + y1) / 2 - cy, (x0 + x1) / 2 - cx));
    }
    return { corners, sides };
  };
  // the same tolerance as the classing: 1e-6 rad
  const same = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) <= 1e-6;
  const any = (as: number[], bs: number[]) => as.some((a) => bs.some((b) => same(a, b)));
  const UP = [PI / 2];

  /** The claims of the legend, each as a test on the actual shapes. */
  const claims: Record<
    string,
    (piece: ReturnType<typeof directions>, box: ReturnType<typeof directions> | null) => boolean
  > = {
    "side-on: a side faces a container side squarely": (piece, box) => any(piece.sides, box!.sides),
    "corner-on: a corner points squarely at a container side": (piece, box) => any(piece.corners, box!.sides),
    "unrotated: a corner points straight up": (piece) => any(piece.corners, UP),
    "a side faces straight up": (piece) => any(piece.sides, UP),
  };
  const claimOf = (text: string) => claims[text] ?? claims[text.replace(/^turned half a step \([\d.]+°\): /, "")];

  for (const N of [3, 4, 5, 6, 7, 8, 9, 12]) {
    for (const M of [0, 3, 4, 5, 6, 7, 8, 9, 10, 12]) {
      it(`${N}-gons in ${M === 0 ? "a circle" : `a ${M}-gon`}`, () => {
        const legend = tiltLegend(N, M);
        expect(legend[0].cls).toBe(0);
        expect(legend[legend.length - 1]).toMatchObject({ cls: 2, text: "any other angle" });
        expect(legend.some((e) => e.cls === 1)).toBe(hasHalfStep(N, M));
        for (const e of legend) if (e.cls !== 2) expect(claimOf(e.text), e.text).toBeTypeOf("function");

        const phi = M === 0 ? 0 : 0.37;
        const box = M === 0 ? null : directions(containerVertices({ M, cx: 2, cy: -1, phi, size: 3 }), 2, -1);
        // a fine sweep, plus every orientation that puts a side or a corner squarely on a container side
        const thetas = Array.from({ length: 720 }, (_, k) => (k * PI) / 360);
        for (let j = 0; j < Math.max(M, 1); j++) {
          const facing = M === 0 ? PI / 2 : phi - PI / 2 + (2 * PI * j) / M;
          const side = facing - PI / 2 - PI / N;
          const corner = facing - PI / 2;
          // exactly, just inside the tolerance and just outside it
          for (const e of [0, 3e-7, -3e-7, 3e-6, -3e-6]) thetas.push(side + e, corner + e);
        }
        const seen = new Set<number>();
        for (const theta of thetas) {
          const piece = directions(pieceVertices(N, { x: 0.3, y: 0.4, theta }), 0.3, 0.4);
          const cls = tiltClass(N, M, tiltOf(N, M, theta, phi));
          seen.add(cls);
          const sideOn = claimOf(legend[0].text)(piece, box);
          // what the brute force says the class should be: class 0 wins when both descriptions hold
          const cornerOn =
            M === 0
              ? claims["a side faces straight up"](piece, box)
              : claims["corner-on: a corner points squarely at a container side"](piece, box);
          expect([theta, cls]).toEqual([theta, sideOn ? 0 : cornerOn ? 1 : 2]);
          // and the text printed for that class is true of this piece
          const entry = legend.find((e) => e.cls === cls);
          expect(entry, `class ${cls} occurs but has no legend entry`).toBeDefined();
          if (cls !== 2) expect(claimOf(entry!.text)(piece, box)).toBe(true);
          else for (const e of legend) if (e.cls !== 2) expect(claimOf(e.text)(piece, box)).toBe(false);
        }
        // every class the legend lists does occur, and no other
        expect([...seen].sort()).toEqual(legend.map((e) => e.cls));
      });
    }
  }

  it("does not call an upside-down piece side-on, although a side of it is parallel to a container side", () => {
    // an inverted triangle in a triangle: its top side is parallel to the bottom side but faces away from it
    expect(tiltClass(3, 3, tiltOf(3, 3, PI / 3, 0))).toBe(1);
    expect(tiltLegend(3, 3).map((e) => e.text)).toEqual([
      "side-on: a side faces a container side squarely",
      "corner-on: a corner points squarely at a container side",
      "any other angle",
    ]);
    expect(tiltLegend(3, 3).every((e) => !/parallel/.test(e.text))).toBe(true);
    // squares in an octagon: a square turned 45 degrees is side-on to the slanted sides, so there is no corner-on class
    expect(tiltLegend(4, 8).map((e) => e.cls)).toEqual([0, 2]);
    expect(tiltLegend(5, 4).map((e) => e.cls)).toEqual([0, 2]);
    // a circle container has no sides to face
    expect(tiltLegend(4, 0).map((e) => e.text)).toEqual([
      "unrotated: a corner points straight up",
      "turned half a step (45°): a side faces straight up",
      "any other angle",
    ]);
    expect(tiltLegend(0, 4)).toEqual([]);
  });

  it("names a tilt group by its class and never prints an angle that contradicts it", () => {
    const at = (theta: number): Pose => ({ x: 0, y: 0, theta });
    const names = (thetas: number[]) =>
      tiltGroups(4, 4, thetas.map(at), 0).map((g) => `${g.cls}: ${tiltName(4, 4, g)}`);
    // within the tolerance of side-on: class 0 and exactly 0 degrees, from either side
    expect(names([PI / 4 + 1e-10])).toEqual(["0: side-on (0°)"]);
    expect(names([PI / 4 - 1e-10])).toEqual(["0: side-on (0°)"]);
    expect(names([1e-10])).toEqual(["1: corner-on (45°)"]);
    // outside it: another angle, printed with enough digits to show that it is not 0 or 45 or 90
    expect(names([PI / 4 + 2e-6])).toEqual(["2: 0.0001°"]);
    expect(names([2e-6])).toEqual(["2: 45.0001°"]);
    expect(names([PI / 4 - 2e-6])).toEqual(["2: 89.9999°"]);
    expect(names([PI / 4 + deg(12.5)])).toEqual(["2: 12.5°"]);
    expect(tiltName(3, 0, { tilt: 0, cls: 0 })).toBe("unrotated (0°)");
    expect(tiltName(3, 0, { tilt: PI / 3, cls: 1 })).toBe("half a step (60°)");
    // pentagons in a square are side-on at 0, 18, 36 and 54 degrees
    expect(tiltGroups(5, 4, [at(-PI - PI / 5 + PI / 2 + 1e-9)], 0).map((g) => tiltName(5, 4, g))).toEqual([
      "side-on (18°)",
    ]);
  });
});

describe("the packing a tile draws", () => {
  const SITE = { kind: "site", id: 9, record: true, pending: false };
  const pending = (score: number, extra: Partial<LeaderboardEntry> = {}) =>
    site(score, { id: 31, name: "pat", verification: "pending", ...extra });

  it("prefers the verified site entry when it is at least as good as the published value", () => {
    expect(chooseDrawable({})).toEqual({ kind: "none" });
    expect(chooseDrawable({ lit: lit(3) })).toEqual({ kind: "none" });
    expect(chooseDrawable({ lit: lit(3, { has_coordinates: true }) })).toEqual({ kind: "literature" });
    expect(chooseDrawable({ site: site(7) })).toEqual(SITE);
    expect(
      chooseDrawable({ site: site(2.9, { verification: "confirmed" }), lit: lit(3, { has_coordinates: true }) }),
    ).toEqual(SITE);
    expect(chooseDrawable({ site: site(3.0000005), lit: lit(3, { has_coordinates: true }) })).toEqual(SITE);
    expect(
      chooseDrawable({ site: site(3.0000000000000004), lit: lit(3, { display_precision: 14, has_coordinates: true }) }),
    ).toEqual(SITE);
  });

  it("falls back to published coordinates, then to a site entry that is not the record", () => {
    expect(chooseDrawable({ site: site(3.1), lit: lit(3, { has_coordinates: true }) })).toEqual({ kind: "literature" });
    expect(chooseDrawable({ site: site(3.1), lit: lit(3) })).toEqual({ ...SITE, record: false });
    expect(drawableKey(chooseDrawable({ site: site(3.1), lit: lit(3) }))).toBe("site:9");
    expect(drawableKey(chooseDrawable({ site: site(3.1, { id: 12 }), lit: lit(3) }))).toBe("site:12");
    expect(drawableKey({ kind: "literature" })).toBe("literature");
    expect(drawableKey({ kind: "none" })).toBe("none");
    // the identity of an answer of /api/atlas is spelled the same way
    expect(tileKey({ source: "site", id: 12 })).toBe("site:12");
    expect(tileKey({ source: "literature" })).toBe("literature");
    expect(tileKey(null)).toBe("none");
  });

  it("draws a pending entry only when it is the only thing that can be drawn", () => {
    const claim = pending(2.5);
    // published coordinates, or any verified entry, come first
    expect(chooseDrawable({ site: claim, lit: lit(3, { has_coordinates: true }) })).toEqual({ kind: "literature" });
    expect(chooseDrawable({ site: claim, verified: site(3.4), lit: lit(3) })).toEqual({ ...SITE, record: false });
    expect(chooseDrawable({ site: claim, verified: site(3), lit: lit(3) })).toEqual(SITE);
    // nothing else: the claim is drawn, marked as pending and as not the record
    expect(chooseDrawable({ site: claim, lit: lit(3) })).toEqual({
      kind: "site",
      id: 31,
      record: false,
      pending: true,
    });
    expect(drawableKey(chooseDrawable({ site: claim, lit: lit(3) }))).toBe("site:31");
  });

  it("never presents a pending entry as the smallest known value", () => {
    const claim = pending(2.5);
    // against a proven value, against a best known one, and beside a verified entry
    for (const status of ["proven", "best_known"] as const) {
      expect(tileStatus({ site: claim, lit: lit(3, { status }) })).toEqual({
        best: 3,
        published: status,
        site: "none",
        pending: true,
      });
      expect(layoutSize({ site: claim, lit: lit(3, { status }) })).toBe(3);
    }
    expect(tileStatus({ site: claim, verified: site(3.4), lit: lit(3) })).toEqual({
      best: 3,
      published: "best_known",
      site: "behind",
      pending: true,
    });
    expect(tileStatus({ site: claim, verified: site(3), lit: lit(3) })).toMatchObject({
      best: 3,
      site: "matches",
      pending: true,
    });
    // a confirmed claim is verified and does count; a newer claim below it still does not
    expect(tileStatus({ site: site(2.5, { verification: "confirmed" }), lit: lit(3) })).toEqual({
      best: 2.5,
      published: "best_known",
      site: "beats",
      pending: false,
    });
    const newer = { site: pending(2.2), verified: site(2.5, { verification: "confirmed" }), lit: lit(3) };
    expect(tileStatus(newer)).toEqual({ best: 2.5, published: "best_known", site: "beats", pending: true });
    expect(layoutSize(newer)).toBe(2.5);
    expect(sizeRow(layoutSize({ site: pending(1.9), lit: lit(3) }))).toBe(3);
    // with no other number at all there is no known value; the claim only places the tile
    expect(tileStatus({ site: claim })).toEqual({ best: null, published: null, site: "none", pending: true });
    expect(layoutSize({ site: claim })).toBe(2.5);

    const row = (r: Partial<AtlasRow>): AtlasRow => ({ P: 5, bound: 2.2, ...r });
    expect(tileLabel(row({ site: claim, lit: lit(3, { status: "proven" }) }), 4)).toBe(
      "P = 5, side 3.000000, proven, an entry at 2.500000 is pending verification, drawing: the pending entry by pat",
    );
    expect(tileLabel(row({ site: claim, lit: lit(3, { has_coordinates: true }) }), 4)).toBe(
      "P = 5, side 3.000000, best known, an entry at 2.500000 is pending verification, drawn from published coordinates",
    );
    expect(tileLabel(row({ site: claim, verified: site(3.4), lit: lit(3) }), 0)).toBe(
      "P = 5, radius 3.000000, best known, an entry at 2.500000 is pending verification, drawing: entry by ann at 3.400000",
    );
    expect(tileLabel(row({ site: claim }), 4)).toBe(
      "P = 5, no verified value, an entry at 2.500000 is pending verification, drawing: the pending entry by pat",
    );
  });

  it("summarises the status without colour", () => {
    expect(tileStatus({})).toBeNull();
    expect(tileStatus({ lit: lit(3, { status: "proven" }) })).toEqual({
      best: 3,
      published: "proven",
      site: "none",
      pending: false,
    });
    expect(tileStatus({ site: site(7) })).toEqual({ best: 7, published: null, site: "only", pending: false });
    expect(tileStatus({ site: site(3.4), lit: lit(3) })).toMatchObject({ best: 3, site: "behind" });
    expect(tileStatus({ site: site(3.0000005), lit: lit(3) })).toMatchObject({ best: 3, site: "matches" });

    const row = (r: Partial<AtlasRow>): AtlasRow => ({ P: 5, bound: 2.2, ...r });
    expect(tileLabel(row({ lit: lit(2.707107, { status: "proven" }) }), 4)).toBe(
      "P = 5, side 2.707107, proven, no coordinates",
    );
    expect(tileLabel(row({ lit: lit(3, { status: "trivial_tiling", has_coordinates: true }) }), 0)).toBe(
      "P = 5, radius 3.000000, optimal tiling, drawn from published coordinates",
    );
    expect(tileLabel(row({ site: site(2.5, { verification: "confirmed" }), lit: lit(3) }), 4)).toBe(
      "P = 5, side 2.500000, best known, site entry beats the published value, drawn from the entry by ann",
    );
    expect(tileLabel(row({ site: site(3.4), lit: lit(3) }), 4)).toBe(
      "P = 5, side 3.000000, best known, drawing: entry by ann at 3.400000",
    );
  });

  it("follows only http(s) addresses and paths of this site", () => {
    expect(safeHref("https://erich-friedman.github.io/packing/cirincir/")).toBe(
      "https://erich-friedman.github.io/packing/cirincir/",
    );
    expect(safeHref("http://www.packomania.com/cci/")).toBe("http://www.packomania.com/cci/");
    expect(safeHref("/api")).toBe("/api");
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "data:text/html,x",
      "//evil.example/x",
      "/\\evil.example",
      "ftp://x/y",
      "https://",
      "evil.example",
      "",
      undefined,
    ]) {
      expect([bad, safeHref(bad)]).toEqual([bad, null]);
    }
  });

  it("rows hold the P whose best size shares a ceiling", () => {
    expect([1, 2, 2.0000000001, 2.7071, 3, 3.000001, 0.4].map(sizeRow)).toEqual([1, 2, 2, 3, 3, 4, 1]);
    // squares in a square: the row is the side of the trivial grid
    for (const [P, s] of [
      [1, 1],
      [2, 2],
      [4, 2],
      [5, 2.7071],
      [9, 3],
      [10, 3.7071],
      [11, 3.8771],
    ]) {
      expect(sizeRow(s)).toBe(Math.ceil(Math.sqrt(P)));
    }
  });
});

describe("drawing geometry", () => {
  // seven circles: one in the middle and six around it, radius 3 (proved by Graham, 1968)
  const seven: Pose[] = [{ x: 0, y: 0, theta: 0 }];
  for (let k = 0; k < 6; k++) seven.push({ x: 2 * Math.cos((k * PI) / 3), y: 2 * Math.sin((k * PI) / 3), theta: 0 });

  // five squares in a square of side 2 + 1/sqrt 2: four in the corners, one turned 45 degrees in the middle
  const s5 = 2 + Math.SQRT1_2;
  const h = s5 / 2 - 0.5;
  const five: Pose[] = [
    { x: -h, y: -h, theta: PI / 4 },
    { x: h, y: -h, theta: PI / 4 },
    { x: -h, y: h, theta: PI / 4 },
    { x: h, y: h, theta: PI / 4 },
    { x: 0, y: 0, theta: 0 },
  ];
  const turned = (pieces: Pose[], a: number, ox = 0, oy = 0): Pose[] =>
    pieces.map((p) => ({
      x: ox + p.x * Math.cos(a) - p.y * Math.sin(a),
      y: oy + p.x * Math.sin(a) + p.y * Math.cos(a),
      theta: p.theta + a,
    }));

  it("draws 0/0/7 as seven unit circles in a circle of radius 3", () => {
    const d = drawPacking(0, 0, seven, 0)!;
    expect(d.size).toBeCloseTo(3, 9);
    expect(d.circle).toBeCloseTo(3, 9);
    expect(d.points).toBeUndefined();
    expect(d.box.map((v) => +v.toFixed(6))).toEqual([-3, -3, 6, 6]);
    expect(d.paths).toHaveLength(1);
    expect(d.paths[0]).toMatchObject({ cls: 0, count: 7 });
    expect(d.paths[0].d.match(/M/g)).toHaveLength(7);
    // the middle circle starts at its leftmost point and is drawn as two half turns of radius 1
    expect(d.paths[0].d.startsWith("M-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0")).toBe(true);
    // y is flipped: the circle at 60 degrees (up and to the right) is drawn above the middle
    expect(d.paths[0].d).toContain("M0 -1.7321a");
    expect(d.tilts).toEqual([{ tilt: 0, cls: 0, count: 7 }]);
    // an off-centre copy gives the same picture
    expect(
      drawPacking(
        0,
        0,
        seven.map((p) => ({ ...p, x: p.x + 40, y: p.y - 7 })),
        2,
      )!.paths,
    ).toEqual(d.paths);
  });

  it("draws 4/4/5 with four aligned squares and one at 45 degrees", () => {
    expect(findOverlaps(4, five)).toHaveLength(0);
    const d = drawPacking(4, 4, five, 0)!;
    expect(d.size).toBeCloseTo(s5, 9);
    expect(d.circle).toBeUndefined();
    const half = +(s5 / 2).toFixed(4);
    expect(d.points).toBe(`${half},${half} ${half},${-half} ${-half},${-half} ${-half},${half}`);
    [-s5 / 2, -s5 / 2, s5, s5].forEach((v, i) => expect(d.box[i]).toBeCloseTo(v, 9));
    expect(d.paths.map((p) => [p.cls, p.count])).toEqual([
      [0, 4],
      [1, 1],
    ]);
    // the middle square stands on a vertex: its corners are on the axes at distance 1/sqrt 2
    expect(d.paths[1].d).toBe("M0 -0.7071L-0.7071 0L0 0.7071L0.7071 0Z");
    // the bottom-left square fills the bottom-left corner (y down, so the largest y)
    expect(d.paths[0].d).toContain(`L${-half} ${half}`);
    expect(d.tilts.map((t) => [tiltDegrees(t.tilt), t.cls, t.count])).toEqual([
      ["0°", 0, 4],
      ["45°", 1, 1],
    ]);
  });

  it("draws in the container's frame whatever the container orientation", () => {
    const d = drawPacking(4, 4, five, 0)!;
    const moved = turned(five, 0.3, 5, -2);
    expect(enclose(4, moved, 4, 0.3).size).toBeCloseTo(s5, 9);
    const e = drawPacking(4, 4, moved, 0.3)!;
    expect(e.points).toBe(d.points);
    expect(e.paths.map((p) => [p.cls, p.count])).toEqual([
      [0, 4],
      [1, 1],
    ]);
    const numbers = (path: string) => path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    for (const i of [0, 1]) {
      const a = numbers(d.paths[i].d),
        b = numbers(e.paths[i].d);
      expect(b).toHaveLength(a.length);
      // a quarter turn of the picture is still the same packing; compare the sorted coordinates
      a.sort((x, y) => x - y);
      b.sort((x, y) => x - y);
      for (let k = 0; k < a.length; k++) expect(Math.abs(a[k] - b[k])).toBeLessThan(2e-4);
    }
    // a container that is not aligned with the pieces is larger and every square is then tilted
    const loose = drawPacking(4, 4, five, 0.2)!;
    expect(loose.size).toBeGreaterThan(s5 + 0.1);
    expect(loose.paths.map((p) => p.cls)).toEqual([2]);
  });

  it("frames each container shape by its bounding box", () => {
    expect(drawPacking(4, 4, [], 0)).toBeNull();
    expect(containerOutline(0, 2)).toEqual({ box: [-2, -2, 4, 4], circle: 2 });
    const tri = containerOutline(3, 2);
    // a triangle of side 2 with a horizontal bottom side: width 2, height sqrt 3
    expect(tri.box[2]).toBeCloseTo(2, 9);
    expect(tri.box[3]).toBeCloseTo(Math.sqrt(3), 9);
    expect(tri.points!.split(" ")).toHaveLength(3);
    const ys = tri.points!.split(" ").map((p) => Number(p.split(",")[1]));
    expect(ys.filter((y) => y > 0)).toHaveLength(2); // two corners at the bottom (y down)
    // an upright unit triangle in a triangle container is aligned and fills it
    const one = drawPacking(3, 3, [{ x: 0, y: 0, theta: 0 }], 0)!;
    expect(one.size).toBeCloseTo(1, 9);
    expect(one.paths.map((p) => p.cls)).toEqual([0]);
  });
});

describe("display state in the URL", () => {
  it("parses known values and falls back to the defaults", () => {
    expect(parseView("")).toEqual(DEFAULT_VIEW);
    expect(parseView("?size=large")).toEqual({ ...DEFAULT_VIEW, size: "large" });
    expect(parseView("?size=small&scale=global&layout=rows&show=all&p=11")).toEqual({
      size: "small",
      scale: "global",
      layout: "rows",
      all: true,
      p: 11,
    });
    expect(parseView("?size=huge&scale=1&layout=&show=some&p=0")).toEqual(DEFAULT_VIEW);
    for (const p of ["-3", "1.5", "abc", "1000", "07", ""]) expect(parseView(`?p=${p}`).p).toBeNull();
    expect(parseView("?p=500").p).toBe(500);
  });

  it("keeps the row scale for the rows layout only", () => {
    expect(parseView("?scale=row").scale).toBe("fixed");
    expect(parseView("?scale=row&layout=rows").scale).toBe("row");
    expect(normalizeView({ ...DEFAULT_VIEW, scale: "row", layout: "grid" }).scale).toBe("fixed");
    expect(normalizeView({ ...DEFAULT_VIEW, scale: "global", layout: "grid" }).scale).toBe("global");
  });

  it("writes only what differs from the default and round-trips", () => {
    expect(viewQuery(DEFAULT_VIEW)).toBe("");
    expect(viewQuery({ ...DEFAULT_VIEW, size: "large" })).toBe("?size=large");
    expect(viewQuery({ ...DEFAULT_VIEW, scale: "row" })).toBe("");
    for (const q of ["?size=small&scale=global&layout=rows&show=all&p=11", "?scale=row&layout=rows", "?p=7"]) {
      expect(viewQuery(parseView(q))).toBe(q);
    }
    // unrelated parameters survive, stale atlas ones are dropped
    expect(viewQuery(DEFAULT_VIEW, "?debug=1&size=large&p=4")).toBe("?debug=1");
    expect(viewQuery({ ...DEFAULT_VIEW, p: 3 }, "?debug=1")).toBe("?debug=1&p=3");
  });
});
