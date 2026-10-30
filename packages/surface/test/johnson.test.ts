/** Johnson surfaces: the test packings, and refusals at 1e-9 across fold edges, over vertices and across walls. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apply, faceVertex, getSolid, glue, inverse, validate, type SolidName } from "../src/index";

const packings = JSON.parse(readFileSync(new URL("../../../python/surface/fixtures/johnson_packings.json", import.meta.url), "utf8"))
  .packings as { id: string; solid: SolidName; mode: "fold" | "nofold"; N: number; s: number; pieces: { face: number; x: number; y: number; theta: number }[]; how: string }[];

describe("Johnson test packings", () => {
  it("are valid in their mode, and the constructed folding ones need folding", () => {
    expect(packings.length).toBeGreaterThanOrEqual(130);
    expect(new Set(packings.map((p) => p.solid)).size).toBe(11);
    for (const r of packings) {
      const cfg = { solid: r.solid, N: r.N, s: r.s, pieces: r.pieces };
      expect(validate(cfg, r.mode).ok, r.id).toBe(true);
      if (r.mode === "nofold") expect(validate(cfg, "fold").ok, r.id).toBe(true);
      else if (r.how === "constructed") expect(validate(cfg, "nofold").ok, r.id).toBe(false);
    }
  });
});

const NAMES: SolidName[] = ["square_pyramid", "triangular_cupola", "snub_disphenoid", "triangular_bipyramid", "gyroelongated_triangular_bicupola", "triangular_hebesphenorotunda"];

describe("Johnson refusals", () => {
  for (const name of NAMES) {
    const S = getSolid(name);
    const s = 8;
    const f = 0;
    const k = 0;
    const a = faceVertex(S, s, f, k);
    const b = faceVertex(S, s, f, k + 1);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nx = -(b[1] - a[1]) / L;
    const ny = (b[0] - a[0]) / L;
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    it(`${name}: a disk overlapping its neighbour across a fold edge by 1e-9 is refused`, () => {
      const g = glue(S, s, f, k);
      for (const [d, want] of [[0.5 - 0.5e-9, false], [0.5 + 0.5e-9, true]] as const) {
        const q = apply(inverse(g.T), m[0] - d * nx, m[1] - d * ny);
        const cfg = { solid: name, N: 0, s, pieces: [{ face: f, x: m[0] + d * nx, y: m[1] + d * ny, theta: 0 }, { face: g.face, x: q[0], y: q[1], theta: 0 }] };
        expect(validate(cfg, "fold", { tol: 0 }).ok).toBe(want);
      }
    });
    it(`${name}: a square crossing an edge is refused without folding, and a disk over a vertex is refused`, () => {
      const th = Math.atan2(-ny, -nx) - Math.PI / 2 - Math.PI / 4;
      for (const [d, want] of [[0.5 - 1e-9, false], [0.5 + 1e-9, true]] as const) {
        const cfg = { solid: name, N: 4, s, pieces: [{ face: f, x: m[0] + d * nx, y: m[1] + d * ny, theta: th }] };
        expect(validate(cfg, "nofold", { tol: 0 }).ok).toBe(want);
        expect(validate(cfg, "fold", { tol: 0 }).ok).toBe(true);
      }
      for (let v = 0; v < S.V; v++) {
        const fv = S.faces.findIndex((x) => x.includes(v));
        const [vx, vy] = faceVertex(S, s, fv, S.faces[fv].indexOf(v));
        const r = Math.hypot(vx, vy);
        for (const [d, want] of [[0.5 - 0.5e-9, false], [0.5 + 0.5e-9, true]] as const) {
          const cfg = { solid: name, N: 0, s, pieces: [{ face: fv, x: vx * (1 - d / r), y: vy * (1 - d / r), theta: 0 }] };
          expect(validate(cfg, "fold", { tol: 0 }).ok, `${name} vertex ${v}`).toBe(want);
        }
      }
    });
  }
});
