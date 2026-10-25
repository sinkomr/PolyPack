/**
 * Problems of the new spaces for the tests, from the research records in data/<space>/records.json:
 * each record's configuration made slightly worse (a larger size with the same poses, which keeps
 * it valid), so that a short search beats it by about the factor.
 */
import { readFileSync } from "node:fs";
import type { SpaceConfig } from "@polypack/spaces";
import { checkSpaceConfig, parseSpaceId } from "../src/spaces/model";
import type { FakeSpaceProblem } from "./fake-server";

const files = new Map<string, Record<string, unknown>[]>();
/** A space's records, read once. */
const data = (space: string) => {
  let records = files.get(space);
  if (!records) {
    records = JSON.parse(readFileSync(new URL(`../../../data/${space}/records.json`, import.meta.url), "utf8")).records;
    files.set(space, records!);
  }
  return records!;
};

const find = (space: string, id: string) => {
  const r = data(space).find((x) => (x.id ?? x.problem) === id);
  if (!r) throw new Error(`no record ${id}`);
  return r as Record<string, any>;
};

/**
 * The record's configuration in the contract's format (surface records keep s and pieces at top level;
 * polyhedra configurations are kept apart, one file per problem in data/polyhedra/configs/<code>.jsonl).
 */
export function recordConfig(space: string, id: string): SpaceConfig {
  const r = find(space, id);
  if (space === "surface") return { s: r.s, pieces: r.pieces };
  if (space === "torus") return r.configuration;
  if (space === "polyhedra") {
    // one line {"P", "config"} per P, at the byte offset and length the record's config_at gives
    const file = readFileSync(new URL(`../../../data/polyhedra/configs/${r.code}.jsonl`, import.meta.url));
    const [offset, length] = r.config_at as [number, number];
    return JSON.parse(file.subarray(offset, offset + length).toString("utf8")).config;
  }
  return r.config;
}

/** The configuration at a size `f` times larger, with the same poses (scaled where the space needs it). */
export function enlarged(space: string, c: SpaceConfig, f: number, mode?: "fold" | "nofold"): SpaceConfig {
  switch (space) {
    case "sphere":
      return { ...c, rho: (c.rho as number) * f };
    case "curved":
      return { ...c, size: (c.size as number) * f };
    case "polyhedra":
      return { ...c, s: (c.s as number) * f };
    case "torus": {
      const l = c.lattice as { L?: number; b1?: number[]; b2?: number[] };
      const lattice = l.L !== undefined ? { L: l.L * f } : { b1: l.b1!.map((v) => v * f), b2: l.b2!.map((v) => v * f) };
      return { lattice, poses: (c.poses as number[][]).map(([x, y, t]) => [x * f, y * f, t]) };
    }
    case "surface": {
      const pieces = c.pieces as { face: number; x: number; y: number; theta: number }[];
      // nofold: the face grows about its centre, the pieces stay; fold: everything scales, which
      // is the same as smaller pieces on the same solid
      const k = mode === "fold" ? f : 1;
      return { s: (c.s as number) * f, pieces: pieces.map((q) => ({ ...q, x: q.x * k, y: q.y * k })) };
    }
    case "boundary": {
      // the tesseract and the centres scale together, which is the same as smaller pieces
      const pieces = c.pieces as { cell: number; u: number[]; q?: number[] }[];
      return { s: (c.s as number) * f, pieces: pieces.map((q) => ({ ...q, u: q.u.map((x) => x * f) })) };
    }
  }
  throw new Error(space);
}

export function fixture(space: string, id: string, f = 1.01, extra: Partial<FakeSpaceProblem> = {}): FakeSpaceProblem {
  const mode = id.includes("/nofold/") ? "nofold" : id.includes("/fold/") ? "fold" : undefined;
  const config = enlarged(space, recordConfig(space, id), f, mode);
  const score = checkSpaceConfig(parseSpaceId(id)!.space, id, config).score!;
  return { id, certified: { score, config }, bound: null, ...extra };
}
