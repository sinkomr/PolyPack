import { MAX_COORD, Pose } from "@polypack/geometry";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PIECE_BYTES, blobFromJson, decodePieces, encodePieces, readPieces } from "../src/pieces";
import { SqliteStore } from "../src/sqlite-store";
import { NewSubmission } from "../src/store";

/** Equal bit for bit: Object.is tells -0 from 0, which toEqual does not always. */
function expectSame(a: readonly Pose[], b: readonly Pose[]) {
  expect(b).toHaveLength(a.length);
  a.forEach((p, i) => {
    for (const k of ["x", "y", "theta"] as const) expect([i, k, Object.is(p[k], b[i][k])]).toEqual([i, k, true]);
  });
}

const awkward: Pose[] = [
  { x: -0, y: 0, theta: -0 },
  { x: MAX_COORD, y: -MAX_COORD, theta: Math.PI },
  { x: Number.MIN_VALUE, y: -Number.MIN_VALUE, theta: 2 ** -1074 },
  { x: 0.1 + 0.2, y: 1 / 3, theta: -Math.PI / 4 },
  { x: Number.MAX_VALUE, y: -Number.MAX_VALUE, theta: 1e308 },
  { x: 999999.9999999999, y: -2.2250738585072014e-308, theta: 123456.789 },
];

describe("binary pieces", () => {
  it("round-trips every double exactly, -0 included, in 24 bytes per piece", () => {
    const bytes = encodePieces(awkward);
    expect(bytes.length).toBe(awkward.length * PIECE_BYTES);
    expectSame(awkward, decodePieces(bytes));
    // -0 is exactly what JSON loses
    expect(Object.is(JSON.parse(JSON.stringify(awkward))[0].x, -0)).toBe(false);
    expect(decodePieces(encodePieces([]))).toEqual([]);
  });

  it("round-trips arbitrary finite doubles within the coordinate limit and beyond", () => {
    const coord = fc.oneof(
      fc.double({ min: -MAX_COORD, max: MAX_COORD, noNaN: true }),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.constantFrom(-0, 0, MAX_COORD, -MAX_COORD),
    );
    const pose = fc.record({ x: coord, y: coord, theta: coord });
    fc.assert(
      fc.property(fc.array(pose, { maxLength: 50 }), (pieces) => {
        const back = decodePieces(encodePieces(pieces));
        return (
          back.length === pieces.length &&
          pieces.every((p, i) => (["x", "y", "theta"] as const).every((k) => Object.is(p[k], back[i][k])))
        );
      }),
      { numRuns: 500 },
    );
  });

  it("is little-endian whatever the machine", () => {
    // 1.0 is 0x3FF0000000000000; little-endian puts the 0xF0 0x3F last
    expect([...encodePieces([{ x: 1, y: 0, theta: 0 }]).subarray(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0xf0, 0x3f]);
  });

  it("reads a buffer at any offset, as a driver may hand it over", () => {
    const bytes = encodePieces(awkward);
    const shifted = new Uint8Array(bytes.length + 3);
    shifted.set(bytes, 3);
    expectSame(awkward, decodePieces(shifted.subarray(3)));
    expect(() => decodePieces(new Uint8Array(25))).toThrow(RangeError);
  });

  it("reads both stored forms", () => {
    expectSame(awkward, readPieces(encodePieces(awkward)));
    const text = JSON.stringify([{ x: 1.5, y: -2, theta: 0.25 }]);
    expect(readPieces(text)).toEqual([{ x: 1.5, y: -2, theta: 0.25 }]);
    expect(() => readPieces(3)).toThrow(TypeError);
  });

  it("converts the older JSON text only when it is exactly a list of poses", () => {
    const poses = awkward.filter((p) => Math.abs(p.x) <= MAX_COORD);
    const blob = blobFromJson(JSON.stringify(poses))!;
    // JSON wrote -0 as 0, so what comes back is what the text held
    expect(decodePieces(blob)).toEqual(JSON.parse(JSON.stringify(poses)));
    expect(decodePieces(blobFromJson("[]")!)).toEqual([]);
    for (const bad of [
      "",
      "{",
      "{}",
      "[1, 2]",
      "[null]",
      "[[1, 2, 3]]",
      '[{"x": 1, "y": 2}]',
      '[{"x": 1, "y": 2, "theta": "3"}]',
      '[{"x": 1, "y": 2, "theta": 3, "extra": 4}]',
      '[{"x": 1e999, "y": 2, "theta": 3}]',
    ])
      expect([bad, blobFromJson(bad)]).toEqual([bad, null]);
  });
});

describe("the store keeps pieces exactly", () => {
  const entry = (pieces: Pose[]): NewSubmission => ({
    N: 4,
    M: 4,
    P: pieces.length,
    score: 1,
    name: "exact",
    agent_note: "",
    found_with: "hand",
    method: null,
    method_params: null,
    seed: null,
    budget: null,
    software: null,
    pieces,
    container_phi: 0,
    created_at: "2026-10-18T00:00:00Z",
    verification: "none",
    literature_value: null,
    strict_check: null,
  });

  it("returns what was stored, -0 and the coordinate limit included", async () => {
    const store = new SqliteStore(":memory:");
    const id = await store.insert(entry(awkward));
    expectSame(awkward, (await store.get(id))!.pieces);
    expectSame(awkward, (await store.getMany([id]))[0].pieces);
    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    expect(db.prepare("SELECT typeof(pieces) AS t, length(pieces) AS n FROM submissions WHERE id = ?").get(id)).toEqual(
      { t: "blob", n: awkward.length * PIECE_BYTES },
    );
  });
});
