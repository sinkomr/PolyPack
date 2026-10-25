/**
 * Surface problems in the nofold mode, where every piece stays in one face. Faces meet only
 * along edges, so such a packing is a planar packing of each face polygon, and the best one puts
 * the best k-piece packing of the face on every face: nofold(H, N, P) = min over k >= ceil(P/F) of
 * the planar value of k pieces in the face polygon (docs/spaces/SURFACE.md). The client therefore
 * searches the planar problem N-in-M with k pieces with its usual engine and copies the result
 * onto the faces.
 *
 * A face's frame is PolyPack's container frame: the regular M-gon of side s centred at the origin
 * with a horizontal bottom edge (container_phi = 0).
 */
import { type PackingConfig, autoOrient, enclose, evaluate, pieceArea } from "@polypack/geometry";
import type { SpaceConfig } from "../types";
import { SOLID_FACES, type SearchProblem } from "./model";

export type NofoldProblem = SearchProblem & { space: "surface"; mode: "nofold" };

/** Pieces per face of the planar problem: the start's fullest face, and at least ceil(P/F). */
export function piecesPerFace(p: NofoldProblem, start?: SpaceConfig): number {
  const { F } = SOLID_FACES[p.solid];
  let k = Math.ceil(p.P / F);
  if (start) {
    const counts = new Map<number, number>();
    for (const q of start.pieces as { face: number }[]) counts.set(q.face, (counts.get(q.face) ?? 0) + 1);
    for (const c of counts.values()) k = Math.max(k, c);
  }
  return Math.min(k, p.P);
}

/** The planar problem and, from the start's fullest face, a known packing with its score. */
export function faceProblem(
  p: NofoldProblem,
  start?: SpaceConfig,
): {
  problem: { N: number; M: number; P: number };
  known?: { config: PackingConfig; score: number };
  areaBound: number;
} {
  const { M } = SOLID_FACES[p.solid];
  const k = piecesPerFace(p, start);
  const problem = { N: p.N, M, P: k };
  // container area M s^2 / (4 tan(pi/M)) holds k pieces at most
  const areaBound = Math.sqrt((4 * k * pieceArea(p.N) * Math.tan(Math.PI / M)) / M);
  if (!start) return { problem, areaBound };
  const byFace = new Map<number, { x: number; y: number; theta: number }[]>();
  for (const q of start.pieces as { face: number; x: number; y: number; theta: number }[]) {
    const list = byFace.get(q.face) ?? [];
    list.push({ x: q.x, y: q.y, theta: q.theta });
    byFace.set(q.face, list);
  }
  const full = [...byFace.values()].find((list) => list.length === k);
  if (!full) return { problem, areaBound };
  const config: PackingConfig = { ...problem, pieces: full, container_phi: 0 };
  const e = evaluate(config, { autoOrient: true });
  return e.valid && e.container
    ? { problem, known: { config, score: e.container.size }, areaBound }
    : { problem, areaBound };
}

/**
 * The surface configuration with a planar k-piece packing on every face (the last face used may
 * hold fewer), in each face's frame. Null when there are too few faces for P pieces.
 */
export function surfaceFromFace(p: NofoldProblem, face: PackingConfig): SpaceConfig | null {
  const { F, M } = SOLID_FACES[p.solid];
  const k = face.P;
  if (k * F < p.P || face.M !== M || face.N !== p.N) return null;
  // the smallest container, as the server scores planar packings, then moved to the face frame
  const a = enclose(p.N, face.pieces, M, face.container_phi);
  const b = autoOrient(p.N, face.pieces, M, face.container_phi);
  const c = b.size < a.size ? b : a;
  const co = Math.cos(-c.phi);
  const si = Math.sin(-c.phi);
  const placed = face.pieces.map((q) => {
    const dx = q.x - c.cx;
    const dy = q.y - c.cy;
    return { x: co * dx - si * dy, y: si * dx + co * dy, theta: q.theta - c.phi };
  });
  const pieces = Array.from({ length: p.P }, (_, i) => ({ face: Math.floor(i / k), ...placed[i % k] }));
  return { s: c.size, pieces };
}
