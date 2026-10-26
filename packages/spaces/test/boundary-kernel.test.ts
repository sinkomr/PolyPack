/**
 * The boundary kernel's validate() (packages/boundary/src/kernel-validate.ts) rebuilds the server's
 * rule, because the boundary package does not depend on this one. Here the two are compared: on
 * every research record, on records pushed across the lower bound and the tolerance, on malformed
 * and out-of-range input, and on configurations the kernel finished, they must give the same
 * verdict, score and reasons.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { boundaryKernel } from "@polypack/boundary";
import { mulberry32, squeeze } from "@polypack/methods";
import { describe, expect, it } from "vitest";
import { validateSpaceSubmission } from "../src/validate";

interface Piece {
  cell: number;
  u: number[];
  q?: number[];
}
interface Rec {
  id: string;
  piece: "ball" | "cube";
  P: number;
  bound: { value: number };
  config: { s: number; pieces: Piece[] };
}

const records: Rec[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../data/boundary/records.json", import.meta.url)), "utf8"),
).records;

const turned = (deg: number) => [Math.cos((deg * Math.PI) / 360), 0, 0, Math.sin((deg * Math.PI) / 360)];

/** The record and its variants, each to be judged the same way by both. */
function variants(r: Rec): [string, unknown][] {
  const base = r.config;
  const withS = (s: unknown) => ({ s, pieces: base.pieces });
  const first = (f: (p: Piece) => unknown) => ({ s: base.s, pieces: base.pieces.map((p, i) => (i === 0 ? f(p) : p)) });
  const all = (f: (p: Piece) => unknown) => ({ s: base.s, pieces: base.pieces.map(f) });
  const holed: unknown[] = base.pieces.slice();
  delete holed[0];
  return [
    ["record", base],
    ["s (1 - 5e-10)", withS(base.s * (1 - 5e-10))],
    ["s (1 - 3e-9)", withS(base.s * (1 - 3e-9))],
    ["s (1 - 1e-6)", withS(base.s * (1 - 1e-6))],
    ["bound (1 - 0.9e-9)", withS(r.bound.value * (1 - 0.9e-9))],
    ["bound (1 - 1.1e-9)", withS(r.bound.value * (1 - 1.1e-9))],
    ["s 2e4", withS(2e4)],
    ["s negative", withS(-1)],
    ["s a string", withS("2")],
    ["s missing", { pieces: base.pieces }],
    ["u0 + 1e-9", first((p) => ({ ...p, u: [p.u[0] + 1e-9, p.u[1], p.u[2]] }))],
    ["u0 + 1e-3", first((p) => ({ ...p, u: [p.u[0] + 1e-3, p.u[1], p.u[2]] }))],
    ["u0 + 50", first((p) => ({ ...p, u: [p.u[0] + 50, p.u[1], p.u[2]] }))],
    ["u0 1e17", first((p) => ({ ...p, u: [1e17, p.u[1], p.u[2]] }))],
    ["u0 short", first((p) => ({ ...p, u: p.u.slice(0, 2) }))],
    ["q 90 degrees", all((p) => ({ ...p, q: turned(90) }))],
    ["q 30 degrees", all((p) => ({ ...p, q: turned(30) }))],
    ["q not unit", all((p) => ({ ...p, q: [1 + 2e-9, 0, 0, 0] }))],
    ["q short", first((p) => ({ ...p, q: [1, 0, 0] }))],
    ["cell 8", first((p) => ({ ...p, cell: 8 }))],
    ["cell 1.5", first((p) => ({ ...p, cell: 1.5 }))],
    ["a piece not an object", first(() => 3)],
    ["a hole in the list", { s: base.s, pieces: holed }],
    ["one piece fewer", { s: base.s, pieces: base.pieces.slice(1) }],
    ["unknown fields", { ...base, junk: 1, pieces: base.pieces.map((p) => ({ ...p, z: 3 })) }],
    ["not an object", [base]],
  ];
}

describe("the boundary kernel's validate is the server's rule", () => {
  it("on every record and its variants, and on configurations the kernel finished", () => {
    let compared = 0;
    for (const r of records) {
      const k = boundaryKernel({ polytope: "tesseract", piece: r.piece, P: r.P });
      const same = (label: string, config: unknown) => {
        const server = validateSpaceSubmission("boundary", r.id, config, { bound: r.bound.value });
        const mine = k.validate(config);
        expect({ label, ...mine }).toEqual({
          label,
          valid: server.valid,
          score: server.score,
          reasons: server.reasons,
        });
        compared++;
      };
      for (const [label, config] of variants(r)) same(label, config);
      const rng = mulberry32(r.P);
      const s = k.randomStart(rng);
      squeeze(k, s, { maxIter: 60 });
      for (const q of [s, ...k.seeds!(rng, 2)]) {
        const f = k.finish(q);
        if (!f) continue;
        same("finished", f.config);
        same("finished, shrunk by 2e-9", { ...(f.config as object), s: f.score * (1 - 2e-9) });
      }
    }
    expect(compared).toBeGreaterThan(32 * 26);
  });
});
