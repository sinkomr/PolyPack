/**
 * Which problem to search next: one drawn uniformly at random from every problem this client may search, with or
 * without a record. Pure: the history, the clock and the random source are passed in. (Before 0.3.0 the client drew
 * from the server's ranked work lists, GET /api/targets and /api/spaces/targets, which were removed on 2026-10-29.)
 *
 * The problems are the flat ones, N and M a circle (0) or 3 to 100 sides and P from 1 to 500, narrowed by --N, --M and
 * --max-P; and with --dimensions, those of the kinds named, narrowed by --max-P. Each kind's problems are the product
 * of its id's fields (a list of values, or a range of integers): packages/spaces' domains, and boundary's catalogue.
 * A draw takes a kind in proportion to the size of its product, then each field uniformly; a draw outside the kind's
 * domain starts again from the kind. So every problem is as likely as any other.
 *
 * A problem this machine searched in the last week (RECENT_MS) is drawn again, at most RECENT_TRIES - 1 times: among
 * millions of problems that hardly happens, and when the filters leave few the client searches one again rather than
 * wait. Problems to skip (closed ones, those that could not be read, those other slots are searching) are never drawn.
 */
import { MAX_PIECES, MAX_SIDES } from "@polypack/geometry";
import {
  BOUNDARY_PIECES,
  BOUNDARY_POLYTOPES,
  SPACE_DOMAINS,
  type SpaceDomain,
  type SpaceName,
  domainId,
  parseSpaceId as parseIdOf,
} from "@polypack/spaces";
import { problemKey } from "./format";
import { parseSpaceId } from "./spaces/model";
import { type AnyHistoryLine, historyKey } from "./state";
import type { Problem } from "./types";

export const RECENT_MS = 7 * 24 * 3600_000;
/** Draws in a row that may fall on problems searched here recently before one of them is searched again. */
export const RECENT_TRIES = 20;
/** Draws in a row that may fall outside a domain or on problems to skip before the draw gives up. */
export const DRAW_TRIES = 1000;
/** The largest P of boundary's catalogue (docs/spaces/BOUNDARY.md: P = 1..16 for balls and for cubes). */
export const BOUNDARY_CATALOGUE_MAX_P = 16;

/** The shape codes: 0 (a circle) and 3 to MAX_SIDES. */
export const SHAPE_CODES: readonly number[] = [0, ...Array.from({ length: MAX_SIDES - 2 }, (_, i) => i + 3)];

/** When this machine last searched a problem. */
export interface Recent {
  time: number;
}

/**
 * Records one finished search. A search cut short by a signal or by --hours does not count: the problem may come
 * back. One that failed does count, so that a failure is not repeated at once.
 *
 * A dry run's search counts for later dry runs only: a real run must still search the problem and submit, and the
 * dry run's best packing, kept in best/, is offered then.
 */
export function noteSearch(recent: Map<string, Recent>, line: AnyHistoryLine, dryRun = false): void {
  if (line.stopped === "aborted" || line.stopped === "interrupted" || line.stopped === "crashed") return;
  // lines written before `dry_run` was recorded say so in their decision
  if (!dryRun && (line.dry_run === true || line.decision === "dry run: would submit")) return;
  const time = Date.parse(line.time);
  if (!Number.isFinite(time)) return;
  const key = historyKey(line);
  const old = recent.get(key);
  if (old && old.time > time) return;
  recent.set(key, { time });
}

export function recentFromHistory(lines: Iterable<AnyHistoryLine>, dryRun = false): Map<string, Recent> {
  const recent = new Map<string, Recent>();
  for (const line of lines) noteSearch(recent, line, dryRun);
  return recent;
}

/** Forgets searches older than RECENT_MS, which no longer count. */
export function pruneRecent(recent: Map<string, Recent>, now: number): void {
  for (const [key, r] of recent) if (now - r.time >= RECENT_MS) recent.delete(key);
}

/** True when this machine searched the problem (its problemKey, or a space problem's id) within RECENT_MS. */
export function searchedRecently(key: string, recent: ReadonlyMap<string, Recent>, now: number): boolean {
  const r = recent.get(key);
  return !!r && now - r.time < RECENT_MS;
}

