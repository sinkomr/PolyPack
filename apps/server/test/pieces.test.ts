import { MAX_COORD, Pose } from "@polypack/geometry";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crc32, zstdCompressSync } from "node:zlib";
import {
  PIECE_BYTES,
  blobFromJson,
  decodePieces,
  encodePieces,
  packPieces,
  readPieces,
  unpackPieces,
} from "../src/pieces";
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

describe("the store keeps pieces exactly", () => {
  it("returns what was stored, -0 and the coordinate limit included", async () => {
    const store = new SqliteStore(":memory:");
    const id = await store.insert(entry(awkward));
    expectSame(awkward, (await store.get(id))!.pieces);
    expectSame(awkward, (await store.getMany([id]))[0].pieces);
    // stored packed: a BLOB shorter than the triples, which unpacks to them
    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const stored = db.prepare("SELECT pieces FROM submissions WHERE id = ?").get(id) as { pieces: Uint8Array };
    expect(stored.pieces).toBeInstanceOf(Uint8Array);
    expect(stored.pieces.length).toBeLessThan(awkward.length * PIECE_BYTES);
    expect(Buffer.from(unpackPieces(stored.pieces)).equals(Buffer.from(encodePieces(awkward)))).toBe(true);
  });
});

const PACKED_2026_11 =
  "01d002000042a4036d28b52ffd60d001dd0200040200000100f03f0040020840011014181c20222426282a2c2e304000005555d53f1900" +
  "0d52e86b93825e190c2cfcb91420dc2fcc04d0662a77c031e064c5dd528e012733dd01c78672b2e26ea763c0092003dcb13218043c002c";

describe("packed pieces", () => {
  // deterministic doubles with every byte in use
  let seed = 20261114;
  const next = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0), seed / 2 ** 32);
  const scattered = (count: number): Pose[] =>
    Array.from({ length: count }, () => ({ x: (next() - 0.5) * 40, y: (next() - 0.5) * 40, theta: next() * 6.283 }));
  // what packs well in real entries: rows of a lattice and angles that repeat
  const lattice = (count: number): Pose[] =>
    Array.from({ length: count }, (_, i) => ({
      x: (i % 17) * 1.0000000000000002,
      y: Math.floor(i / 17) / 3,
      theta: 0,
    }));
  const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

  it("comes back bit for bit, for every count of pieces, and is told from triples by its length alone", () => {
    let packedSeen = 0;
    let paddedSeen = 0;
    for (let count = 0; count <= 520; count++)
      for (const pieces of [scattered(count), lattice(count)]) {
        const triples = encodePieces(pieces);
        const stored = packPieces(triples);
        expect(same(unpackPieces(stored), triples)).toBe(true);
        expectSame(pieces, decodePieces(stored));
        expectSame(pieces, readPieces(stored));
        if (stored.length % PIECE_BYTES === 0) {
          // kept as triples: packing did not shorten them
          expect(same(stored, triples)).toBe(true);
          continue;
        }
        packedSeen++;
        expect(stored.length).toBeLessThan(triples.length);
        expect([1, 2]).toContain(stored[0]);
        if (stored[0] === 2) {
          // the padded form: without its last byte, a zero, the length would be a multiple of 24
          paddedSeen++;
          expect((stored.length - 1) % PIECE_BYTES).toBe(0);
          expect(stored[stored.length - 1]).toBe(0);
        }
      }
    expect(packedSeen).toBeGreaterThan(900);
    expect(paddedSeen).toBeGreaterThan(5);
  });

  it("packs a lattice to a small part and leaves a few scattered pieces as triples", () => {
    const big = encodePieces(lattice(500));
    expect(packPieces(big).length).toBeLessThan(big.length / 4);
    const few = encodePieces(scattered(2));
    expect(packPieces(few)).toBe(few);
    expect(packPieces(new Uint8Array(0)).length).toBe(0);
    expect(() => packPieces(new Uint8Array(25))).toThrow(RangeError);
  });

  it("reads triples as triples whatever their first bytes are", () => {
    // doubles whose bytes begin as a packed value or a zstd frame does
    const tricky = new Uint8Array(48);
    tricky.set([1, 0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x30, 0x40], 0);
    tricky.set([2, 0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0], 24);
    expect(unpackPieces(tricky)).toBe(tricky);
    expect(decodePieces(tricky)).toHaveLength(2);
  });

  it("reads a value packed in November 2026", () => {
    // written by packPieces of 30 lattice pieces; a zstd frame is read the same by every version of zstd
    const packed = Buffer.from(PACKED_2026_11, "hex");
    expectSame(lattice(30), decodePieces(packed));
  });

  it("refuses what is neither triples nor a packed value", () => {
    // a packed value made by hand: the tag, the length and the CRC-32 it claims, and a frame of `content`
    const made = (claimed: number, content: Uint8Array, crc = crc32(content), after = new Uint8Array(0)) => {
      const head = Buffer.alloc(9, 1);
      head.writeUInt32LE(claimed, 1);
      head.writeUInt32LE(crc, 5);
      const value = Buffer.concat([head, zstdCompressSync(content), after]);
      return value.length % PIECE_BYTES === 0 ? Buffer.concat([value, Buffer.alloc(1)]).fill(2, 0, 1) : value;
    };
    const cut = (value: Uint8Array, by: number) => {
      const shorter = value.subarray(0, value.length - by);
      return shorter.length % PIECE_BYTES === 0 ? value.subarray(0, value.length - by - 1) : shorter;
    };
    const good = packPieces(encodePieces(lattice(40)));
    const zeros = new Uint8Array(48);
    const refused: [Uint8Array, RegExp][] = [
      // an unknown tag
      [new Uint8Array(25), /not packed \(they begin with 0\)/],
      [new Uint8Array([3, 1, 2, 3, 4]), /not packed \(they begin with 3\)/],
      // nothing after the head, and a frame cut short by one byte and by many
      [good.subarray(0, 9), /cannot be unpacked/],
      [cut(good, 1), /cannot be unpacked/],
      [cut(good, 40), /cannot be unpacked/],
      // damage in the frame, in the length and in the CRC-32
      [Uint8Array.from(good, (b, i) => (i === 30 ? b ^ 0xff : b)), /cannot be unpacked/],
      [Uint8Array.from(good, (b, i) => (i === good.length - 2 ? b ^ 1 : b)), /cannot be unpacked/],
      [Uint8Array.from(good, (b, i) => (i === 1 ? b + 24 : b)), /cannot be unpacked/],
      [Uint8Array.from(good, (b, i) => (i === 6 ? b ^ 1 : b)), /cannot be unpacked/],
      // a frame that holds less than is claimed, more than is claimed, and claims that are no list of triples
      [made(72, zeros), /cannot be unpacked/],
      [made(24, zeros), /cannot be unpacked/],
      [made(50, new Uint8Array(50)), /cannot be unpacked/],
      [made(0, new Uint8Array(0)), /cannot be unpacked/],
      // other triples than the CRC-32 is of, bytes after the frame, and a second frame
      [made(48, zeros, (crc32(zeros) ^ 1) >>> 0), /cannot be unpacked/],
      [made(48, zeros, crc32(zeros), new Uint8Array([7, 7, 7])), /cannot be unpacked/],
      [made(48, zeros, crc32(zeros), zstdCompressSync(new Uint8Array(0))), /cannot be unpacked/],
      // far too much to unpack
      [made(48 << 20, new Uint8Array(48 << 20)), /cannot be unpacked/],
    ];
    for (const [value, message] of refused) {
      expect(value.length % PIECE_BYTES, message.source).not.toBe(0);
      expect(() => unpackPieces(value), `${value.length} bytes`).toThrow(message);
      expect(() => unpackPieces(value)).toThrow(RangeError);
    }
    // and a hand-made value with the right claims is read
    expect(unpackPieces(made(48, zeros))).toEqual(zeros);
  });
});

