/**
 * The HTTP contract of the new spaces: polyhedral surfaces, constant curvature, the whole sphere,
 * flat tori, the boundaries of 4D polytopes, polyhedra in polyhedra and balls in balls and cubes. The server answers with these shapes, the website and the volunteer client read
 * them. Each space keeps its own problem ids and configuration format (docs/spaces/*.md); this file
 * only names them.
 *
 * Two kinds of value are listed side by side and never mixed up:
 *  - `certified`: the research record shipped in data/<space>/records.json, proven valid with
 *    interval arithmetic by python/<space>/ (its `score_cert`);
 *  - `site_best`: the best entry submitted to the site, checked by the server's floating-point
 *    validator of that space with PolyPack's usual tolerance, like every other site entry.
 */

import type { SpaceDomainInfo } from "./domain";

/** Spaces that take submissions. */
export type SpaceName = "surface" | "curved" | "sphere" | "torus" | "boundary" | "polyhedra" | "balls";
export const SPACE_NAMES: readonly SpaceName[] = ["surface", "curved", "sphere", "torus", "boundary", "polyhedra", "balls"];

export function isSpaceName(v: unknown): v is SpaceName {
  return typeof v === "string" && (SPACE_NAMES as readonly string[]).includes(v);
}

/** Status of a research record: `proven` only with a published proof; `infeasible` = no packing exists (proved). */
export type CertifiedStatus = "best_known" | "proven" | "infeasible";

/**
 * Status of a problem: its research record's, or `no_record` for a problem of the space's domain (domain.ts) that has
 * no research record yet. Such a problem takes entries; its best value is the site's, none until a first entry is
 * kept, and every entry must pass the strict check (validate.ts).
 */
export type SpaceProblemStatus = CertifiedStatus | "no_record";

/**
 * Configurations, in each space's own format (the record files' format):
 *  - surface: `{ s, pieces: [{ face, x, y, theta }] }`, score s (edge of the solid);
 *  - curved:  `{ size, pieces: [{ x, y, theta }] }`, score size (container side, or diameter of a disk container, at curvature K);
 *  - sphere:  `{ rho, pieces: [{ q: [w, x, y, z] }] }`, score rho (sphere radius);
 *  - torus:   `{ lattice: { L } | { b1: [x, y], b2: [x, y] }, poses: [[x, y, theta], ...] }`,
 *             score L (sq, hex) or sqrt|det(b1, b2)| (free);
 *  - boundary: `{ s, pieces: [{ cell, u: [u0, u1, u2], q?: [w, x, y, z] }] }`, score s (edge of the
 *             polytope).
 *  - polyhedra: `{ s, pieces: [[x, y, z, qw, qx, qy, qz], ...] }`, score s (scale of the container solid).
 *  - balls:   `{ s, pieces: [[x, y, z], ...] }` for balls of diameter 1, `[[x, y, z, qw, qx, qy, qz], ...]` for
 *             unit-edge Platonic solids; score s (the container ball's diameter, or the cube's edge).
 */
export type SpaceConfig = Record<string, unknown>;

/** A space as GET /api/spaces lists it. */
export interface SpaceInfo {
  space: SpaceName;
  title: string;
  /** One or two plain sentences. */
  summary: string;
  /** What the score measures, smaller is better. */
  score: string;
  /** The id pattern, e.g. "surface/<solid>/<mode>/<N>/<P>". */
  problem_id: string;
  /** Units, pose and container conventions, as short sentences keyed by topic. */
  conventions: Record<string, string>;
  /**
   * Problems of the space: the size of its domain when it has one, else its research records (infeasible ones
   * included).
   */
  problems: number;
  /** Problems with a research record; the others of the domain have none yet (status `no_record`). */
  records: number;
  /** The space's domain, when its problems are given by one (domain.ts); the listing then holds its records only. */
  domain?: SpaceDomainInfo;
  /** Path of the static viewer, e.g. "/spaces/surface.html". */
  viewer: string;
  /** URL of the space's notes on GitHub. */
  docs: string;
}

/** Research material that is shown but takes no submissions (the curvature sweeps). */
export interface SpaceExhibit {
  name: string;
  title: string;
  summary: string;
  viewer: string;
  docs: string;
}

export interface SpacesResponse {
  spaces: SpaceInfo[];
  exhibits: SpaceExhibit[];
}

/** The research record of a problem, without its configuration. */
export interface CertifiedValue {
  /** score_cert: the size at which the stored configuration is proven valid. */
  score: number;
  /** score_cert rounded to the nearest at 6 decimals (an exact 2, certified at 2 (1 + 1e-12), shows "2.000000"). */
  display: string;
  status: CertifiedStatus;
}

/** The leading site entry of a problem, without its configuration. */
export interface SiteBest {
  id: number;
  score: number;
  name: string;
  created_at: string;
}

