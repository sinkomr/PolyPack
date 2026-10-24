/**
 * The HTTP contract of the new spaces: polyhedral surfaces, constant curvature, the whole sphere
 * and flat tori. The server answers with these shapes, the website and the volunteer client read
 * them. Each space keeps its own problem ids and configuration format (docs/spaces/*.md); this file
 * only names them.
 *
 * Two kinds of value are listed side by side and never mixed up:
 *  - `certified`: the research record shipped in data/<space>/records.json, proven valid with
 *    interval arithmetic by python/<space>/ (its `score_cert`);
 *  - `site_best`: the best entry submitted to the site, checked by the server's floating-point
 *    validator of that space with PolyPack's usual tolerance, like every other site entry.
 */

/** Spaces that take submissions. */
export type SpaceName = "surface" | "curved" | "sphere" | "torus";
export const SPACE_NAMES: readonly SpaceName[] = ["surface", "curved", "sphere", "torus"];

export function isSpaceName(v: unknown): v is SpaceName {
  return typeof v === "string" && (SPACE_NAMES as readonly string[]).includes(v);
}

/** Status of a research record: `proven` only with a published proof; `infeasible` = no packing exists (proved). */
export type CertifiedStatus = "best_known" | "proven" | "infeasible";

/**
 * Configurations, in each space's own format (the record files' format):
 *  - surface: `{ s, pieces: [{ face, x, y, theta }] }`, score s (edge of the solid);
 *  - curved:  `{ size, pieces: [{ x, y, theta }] }`, score size (container side or radius at curvature K);
 *  - sphere:  `{ rho, pieces: [{ q: [w, x, y, z] }] }`, score rho (sphere radius);
 *  - torus:   `{ lattice: { L } | { b1: [x, y], b2: [x, y] }, poses: [[x, y, theta], ...] }`,
 *             score L (sq, hex) or sqrt|det(b1, b2)| (free).
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
  /** Problems in the catalogue (the research records, infeasible ones included). */
  problems: number;
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
  /** score_cert rounded up at 6 decimals. */
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

/** One problem as a listing shows it (no configurations). */
export interface SpaceProblemSummary {
  space: SpaceName;
  /** The problem id, e.g. "surface/cube/fold/0/12", "curved/-1/3/4/7", "sphere/4/12", "torus/hex/5/8". */
  id: string;
  /** The id's fields: surface {solid, mode, N, P}; curved {K, N, M, P}; sphere {N, P}; torus {family, N, P}. */
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
   * The research record's status (always sent). `infeasible` problems have no certified value and
   * no configuration: no packing exists.
   */
  status?: CertifiedStatus;
  /** Why the problem takes no submissions, for proven and infeasible problems; null when it is open (always sent). */
  closed_reason?: string | null;
}

/** GET /api/spaces/:space/records */
export interface SpaceRecordsResponse {
  space: SpaceName;
  generated_at: string;
  problems: SpaceProblemSummary[];
}

/** GET /api/spaces/:space/problems/<id>: one problem with its configurations. */
export interface SpaceProblemResponse extends SpaceProblemSummary {
  conventions: Record<string, string>;
  /** The research record's configuration (null for infeasible problems). */
  certified_config: SpaceConfig | null;
  /** The leading site entry's configuration. */
  site_config: SpaceConfig | null;
}

/** One problem of the optional volunteer work list. */
export interface SpaceTarget {
  space: SpaceName;
  id: string;
  P: number;
  /** Larger is more promising; the volunteer client draws in proportion to it. */
  priority: number;
  best_score: number;
  bound: number | null;
  /** Which value leads: the research record or a site entry. */
  leader: "certified" | "site";
  /** Site entry id of the leader; null when the research record leads. */
  leader_id: number | null;
}

/** GET /api/spaces/targets?spaces=surface,torus&limit=&max_P= */
export interface SpaceTargetsResponse {
  generated_at: string;
  targets: SpaceTarget[];
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
}
