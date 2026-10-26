/**
 * The catalogue of a space: its research records (data/<space>/records.json) reduced to what the
 * site needs, one compact entry per problem, with the configuration kept as JSON text. Pure: the
 * caller reads the file (see load.ts) and passes the parsed JSON, which can then be dropped.
 *
 * A space whose records file keeps the configurations apart (polyhedra: data/polyhedra/configs/
 * <code>.jsonl, one file per problem, one line per P, which each record's `config_at` locates)
 * has entries without configuration text (`configApart`, `configAt`); load.ts then gives the
 * catalogue a `loadConfig` that reads one on demand.
 */
import { PROBLEM_ORDER } from "@polypack/polyhedra/catalogue";
import {
  BOUNDARY_PIECES,
  BOUNDARY_POLYTOPES,
  ParsedSpaceId,
  SURFACE_MODES,
  SURFACE_SOLIDS,
  TORUS_FAMILIES,
  parseSpaceId,
} from "./ids";
import { CertifiedStatus, CertifiedValue, SiteBest, SpaceName, SpaceProblemExtra, SpaceProblemSummary } from "./types";
import { parseSpaceConfig } from "./validate";

/** One problem of a catalogue. */
export interface SpaceProblemEntry {
  space: SpaceName;
  id: string;
  fields: Record<string, string | number>;
  P: number;
  /** The research record's status. */
  status: CertifiedStatus;
  /** The research record's certified value; null for infeasible problems. */
  certified: CertifiedValue | null;
  bound: { value: number; label: string } | null;
  /** Why the problem takes no submissions (proven or infeasible); null when it is open. */
  closed_reason: string | null;
  /**
   * The research record's configuration in the space's format, as JSON text; null when there is
   * none (infeasible). Its stated size is score_cert for curved, sphere, boundary and polyhedra,
   * and score_float for surface and torus, whose certificates shrink the pieces instead
   * (score_cert = size / (1 - eps)).
   */
  config: string | null;
  /** True when the configuration is kept in a file of its own and read on demand (SpaceCatalogue.loadConfig). */
  configApart?: boolean;
  /** Where it is in that file: the byte offset and length of its line (the record's config_at). */
  configAt?: readonly [number, number];
  /** The nofold comparison (boundary only); absent for the other spaces. */
  extra?: SpaceProblemExtra;
}

export interface SpaceCatalogue {
  space: SpaceName;
  /** The records file's `generated` field. */
  generated: string | null;
  problems: SpaceProblemEntry[];
  byId: Map<string, SpaceProblemEntry>;
  maxP: number;
  /** Records left out, with the reason (none for the shipped data; a test checks it). */
  skipped: string[];
  /**
   * Reads the research configuration of an entry whose configuration is kept apart (configApart),
   * checked as the catalogue checks the others; null when it cannot be read. Set by load.ts.
   */
  loadConfig?: (entry: SpaceProblemEntry) => Promise<string | null>;
}

/** The research configuration of an entry, as JSON text: kept in the entry, or read on demand. */
export async function entryConfig(cat: SpaceCatalogue, entry: SpaceProblemEntry): Promise<string | null> {
  if (entry.config !== null || !entry.configApart) return entry.config;
  return cat.loadConfig ? cat.loadConfig(entry) : null;
}

/**
 * Where a configuration kept apart lives: the file configs/<file>.jsonl below the space's data
 * folder, and the byte offset and length of its line there. For polyhedra the file is the
 * problem's code. The file name comes from a catalogue entry (a known code), never from a request.
 */
export function configLocation(entry: Pick<SpaceProblemEntry, "fields" | "P" | "configAt">): {
  file: string;
  offset: number;
  length: number;
} {
  const [offset, length] = entry.configAt ?? [0, 0];
  return { file: String(entry.fields.code), offset, length };
}

/** Longest line of a configuration kept apart that is read (a P = 100 configuration is about 20 kB). */
export const CONFIG_LINE_MAX = 1_000_000;

/** Spaces whose records file may keep the configurations apart. */
const CONFIGS_APART: readonly SpaceName[] = ["polyhedra"];

/** The loaded catalogues; a space whose records file is missing is absent. */
export type SpacesIndex = Partial<Record<SpaceName, SpaceCatalogue>>;

type Rec = Record<string, unknown>;
const isObject = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** The record's configuration in the space's submission format. */
function recordConfig(space: SpaceName, r: Rec): unknown {
  switch (space) {
    case "surface":
      return { s: r.s, pieces: r.pieces };
    case "curved":
    case "sphere":
    case "boundary":
      return r.config;
    case "torus":
      return r.configuration;
    case "polyhedra":
      return r.config;
  }
}

