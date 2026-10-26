/** A small domain for the tests: disks on the square torus, P = 2 and 3 (not a space's real domain). */
import type { SpaceDomain } from "../src";

export const TORUS_TEST_DOMAIN: SpaceDomain = {
  info: {
    id: "torus/<family>/<N>/<P>",
    fields: [
      { key: "family", label: "Torus", values: ["sq"] },
      { key: "N", label: "Piece (N)", values: ["0"] },
      { key: "P", label: "Pieces (P)", min: 2, max: 3 },
    ],
    problems: 2,
  },
  bound: (id) =>
    id.fields.family === "sq" && id.fields.N === 0 && id.P >= 2 && id.P <= 3
      ? { value: Math.sqrt(Math.PI * id.P), label: "area bound; a test bound" }
      : undefined,
  sample: (limit) => ["torus/sq/0/2", "torus/sq/0/3"].slice(0, Math.max(0, limit)),
};
