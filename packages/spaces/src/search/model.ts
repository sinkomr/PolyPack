/**
 * The new spaces (polyhedral surfaces, constant curvature, the whole sphere, flat tori) as their
 * searches see them: problem ids, configurations in each space's own format (docs/spaces/*.md),
 * the score a configuration states, and the check of a result before it is offered or submitted.
 * The volunteer client and the website's board share this code.
 *
 * That check is the server's own rule (validateSpaceSubmission: the space's float validator at
 * PolyPack's tolerance 1e-9); the server's answer stays authoritative. Everything here is pure, so
 * that a page, its search threads and the volunteer client share it. Configurations come from the
 * server, so the readers treat them as untrusted input and return clean copies or null.
 */
import { MAX_PIECES } from "@polypack/geometry";
import { type SolidName, isSolidName } from "@polypack/surface";
import { type Lattice, type TorusFamily, type TorusPacking, familyLattice, torusScore } from "@polypack/torus";
import type { SpaceConfig, SpaceName } from "../types";
import { validateSpaceSubmission } from "../validate";

/** PolyPack's touching tolerance: a gap of at least -TOL is contact, not overlap. */
export { SPACE_TOL } from "../info";

/** A problem a search can work on, from its id (parseSearchProblem). */
export type SearchProblem =
  | { space: "surface"; id: string; P: number; solid: SolidName; mode: "fold" | "nofold"; N: number }
  | { space: "curved"; id: string; P: number; K: number; N: number; M: number }
  | { space: "sphere"; id: string; P: number; N: number }
  | { space: "torus"; id: string; P: number; family: TorusFamily; N: number };

/** The name each space's search goes by in submissions and logs. */
export const SPACE_METHOD: Record<SpaceName, string> = {
  surface: "surface fold search",
  curved: "curved search",
  sphere: "sphere basin hopping",
  torus: "torus basin hopping",
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const count = (text: string) => {
  const v = Number(text);
  return Number.isInteger(v) && v >= 1 && v <= MAX_PIECES ? v : null;
};
const shape = (text: string) => {
  const v = Number(text);
  return Number.isInteger(v) && (v === 0 || (v >= 3 && v <= 100)) ? v : null;
};

/**
 * A problem id as the server lists it, or null when it is not one the searches can work on:
 * surface/<solid>/<fold|nofold>/<N>/<P>, curved/<K>/<N>/<M>/<P>, sphere/<N>/<P>,
 * torus/<sq|hex|free>/<N>/<P>. The volunteer client also uses ids in file names, so only these
 * forms pass. (The volunteer client imports it as parseSpaceId.)
 */
export function parseSearchProblem(id: unknown): SearchProblem | null {
  if (typeof id !== "string" || id.length > 120) return null;
  let m = /^surface\/([a-z]+)\/(fold|nofold)\/(\d{1,3})\/(\d{1,3})$/.exec(id);
  if (m) {
    const N = shape(m[3]);
    const P = count(m[4]);
    if (!isSolidName(m[1]) || N === null || P === null) return null;
    return { space: "surface", id, P, solid: m[1], mode: m[2] as "fold" | "nofold", N };
  }
  m = /^curved\/(-?(?:\d+(?:\.\d+)?)(?:e[-+]?\d+)?)\/(\d{1,3})\/(\d{1,3})\/(\d{1,3})$/.exec(id);
  if (m) {
    const K = Number(m[1]);
    const N = shape(m[2]);
    const M = shape(m[3]);
    const P = count(m[4]);
    if (!Number.isFinite(K) || N === null || M === null || P === null) return null;
    return { space: "curved", id, P, K, N, M };
  }
  m = /^sphere\/(\d{1,3})\/(\d{1,3})$/.exec(id);
  if (m) {
    const N = shape(m[1]);
    const P = count(m[2]);
    if (N === null || P === null) return null;
    return { space: "sphere", id, P, N };
  }
  m = /^torus\/(sq|hex|free)\/(\d{1,3})\/(\d{1,3})$/.exec(id);
  if (m) {
    const N = shape(m[2]);
    const P = count(m[3]);
    if (N === null || P === null) return null;
    return { space: "torus", id, P, family: m[1] as TorusFamily, N };
  }
  return null;
}

/** P poses {x, y, theta} of finite numbers, copied, or null. */
function readXYT(
  v: unknown,
  P: number,
  withFace = false,
): { face?: number; x: number; y: number; theta: number }[] | null {
  if (!Array.isArray(v) || v.length !== P) return null;
  const out = [];
  for (const p of v) {
    if (!isObject(p) || !finite(p.x) || !finite(p.y) || !finite(p.theta)) return null;
    if (withFace) {
      if (!Number.isInteger(p.face) || (p.face as number) < 0 || (p.face as number) > 100) return null;
      out.push({ face: p.face as number, x: p.x, y: p.y, theta: p.theta });
    } else out.push({ x: p.x, y: p.y, theta: p.theta });
  }
  return out;
}

const vec2 = (v: unknown): [number, number] | null =>
  Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) ? [v[0], v[1]] : null;