/** The record's own fields that the id must agree with. */
function recordFields(space: SpaceName, r: Rec): Record<string, unknown> {
  switch (space) {
    case "surface":
      return { solid: r.solid, mode: r.mode, N: r.N, P: r.P };
    case "curved":
      return { K: r.K, N: r.N, M: r.M, P: r.P };
    case "sphere":
      return { N: r.N, P: r.P };
    case "torus":
      return { family: r.family, N: r.N, P: r.P };
    case "boundary":
      return { polytope: r.polytope, piece: r.piece, P: r.P };
    case "polyhedra":
      return { code: r.code, piece: r.piece, container: r.container, P: r.P };
  }
}

/**
 * The record's nofold comparison (boundary): `nofold` {value, source} and `fold_gain`, each kept
 * only when it is well formed; undefined for the other spaces.
 */
function extraOf(space: SpaceName, r: Rec): SpaceProblemExtra | undefined {
  if (space !== "boundary") return undefined;
  const n = isObject(r.nofold) ? r.nofold : null;
  const value = n && typeof n.value === "number" && Number.isFinite(n.value) && n.value > 0 ? n.value : null;
  const gain = typeof r.fold_gain === "number" && Number.isFinite(r.fold_gain) ? r.fold_gain : null;
  return {
    nofold: value === null ? null : { value, label: typeof n!.source === "string" ? n!.source : "" },
    fold_gain: gain,
  };
}

/** The bound as {value, label}: from `value` (surface, sphere, torus) or `lower` (curved). */
function boundOf(space: SpaceName, b: unknown): { value: number; label: string } | null {
  if (!isObject(b)) return null;
  const value = typeof b.value === "number" ? b.value : typeof b.lower === "number" ? b.lower : NaN;
  if (!Number.isFinite(value)) return null;
  const label = typeof b.label === "string" ? b.label : "";
  const kind = typeof b.kind === "string" ? b.kind.replace(/[-_]/g, " ") : "";
  // surface and curved labels carry only the kind of claim ([CALC], rigorous); their `kind` says
  // which bound it is: one word ("area", "one piece") or a sentence of its own
  if ((space === "surface" || space === "curved" || space === "polyhedra") && kind) {
    const what = /^[a-z]+( piece)?$/.test(kind) ? `${kind} bound` : kind;
    return { value, label: label ? `${what}; ${label}` : what };
  }
  return { value, label: label || kind };
}

function closedReason(space: SpaceName, r: Rec, status: CertifiedStatus, id: ParsedSpaceId): string | null {
  if (status === "proven") {
    const lit = isObject(r.literature) ? r.literature : {};
    const proof = Array.isArray(lit.proof) ? lit.proof.filter((p) => typeof p === "string").join("; ") : "";
    // torus records list their sources; the entry with a `proof` proves the exact case
    const listed = Array.isArray(r.literature)
      ? r.literature.filter(isObject).find((e) => typeof e.proof === "string" && typeof e.short === "string")
      : undefined;
    const cited = listed ? `${listed.short}${typeof listed.doi === "string" ? `, doi:${listed.doi}` : ""}` : "";
    const source = proof || cited || (typeof lit.source === "string" ? lit.source : "a published proof");
    return `its optimum ${r.display} is proven (${source})`;
  }
  if (status === "infeasible") {
    const proof = typeof r.proof === "string" ? ` (proof: ${r.proof})` : "";
    const where = space === "curved" ? ` at K = ${id.fields.K}` : "";
    return `no packing exists: ${id.P} pieces do not fit in any container of this shape${where}${proof}`;
  }
  return null;
}

/**
 * The order of each space's named fields, kept per space: another space's field of the same name
 * (polyhedra's piece, say) is not sorted by this one's list. Fields not named here sort by number.
 */
const ORDER: Partial<Record<SpaceName, Record<string, readonly string[]>>> = {
  surface: { solid: SURFACE_SOLIDS, mode: SURFACE_MODES },
  torus: { family: TORUS_FAMILIES },
  boundary: { polytope: BOUNDARY_POLYTOPES, piece: BOUNDARY_PIECES },
  polyhedra: { code: PROBLEM_ORDER },
};
/** Field order of the listing. */
const SORT_KEYS: Record<SpaceName, string[]> = {
  surface: ["solid", "mode", "N", "P"],
  curved: ["K", "N", "M", "P"],
  sphere: ["N", "P"],
  torus: ["family", "N", "P"],
  boundary: ["polytope", "piece", "P"],
  polyhedra: ["code", "P"],
};