/** A drawn problem: a flat one, or one of a space by its id. */
export type Drawn = { kind: "polygon"; problem: Problem } | { kind: "space"; space: SpaceName; id: string };

/** The key of a drawn problem in the history, the skips and the problems being searched. */
export const drawnKey = (d: Drawn) => (d.kind === "polygon" ? problemKey(d.problem) : d.id);

/** One field of a kind's ids: a list of values, or the integers from min to max. */
export interface KindField {
  key: string;
  values?: readonly string[];
  min?: number;
  max?: number;
}

/** One kind of problem a draw covers. */
export interface Kind {
  /** "flat", or the space. */
  name: "flat" | SpaceName;
  /** The size of the product of its fields, after the filters: what the kind is drawn in proportion to. */
  size: number;
  /** A problem of the product, each field drawn uniformly; null when it falls outside the kind's domain. */
  draw(random: () => number): Drawn | null;
}

const pick = <T>(list: readonly T[], random: () => number): T =>
  list[Math.min(list.length - 1, Math.floor(random() * list.length))];
const between = (min: number, max: number, random: () => number) =>
  min + Math.min(max - min, Math.floor(random() * (max - min + 1)));
const fieldSize = (f: KindField) => (f.values ? f.values.length : Math.max(0, f.max! - f.min! + 1));

/** The flat problems that pass --N, --M and --max-P (every shape and P up to MAX_PIECES without them). */
export function flatKind(f: { N: readonly number[] | null; M: readonly number[] | null; maxP: number | null }): Kind {
  const Ns = f.N ?? SHAPE_CODES;
  const Ms = f.M ?? SHAPE_CODES;
  const maxP = Math.min(MAX_PIECES, f.maxP ?? MAX_PIECES);
  return {
    name: "flat",
    size: Ns.length * Ms.length * maxP,
    draw: (random) => ({
      kind: "polygon",
      problem: { N: pick(Ns, random), M: pick(Ms, random), P: between(1, maxP, random) },
    }),
  };
}

/**
 * The fields of a space's problems: its domain's, or for boundary (which has none) its catalogue's polytope, piece and
 * P. --max-P cuts the range of P.
 */
export function spaceFields(space: SpaceName, maxP: number | null): KindField[] {
  const domain = SPACE_DOMAINS[space];
  const fields: KindField[] = domain
    ? domain.info.fields.map((f) => ({ key: f.key, values: f.values, min: f.min, max: f.max }))
    : [
        { key: "polytope", values: BOUNDARY_POLYTOPES },
        { key: "piece", values: BOUNDARY_PIECES },
        { key: "P", min: 1, max: BOUNDARY_CATALOGUE_MAX_P },
      ];
  return fields.map((f) => (f.key === "P" && maxP !== null ? { ...f, max: Math.min(f.max!, maxP) } : f));
}

/** True when `id` is a problem of the space's domain (every id of the product, for boundary) that this client searches. */
function inSpace(space: SpaceName, domain: SpaceDomain | undefined, id: string): boolean {
  if (!parseSpaceId(id)) return false;
  if (!domain) return true;
  const parsed = parseIdOf(space, id);
  return typeof parsed !== "string" && domain.bound(parsed) !== undefined;
}

/**
 * The fields of a space whose domain has fields that depend on another (nD in nD: the shapes and the range of P of each
 * dimension), one entry per value of the field they depend on: that value's fields. Null for the other spaces.
 */
function dependentGroups(
  space: SpaceName,
  fields: KindField[],
): { on: string; groups: { value: string; fields: KindField[] }[] } | null {
  const domain = SPACE_DOMAINS[space];
  const dep = domain?.info.fields.find((f) => f.dependent);
  if (!domain || !dep) return null;
  const on = dep.dependent!.on;
  const onField = fields.find((f) => f.key === on);
  if (!onField?.values) return null;
  const groups = onField.values.map((value) => ({
    value,
    fields: fields
      .filter((f) => f.key !== on)
      .map((f) => {
        const info = domain.info.fields.find((x) => x.key === f.key)!;
        const values = info.dependent?.values?.[value];
        const range = info.dependent?.ranges?.[value];
        if (values) return { key: f.key, values };
        if (range)
          return {
            key: f.key,
            min: f.min === undefined ? range[0] : Math.max(range[0], f.min),
            max: f.max === undefined ? range[1] : Math.min(range[1], f.max),
          };
        return f;
      }),
  }));
  return { on, groups };
}