/** A clean copy of a configuration in the problem's format, or null when it is malformed. */
export function readSpaceConfig(p: SearchProblem, v: unknown): SpaceConfig | null {
  if (!isObject(v)) return null;
  switch (p.space) {
    case "surface": {
      const pieces = readXYT(v.pieces, p.P, true);
      return positive(v.s) && pieces ? { s: v.s, pieces } : null;
    }
    case "curved": {
      const pieces = readXYT(v.pieces, p.P);
      return positive(v.size) && pieces ? { size: v.size, pieces } : null;
    }
    case "sphere": {
      if (!positive(v.rho) || !Array.isArray(v.pieces) || v.pieces.length !== p.P) return null;
      const pieces = [];
      for (const q of v.pieces) {
        if (!isObject(q) || !Array.isArray(q.q) || q.q.length !== 4 || !q.q.every(finite)) return null;
        pieces.push({ q: [...q.q] as [number, number, number, number] });
      }
      return { rho: v.rho, pieces };
    }
    case "torus": {
      const l = v.lattice;
      if (!isObject(l) || !Array.isArray(v.poses) || v.poses.length !== p.P) return null;
      const poses: [number, number, number][] = [];
      for (const q of v.poses) {
        if (!Array.isArray(q) || q.length !== 3 || !q.every(finite)) return null;
        poses.push([q[0], q[1], q[2]]);
      }
      if (p.family === "free") {
        const b1 = vec2(l.b1);
        const b2 = vec2(l.b2);
        return b1 && b2 ? { lattice: { b1, b2 }, poses } : null;
      }
      return positive(l.L) ? { lattice: { L: l.L }, poses } : null;
    }
  }
}

/** The torus packing a configuration describes (sq/hex lattices rebuilt from L). */
export function torusPackingOf(p: SearchProblem & { space: "torus" }, c: SpaceConfig): TorusPacking {
  const l = c.lattice as { L?: number; b1?: [number, number]; b2?: [number, number] };
  const lattice: Lattice = p.family === "free" ? { b1: l.b1!, b2: l.b2! } : familyLattice(p.family, l.L!);
  const poses = (c.poses as [number, number, number][]).map(([x, y, theta]) => ({ x, y, theta }));
  return { family: p.family, N: p.N, lattice, poses };
}

/** The configuration of a torus packing: {L} for sq/hex (|b1|), {b1, b2} for free. */
export function torusConfigOf(p: SearchProblem & { space: "torus" }, k: TorusPacking): SpaceConfig {
  const lattice =
    p.family === "free"
      ? { b1: [k.lattice.b1[0], k.lattice.b1[1]], b2: [k.lattice.b2[0], k.lattice.b2[1]] }
      : { L: Math.hypot(k.lattice.b1[0], k.lattice.b1[1]) };
  return { lattice, poses: k.poses.map((q) => [q.x, q.y, q.theta]) };
}

/** The score a (well-formed) configuration states: s, size, rho, L or sqrt|det(b1, b2)|. */
export function statedScore(p: SearchProblem, c: SpaceConfig): number {
  switch (p.space) {
    case "surface":
      return c.s as number;
    case "curved":
      return c.size as number;
    case "sphere":
      return c.rho as number;
    case "torus":
      return torusScore(p.family, torusPackingOf(p, c).lattice);
  }
}

/**
 * What the server's rule needs to know of the problem: its lower bound, and the research record's
 * certified size; a configuration below that by more than the tie tolerance must also be valid at
 * the strict tolerance 1e-11 (validateSpaceSubmission).
 */
export interface SpaceRule {
  bound?: number | null;
  certified?: number | null;
}

export interface SpaceCheck {
  valid: boolean;
  /** The stated score, or null when the configuration is malformed. */
  score: number | null;
  reasons: string[];
}

/**
 * The client's check of a configuration, the one place it is decided: the server's own rule,
 * @polypack/spaces' validateSpaceSubmission (a known problem id of the space, well formed, within
 * the work bounds, and valid by the space's float validator at the stated size with the tolerance
 * 1e-9). The score is null only when the configuration is malformed.
 */
export function checkSpaceConfig(space: SpaceName, id: string, config: unknown, rule: SpaceRule = {}): SpaceCheck {
  const v = validateSpaceSubmission(space, id, config, {
    bound: rule.bound ?? null,
    certified: rule.certified ?? null,
  });
  return { valid: v.valid, score: v.malformed ? null : v.score, reasons: v.reasons.slice(0, 5) };
}

/** What the start of a search is chosen from: a problem's two configurations and their scores. */
export interface KnownConfigs {
  certified: { score: number } | null;
  certified_config: SpaceConfig | null;
  site_best: { score: number } | null;
  site_config: SpaceConfig | null;
}

/**
 * The configuration to start from: the better of the research record's and the site leader's
 * (the record on a tie), when there is one.
 */
export function buildSpaceKnown(
  info: KnownConfigs,
): { config: SpaceConfig; score: number; source: "certified" | "site" } | undefined {
  const cert =
    info.certified_config && info.certified ? { config: info.certified_config, score: info.certified.score } : null;
  const site = info.site_config && info.site_best ? { config: info.site_config, score: info.site_best.score } : null;
  if (site && (!cert || site.score < cert.score)) return { ...site, source: "site" };
  if (cert) return { ...cert, source: "certified" };
  return undefined;
}

/** Faces of each solid, for nofold configurations. */
export const SOLID_FACES: Record<SolidName, { F: number; M: number }> = {
  tetrahedron: { F: 4, M: 3 },
  cube: { F: 6, M: 4 },
  octahedron: { F: 8, M: 3 },
  dodecahedron: { F: 12, M: 5 },
  icosahedron: { F: 20, M: 3 },
};
