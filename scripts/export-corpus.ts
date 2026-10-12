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
      x: 2 * Math.cos((k * Math.PI) / 3),
      y: 2 * Math.sin((k * Math.PI) / 3),
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
    { x: (N === 0 ? 2 : 1) + gap, y: 0, theta: N === 0 ? 0 : Math.PI / 4 },
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

function exportDirectory(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) exportDirectory(path);
    else if (entry.name.endsWith(".json")) {
      const saved = JSON.parse(readFileSync(path, "utf8"));
      const result = evaluate(saved.config, { autoOrient: true });
      if (
        saved.expected_score !== undefined &&
        saved.expected_score !== null &&
        Math.abs(saved.expected_score - (result.score ?? 0)) > 1e-9
      ) {
        throw new Error(`stored score changed: ${path}`);
      }
      saved.expected_score ??= result.score;
      saved.expected_valid = result.valid;
      // Retained only as a TypeScript regression witness; Python computes its own orientation.
      saved.auto_oriented_phi = result.container?.phi ?? 0;
      writeFileSync(path, JSON.stringify(saved, null, dir === directory ? 1 : 2) + "\n");
    }
  }
}
exportDirectory(directory);