/**
 * Values a research record of some spaces carries besides its score and bound. Only the boundary
 * space has them: there `nofold` is the best edge when every piece must stay inside one cell (no
 * folding across the square faces), and `fold_gain` = 1 - score_float / nofold.value, how much
 * smaller the research record's polytope is than the nofold one (score_float: the record's
 * search value before the certificate's scaling; docs/spaces/BOUNDARY.md sections 6 and 7).
 */
export interface SpaceProblemExtra {
  /** The nofold value and what it rests on (a sentence with its [CALC] or [EST] label); null when the record has none. */
  nofold: { value: number; label: string } | null;
  /** The research record's relative gain over nofold, from 0 to 1; null when the record has none. */
  fold_gain: number | null;
}

/** One problem as a listing shows it (no configurations). */
export interface SpaceProblemSummary {
  space: SpaceName;
  /**
   * The problem id, e.g. "surface/cube/fold/0/12", "curved/-1/3/4/7", "sphere/4/12", "torus/hex/5/8",
   * "boundary/tesseract/ball/9", "polyhedra/cubintet/12", "balls/ballinball/13".
   */
  id: string;
  /**
   * The id's fields: surface {solid, mode, N, P}; curved {K, N, M, P}; sphere {N, P}; torus {family, N, P};
   * boundary {polytope, piece, P}; polyhedra {code, piece, container, P}; balls {code, piece, container, P}.
   */
  fields: Record<string, string | number>;
  P: number;
  certified: CertifiedValue | null;
  /** Best lower bound on the score shipped with the record, and what it rests on. */
  bound: { value: number; label: string } | null;
  site_best: SiteBest | null;
  /** The smaller of certified.score and site_best.score; null when there is neither. */
  best_score: number | null;
  /** False for proven and infeasible problems. */
  accepts_submissions: boolean;
  /**
   * The problem's status (always sent): its research record's, or `no_record` when it has none yet (then
   * `certified` is null and the problem takes entries). `infeasible` problems have no certified value and no
   * configuration: no packing exists.
   */
  status?: SpaceProblemStatus;
  /** Why the problem takes no submissions, for proven and infeasible problems; null when it is open (always sent). */
  closed_reason?: string | null;
  /** Sent for boundary problems only: the research record's nofold comparison. */
  extra?: SpaceProblemExtra;
}

/** GET /api/spaces/:space/records */
export interface SpaceRecordsResponse {
  space: SpaceName;
  generated_at: string;
  problems: SpaceProblemSummary[];
}

/**
 * GET /api/spaces/:space/site-only?limit=&after=: the problems of the space's domain that have a site entry and no
 * research record (the records listing holds neither), by id; `next` is the `after` of the following page, or null.
 */
export interface SpaceSiteOnlyResponse {
  space: SpaceName;
  generated_at: string;
  problems: SpaceProblemSummary[];
  next: string | null;
}

/** GET /api/spaces/:space/problems/<id>: one problem with its configurations. */
export interface SpaceProblemResponse extends SpaceProblemSummary {
  conventions: Record<string, string>;
  /** The research record's configuration (null for infeasible problems). */
  certified_config: SpaceConfig | null;
  /** The leading site entry's configuration. */
  site_config: SpaceConfig | null;
}

/** GET /api/spaces/entries/:id: a stored site entry, with its configuration (for share links). */
export interface SpaceEntryResponse {
  id: number;
  space: SpaceName;
  /** The problem id. */
  problem: string;
  score: number;
  name: string;
  agent_note: string;
  software: string | null;
  method: string | null;
  seed: number | null;
  config: SpaceConfig;
  created_at: string;
}

/** POST /api/spaces/submit */
export interface SpaceSubmission {
  space: SpaceName;
  id: string;
  config: SpaceConfig;
  name: string;
  agent_note?: string;
  /** Free text such as "polypack-volunteer 1.4.0". */
  software?: string;
  /** Free text naming the search, such as "sphere basin hopping". */
  method?: string;
  seed?: number;
  /** "diameter": the configuration is in the units of 2026-10-27 (disks and balls of diameter 1); required for problems with disks, balls or a circle or ball container. */
  units?: "diameter";
}

export interface SpaceSubmitResponse {
  valid: boolean;
  reasons: string[];
  /** The score the server computed from the configuration. */
  score: number | null;
  /** True when the entry now leads the site entries of its problem. */
  leader: boolean;
  /** The problem's best score after this submission (certified or site). */
  best_score: number | null;
  /** Entry id when it was kept (only the leader of a problem is kept). */
  id: number | null;
  /** True when the score is below the research record's score_cert. */
  beats_certified: boolean;
  /**
   * False when the server did not check the configuration because its stated score could not be
   * kept anyway (polyhedra: not below the research record by the record margin, or not below the
   * site leader by the tie tolerance); `valid` is then false, `score` the stated one, the status 200.
   * Absent otherwise.
   */
  checked?: false;
}
