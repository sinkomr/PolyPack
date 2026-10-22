/**
 * Checks on what the server sends. Its answers are untrusted input: a value the client uses must
 * have the right type and be finite, and pieces must be P poses of finite numbers. Each reader
 * returns a clean copy, or null when the answer cannot be used. Strings shown to the user are
 * stripped of control characters and terminal escape sequences first.
 */
import {
  type LeaderboardEntry,
  type LiteratureRecord,
  MAX_PIECES,
  MAX_SIDES,
  type Pose,
  type ProblemInfo,
  type Target,
} from "@polypack/geometry";
import type { Problem } from "./types";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPositive = (v: unknown): v is number => isFiniteNumber(v) && v > 0;
const isShape = (v: unknown): v is number =>
  Number.isInteger(v) && (v === 0 || ((v as number) >= 3 && (v as number) <= MAX_SIDES));
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_PIECES;

// terminal escape sequences (CSI, OSC and two-character ones), then control and direction characters
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]?/g;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

/** Text from the server, safe to print on a terminal: one line of at most `max` characters. */
export function cleanText(v: unknown, max = 200): string {
  const text = String(v ?? "")
    .replace(ESCAPES, "")
    .replace(CONTROLS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** P poses of finite numbers, copied; a missing theta is 0, as the server reads it. Null otherwise. */
export function readPieces(v: unknown, P: number): Pose[] | null {
  if (!Array.isArray(v) || v.length !== P) return null;
  const out: Pose[] = [];
  for (const p of v) {
    if (!isObject(p)) return null;
    const theta = p.theta === undefined ? 0 : p.theta;
    if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(theta)) return null;
    out.push({ x: p.x, y: p.y, theta });
  }
  return out;
}

/** One entry of the work list, or null. A leader_id that is not an integer reads as none. */
export function readTarget(v: unknown): Target | null {
  if (!isObject(v) || !isShape(v.N) || !isShape(v.M) || !isCount(v.P) || !isFiniteNumber(v.priority)) return null;
  const leaderId = Number.isSafeInteger(v.leader_id) ? (v.leader_id as number) : null;
  return {
    N: v.N,
    M: v.M,
    P: v.P,
    reason: cleanText(v.reason, 40) as Target["reason"],
    priority: v.priority,
    leader: leaderId !== null && isPositive(v.leader) ? v.leader : null,
    leader_id: leaderId,
    published: isPositive(v.published) ? v.published : null,
    published_coordinates: v.published_coordinates === true,
    area_bound: isFiniteNumber(v.area_bound) ? v.area_bound : 0,
  };
}

/**
 * GET /api/problems/{N}/{M}/{P}, cleaned. Null when it is not this problem, or when what the
 * decisions rest on (whether it is open, the area bound, the leader) is malformed. A malformed
 * published value or published coordinates only drop those.
 */
export function readProblemInfo(v: unknown, p: Problem): ProblemInfo | null {
  if (!isObject(v) || v.N !== p.N || v.M !== p.M || v.P !== p.P) return null;
  if (typeof v.accepts_submissions !== "boolean" || !isFiniteNumber(v.area_bound)) return null;
  let siteBest: LeaderboardEntry | null = null;
  if (v.site_best !== null && v.site_best !== undefined) {
    const b = v.site_best;
    if (!isObject(b) || !Number.isSafeInteger(b.id) || !isPositive(b.score)) return null;
    // the name is kept as sent, to recognise our own entries; it is cleaned where it is printed
    const name = typeof b.name === "string" ? b.name : "";
    siteBest = { ...(b as unknown as LeaderboardEntry), id: b.id as number, score: b.score, name };
  }
  let literature: LiteratureRecord | null = null;
  const lit = v.literature;
  if (isObject(lit) && isPositive(lit.value)) {
    const pieces = lit.pieces === undefined ? null : readPieces(lit.pieces, p.P);
    const phi = isFiniteNumber(lit.container_phi) ? lit.container_phi : 0;
    const { pieces: _p, container_phi: _c, ...rest } = lit as unknown as LiteratureRecord;
    literature = { ...rest, value: lit.value, ...(pieces ? { pieces, container_phi: phi } : {}) };
  }
  return {
    N: p.N,
    M: p.M,
    P: p.P,
    conventions: {},
    area_bound: v.area_bound,
    literature,
    site_best: siteBest,
    accepts_submissions: v.accepts_submissions,
  };
}

/** GET /api/submissions/{id}: the stored packing, or null. */
export function readStoredEntry(
  v: unknown,
  P: number,
): { score: number; pieces: Pose[]; container_phi: number } | null {
  if (!isObject(v) || !isPositive(v.score)) return null;
  const pieces = readPieces(v.pieces, P);
  if (!pieces) return null;
  const phi = v.container_phi === null || v.container_phi === undefined ? 0 : v.container_phi;
  return isFiniteNumber(phi) ? { score: v.score, pieces, container_phi: phi } : null;
}

/** The fields of a POST /api/submit answer that the client records, or null when it has none. */
export function readSubmitResponse(v: unknown): {
  valid: boolean;
  leader: boolean;
  score: number | null;
  leader_score: number | null;
  id: number | null;
  pending_verification: boolean;
  reasons: string[];
} | null {
  if (!isObject(v) || typeof v.valid !== "boolean") return null;
  return {
    valid: v.valid,
    leader: v.leader === true,
    score: isPositive(v.score) ? v.score : null,
    leader_score: isPositive(v.leader_score) ? v.leader_score : null,
    id: Number.isSafeInteger(v.id) ? (v.id as number) : null,
    pending_verification: v.pending_verification === true,
    reasons: Array.isArray(v.reasons) ? v.reasons.slice(0, 5).map((r) => cleanText(r)) : [],
  };
}
