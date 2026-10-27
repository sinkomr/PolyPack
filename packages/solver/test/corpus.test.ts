import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { evaluate } from "@polypack/geometry";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith(".json") ? [path] : [];
  });
}

// UNITS-DATA: reads data/corpus/**, which Part 10 converts to diameter units. Until then every circle-piece
// or circle-container file fails here; polygon-only files pass.
describe("cross-language corpus reference", () => {
  for (const file of files(resolve(import.meta.dirname, "../../../data/corpus"))) {
    it(file.split("data/corpus/")[1], () => {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      // the server's rule: the container at the configuration's own container_phi
      const sent = evaluate(saved.config);
      expect(sent.valid).toBe(saved.expected_valid);
      if (sent.score === null) expect(saved.expected_score).toBeNull();
      else expect(sent.score).toBeCloseTo(saved.expected_score, 9);
      // after an orientation search, as a client does before submitting
      const result = evaluate(saved.config, { autoOrient: true });
      expect(result.valid).toBe(saved.expected_valid);
      expect(result.container?.phi ?? 0).toBe(saved.auto_oriented_phi);
      if (result.score === null) expect(saved.oriented_score).toBeNull();
      else expect(result.score).toBeCloseTo(saved.oriented_score, 9);
      const fixed = evaluate({ ...saved.config, container_phi: saved.auto_oriented_phi });
      expect(fixed.valid).toBe(result.valid);
      if (fixed.score !== null) expect(fixed.score).toBeCloseTo(result.score!, 9);
    });
  }
});