/** The problems of one space, after --max-P. */
export function spaceKind(space: SpaceName, maxP: number | null): Kind {
  const domain = SPACE_DOMAINS[space];
  const fields = spaceFields(space, maxP);
  const dependent = dependentGroups(space, fields);
  if (domain && dependent) {
    // every problem as likely as any other: a value of the field the others depend on in proportion to its problems
    const sizes = dependent.groups.map((g) => g.fields.reduce((n, f) => n * fieldSize(f), 1));
    const total = sizes.reduce((a, b) => a + b, 0);
    return {
      name: space,
      size: total,
      draw: (random) => {
        let r = random() * total;
        let at = sizes.length - 1;
        for (let i = 0; i < sizes.length; i++) {
          if (r < sizes[i]) {
            at = i;
            break;
          }
          r -= sizes[i];
        }
        const g = dependent.groups[at];
        const chosen: Record<string, string | number> = { [dependent.on]: g.value };
        for (const f of g.fields) chosen[f.key] = f.values ? pick(f.values, random) : between(f.min!, f.max!, random);
        const id = domainId(domain.info, chosen);
        return inSpace(space, domain, id) ? { kind: "space", space, id } : null;
      },
    };
  }
  const size = fields.reduce((n, f) => n * fieldSize(f), 1);
  return {
    name: space,
    size,
    draw: (random) => {
      const chosen: Record<string, string | number> = {};
      for (const f of fields) chosen[f.key] = f.values ? pick(f.values, random) : between(f.min!, f.max!, random);
      const id = domain ? domainId(domain.info, chosen) : `boundary/${chosen.polytope}/${chosen.piece}/${chosen.P}`;
      return inSpace(space, domain, id) ? { kind: "space", space, id } : null;
    },
  };
}

/** The kinds a client draws from: flat unless --only-dimensions, and the kinds of --dimensions; those left empty dropped. */
export function kindsFor(o: {
  N: readonly number[] | null;
  M: readonly number[] | null;
  maxP: number | null;
  spaces: readonly SpaceName[] | null;
  onlySpaces: boolean;
}): Kind[] {
  const kinds = [...(o.onlySpaces ? [] : [flatKind(o)]), ...(o.spaces ?? []).map((space) => spaceKind(space, o.maxP))];
  return kinds.filter((k) => k.size > 0);
}

/** One problem of the kinds, every problem equally likely; null when no draw of DRAW_TRIES falls in a domain. */
export function drawOnce(kinds: readonly Kind[], random: () => number): Drawn | null {
  const total = kinds.reduce((n, k) => n + k.size, 0);
  if (!(total > 0)) return null;
  for (let i = 0; i < DRAW_TRIES; i++) {
    let r = random() * total;
    let kind = kinds[kinds.length - 1];
    for (const k of kinds) {
      if (r < k.size) {
        kind = k;
        break;
      }
      r -= k.size;
    }
    const d = kind.draw(random);
    if (d) return d;
  }
  return null;
}

/**
 * The next problem to search: a uniform draw (drawOnce) that is not in `skip`, and not searched here within RECENT_MS
 * unless RECENT_TRIES draws in a row were. Null when DRAW_TRIES draws found nothing but problems to skip.
 */
export function drawProblem(
  kinds: readonly Kind[],
  o: { recent: ReadonlyMap<string, Recent>; skip: ReadonlySet<string>; now: number; random: () => number },
): Drawn | null {
  let recentInARow = 0;
  for (let i = 0; i < DRAW_TRIES; i++) {
    const d = drawOnce(kinds, o.random);
    if (!d) return null;
    const key = drawnKey(d);
    if (o.skip.has(key)) continue;
    if (searchedRecently(key, o.recent, o.now) && ++recentInARow < RECENT_TRIES) continue;
    return d;
  }
  return null;
}