export function compareSpaceProblems(a: SpaceProblemEntry, b: SpaceProblemEntry): number {
  for (const k of SORT_KEYS[a.space]) {
    const x = a.fields[k];
    const y = b.fields[k];
    const order = ORDER[a.space]?.[k];
    const d = order ? order.indexOf(String(x)) - order.indexOf(String(y)) : Number(x) - Number(y);
    if (d) return d;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The catalogue of one space from its parsed records file. A record is left out (with a reason in
 * `skipped`) when its id does not match its fields, its status is unknown, or its configuration
 * is not one of the space's format with P pieces.
 */
export function buildSpaceCatalogue(space: SpaceName, file: unknown): SpaceCatalogue {
  const skipped: string[] = [];
  const problems: SpaceProblemEntry[] = [];
  const records = isObject(file) && Array.isArray(file.records) ? file.records : null;
  if (!records) skipped.push("the file has no records list");
  for (const [k, r] of (records ?? []).entries()) {
    if (!isObject(r)) {
      skipped.push(`record ${k} is not an object`);
      continue;
    }
    const rawId = space === "torus" ? (r.problem ?? r.id) : r.id;
    const id = parseSpaceId(space, rawId);
    if (typeof id === "string") {
      skipped.push(`record ${k}: ${id}`);
      continue;
    }
    const own = recordFields(space, r);
    const mismatch = Object.keys(own).find((f) => own[f] !== id.fields[f]);
    if (mismatch) {
      skipped.push(`${id.id}: the id's ${mismatch} differs from the record's (${String(own[mismatch])})`);
      continue;
    }
    const status = r.status;
    if (status !== "best_known" && status !== "proven" && status !== "infeasible") {
      skipped.push(`${id.id}: unknown status ${String(status)}`);
      continue;
    }
    let certified: CertifiedValue | null = null;
    let config: string | null = null;
    let configApart = false;
    let configAt: [number, number] | null = null;
    if (status !== "infeasible") {
      if (typeof r.score_cert !== "number" || !Number.isFinite(r.score_cert) || typeof r.display !== "string") {
        skipped.push(`${id.id}: score_cert or display is missing`);
        continue;
      }
      const raw = recordConfig(space, r);
      if (raw === undefined && CONFIGS_APART.includes(space)) {
        const at = r.config_at;
        if (
          !Array.isArray(at) ||
          at.length !== 2 ||
          !Number.isSafeInteger(at[0]) ||
          at[0] < 0 ||
          !Number.isSafeInteger(at[1]) ||
          at[1] < 1 ||
          at[1] > CONFIG_LINE_MAX
        ) {
          skipped.push(`${id.id}: no configuration, and no config_at [offset, length] of one kept apart`);
          continue;
        }
        configApart = true;
        configAt = [at[0], at[1]];
      } else {
        const parsed = parseSpaceConfig(id, raw);
        if (!parsed.ok) {
          skipped.push(`${id.id}: ${parsed.errors.join("; ")}`);
          continue;
        }
        config = JSON.stringify(parsed.config);
      }
      certified = { score: r.score_cert, display: r.display, status };
    }
    const extra = extraOf(space, r);
    problems.push({
      space,
      id: id.id,
      fields: id.fields,
      P: id.P,
      status,
      certified,
      bound: boundOf(space, r.bound),
      closed_reason: closedReason(space, r, status, id),
      config,
      ...(configApart ? { configApart, configAt: configAt! } : {}),
      ...(extra ? { extra } : {}),
    });
  }
  problems.sort(compareSpaceProblems);
  const byId = new Map<string, SpaceProblemEntry>();
  for (const p of problems) {
    if (byId.has(p.id)) skipped.push(`${p.id}: listed twice; the first is kept`);
    else byId.set(p.id, p);
  }
  const unique = problems.filter((p) => byId.get(p.id) === p);
  return {
    space,
    generated: isObject(file) && typeof file.generated === "string" ? file.generated : null,
    problems: unique,
    byId,
    maxP: unique.reduce((m, p) => Math.max(m, p.P), 0),
    skipped,
  };
}

/** True when a problem takes submissions: its research record is neither proven nor infeasible. */
export function acceptsSubmissions(p: SpaceProblemEntry): boolean {
  return p.closed_reason === null;
}

/**
 * A problem as a listing shows it, with the leading site entry (none for closed problems).
 * best_score is the smaller of the certified and the site value.
 */
export function spaceProblemSummary(p: SpaceProblemEntry, site: SiteBest | null): SpaceProblemSummary {
  const open = acceptsSubmissions(p);
  const siteBest = open ? site : null;
  const values = [p.certified?.score, siteBest?.score].filter((v): v is number => typeof v === "number");
  return {
    space: p.space,
    id: p.id,
    fields: p.fields,
    P: p.P,
    status: p.status,
    certified: p.certified,
    bound: p.bound,
    site_best: siteBest,
    best_score: values.length ? Math.min(...values) : null,
    accepts_submissions: open,
    closed_reason: p.closed_reason,
    ...(p.extra ? { extra: p.extra } : {}),
  };
}