// apps/server/scripts/pieces-unpack.mjs, the way back to a server that reads only triples
describe("unpacking a database for an older server", () => {
  it("counts what is packed, then rewrites it as the same triples and clears the migration's progress", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "polypack-unpack-")), "db.sqlite");
    const store = new SqliteStore(path);
    const lattice = (count: number, k: number): Pose[] =>
      Array.from({ length: count }, (_, i) => ({ x: (i % 9) * (1 + k * 1e-9), y: Math.floor(i / 9) / 3, theta: 0 }));
    const held = [lattice(60, 1), awkward, lattice(400, 2), [{ x: 0.1, y: 0.2, theta: 0.3 }]];
    const ids: number[] = [];
    for (const [i, pieces] of held.entries()) ids.push(await store.insert({ ...entry(pieces), P: 10 + i }));
    const db = (store as unknown as { db: DatabaseSync }).db;
    const lengths = () =>
      (db.prepare("SELECT length(pieces) AS n FROM submissions ORDER BY id").all() as { n: number }[]).map((r) => r.n);
    const packed = lengths();
    expect(packed.map((n) => n % PIECE_BYTES === 0)).toEqual([false, false, false, true]);
    const script = resolve(__dirname, "../scripts/pieces-unpack.mjs");
    const run = (...args: string[]) =>
      JSON.parse(execFileSync(process.execPath, ["--no-warnings", script, path, ...args]).toString());

    expect(run()).toMatchObject({ rows: 4, packed: 3, unpacked: 0 });
    expect(lengths()).toEqual(packed);
    const done = run("--write");
    expect(done).toMatchObject({ rows: 4, packed: 3, unpacked: 3, unreadable: 0 });
    expect(done.bytes_before).toBe(packed[0] + packed[1] + packed[2]);
    expect(lengths()).toEqual(held.map((pieces) => pieces.length * PIECE_BYTES));
    for (const [i, pieces] of held.entries()) {
      const stored = db.prepare("SELECT pieces FROM submissions WHERE id = ?").get(ids[i]) as { pieces: Uint8Array };
      expect(Buffer.from(stored.pieces).equals(Buffer.from(encodePieces(pieces))), `row ${ids[i]}`).toBe(true);
    }
    expect(db.prepare("SELECT COUNT(*) AS c FROM meta WHERE key LIKE 'pieces_packed%'").get()).toEqual({ c: 0 });
    expect(run()).toMatchObject({ rows: 4, packed: 0 });
    // the current server would pack them again from the first row
    expect(new SqliteStore(path).piecesMigrated()).toBe(false);
  });
});
