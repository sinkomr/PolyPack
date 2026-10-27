import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { evaluate, type PackingConfig } from "@polypack/geometry";

const directory = resolve("data/corpus");
const squareDistance = (1 + Math.SQRT1_2) / 2;
const fiveSquares: PackingConfig = {
  N: 4,
  M: 4,
  P: 5,
  container_phi: 0,
  pieces: [
    { x: 0, y: 0, theta: 0 },
    ...[
      [-squareDistance, -squareDistance],
      [squareDistance, -squareDistance],
      [-squareDistance, squareDistance],
      [squareDistance, squareDistance],
    ].map(([x, y]) => ({ x, y, theta: Math.PI / 4 })),
  ],
};
const sevenCircles: PackingConfig = {
  N: 0,
  M: 0,
  P: 7,
  container_phi: 0,
  pieces: [
    { x: 0, y: 0, theta: 0 },
    ...Array.from({ length: 6 }, (_, k) => ({
      // disks have diameter 1 (since 2026-10-27), so neighbours touch at distance 1
      x: Math.cos((k * Math.PI) / 3),
      y: Math.sin((k * Math.PI) / 3),
      theta: 0,
    })),
  ],
};
const triangles: PackingConfig = {
  N: 3,
  M: 3,
  P: 3,
  container_phi: 0,
  pieces: [
    [0, Math.sqrt(3) / 3],
    [-0.5, -Math.sqrt(3) / 6],
    [0.5, -Math.sqrt(3) / 6],
  ].map(([x, y]) => ({ x, y, theta: 0 })),
};
const pair = (N: number, gap: number): PackingConfig => ({
  N,
  M: N === 0 ? 0 : 4,
  P: 2,
  container_phi: 0,
  pieces: [
    { x: 0, y: 0, theta: N === 0 ? 0 : Math.PI / 4 },
    { x: 1 + gap, y: 0, theta: N === 0 ? 0 : Math.PI / 4 },
  ],
});

// All generated fixtures are nested: Phase 1's server test requires every top-level file valid.
const generated = resolve(directory, "generated");
mkdirSync(generated, { recursive: true });
for (const [name, config] of [
  ["tight-five-squares", fiveSquares],
  ["tight-seven-circles", sevenCircles],
  ["tight-three-triangles", triangles],
  ["circle-contact", pair(0, 0)],
  ["circle-tolerance-valid", pair(0, -0.9e-9)],
  ["circle-tolerance-invalid", pair(0, -1.1e-9)],
  ["square-contact", pair(4, 0)],
  ["square-tolerance-valid", pair(4, -0.9e-9)],
  ["square-tolerance-invalid", pair(4, -1.1e-9)],
] as const) {
  writeFileSync(resolve(generated, `${name}.json`), JSON.stringify({ config }, null, 2) + "\n");
}
const invalid = resolve(directory, "invalid");
mkdirSync(invalid, { recursive: true });
for (const [name, config] of [
  ["overlap", pair(0, -0.5)],
  ["wrong-count", { ...pair(0, 0), P: 3 }],
  ["empty", { ...pair(0, 0), P: 3, pieces: [] }],
] as const)
  writeFileSync(resolve(invalid, `${name}.json`), JSON.stringify({ config }, null, 2) + "\n");

// Each file records two scores: `expected_score` at the configuration's own container_phi, which is
// how the server scores a submission (since 2026-10-21), and `oriented_score` after an orientation
// search, which is what a client gets by turning the container before submitting.
function exportDirectory(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) exportDirectory(path);
    else if (entry.name.endsWith(".json")) {
      const saved = JSON.parse(readFileSync(path, "utf8"));
      const sent = evaluate(saved.config);
      const oriented = evaluate(saved.config, { autoOrient: true });
      for (const [key, result] of [
        ["expected_score", sent],
        ["oriented_score", oriented],
      ] as const) {
        const stored = saved[key];
        if (stored !== undefined && stored !== null && Math.abs(stored - (result.score ?? 0)) > 1e-9)
          throw new Error(`stored ${key} changed: ${path}`);
      }
      const out = {
        config: saved.config,
        // the fixtures are in site units: disks of diameter 1, circle containers scored by their diameter
        units: "diameter",
        expected_score: saved.expected_score ?? sent.score,
        expected_valid: sent.valid,
        oriented_score: saved.oriented_score ?? oriented.score,
        // Retained only as a TypeScript regression witness; Python computes its own orientation.
        auto_oriented_phi: oriented.container?.phi ?? 0,
      };
      writeFileSync(path, JSON.stringify(out, null, dir === directory ? 1 : 2) + "\n");
    }
  }
}
exportDirectory(directory);
