/**
 * The domain of a space: the problems it has, defined by parameter ranges (which pieces or containers, which P)
 * rather than by an enumerated catalogue or by its records. A space with a domain has problems without a research
 * record (status `no_record`, types.ts): any id of the domain is a problem, answered with its lower bound, open to
 * entries; its research records, where they exist, are stored as before (records.ts) and take precedence.
 *
 * The interface, for each space that has one (SPACE_DOMAINS):
 *  - `info`: what /api/spaces says about the domain: the id pattern, its fields (a list of values, or a range of
 *    integers) and how many problems it holds. The board's picker is built from it, as the polygon board's N, M and
 *    P menus are.
 *  - `bound(id)`: the lower bound of a problem of the domain (null when it has none), or undefined when the id is
 *    the space's but lies outside the domain. Ids are first read by parseSpaceId.
 *  - `sample(limit)`: at most `limit` ids of the domain in a fixed order (e.g. small P first), the order in which the
 *    volunteers' work list offered them until it was removed on 2026-10-29. Since then the volunteer client draws from
 *    the whole domain at random (apps/volunteer/src/pick.ts), and the tests use the sample to walk a domain's ids.
 */
import { polyhedraDomain } from "@polypack/polyhedra";
import { curvedDomain, sphereDomain, torusDomain } from "./piece-domains";
import { ballsDomain } from "@polypack/balls";
import { surfaceDomain } from "@polypack/surface/domain";
import type { ParsedSpaceId } from "./ids";
import type { SpaceName } from "./types";

/** One field of a domain's ids: the values it takes, or a range of integers. */
export interface SpaceDomainField {
  /** The id's field, as parseSpaceId names it ("code", "P"). */
  key: string;
  /** Its name in the board's words ("Problem", "Pieces (P)"). */
  label: string;
  /** The values, in order; absent for a range. */
  values?: readonly string[];
  /** Display names of the values (by value). */
  titles?: Readonly<Record<string, string>>;
  /** Groups of the values in a menu (by value; consecutive values share a group), e.g. the surface solids' families. */
  groups?: Readonly<Record<string, string>>;
  /** The range of integers, both ends included; absent for a list. */
  min?: number;
  max?: number;
}

/**
 * An id field that is written from two or more picker fields: polyhedra's `code` is the piece's solid code, "in" and
 * the container's ("cub" and "tet" make "cubintet"), picked in two menus. The fields it joins are in `fields` and the
 * joined one is not; it is the one the id pattern names.
 */
export interface SpaceDomainJoin {
  /** The id's field, as parseSpaceId names it ("code"). */
  key: string;
  /** The picker fields it is written from, in order ("piece", "container"). */
  parts: readonly string[];
  /** Written between the parts ("in"). */
  separator: string;
}

/** What /api/spaces says about a space's domain. */
export interface SpaceDomainInfo {
  /** The id pattern with the fields in angle brackets, e.g. "balls/<code>/<P>". */
  id: string;
  fields: readonly SpaceDomainField[];
  /** Id fields written from several of `fields` (the board offers the parts in separate menus). */
  joined?: readonly SpaceDomainJoin[];
  /** How many problems the domain holds. */
  problems: number;
}

export interface SpaceDomain {
  info: SpaceDomainInfo;
  /** The lower bound of a problem of the domain (null: none known), or undefined when `id` is outside the domain. */
  bound(id: ParsedSpaceId): { value: number; label: string } | null | undefined;
  /** At most `limit` ids of the domain, in a fixed order (that of the volunteers' work list, removed 2026-10-29). */
  sample(limit: number): string[];
}

/** The spaces whose problems are given by a domain. */
export const SPACE_DOMAINS: Partial<Record<SpaceName, SpaceDomain>> = {
  // 3D in 3D, polyhedra: every ordered pair of the 94 solids, P = 2 to 500; records for 150 pairs, through P = 100
  polyhedra: polyhedraDomain,
  // 3D in 3D, balls: 7 problems for P = 2 to 100, without records (docs/spaces/BALLS.md)
  balls: ballsDomain,
  // 2D on 3D, polyhedral surfaces: 141 solids, fold and nofold, N = 0 and 3 to 100, P = 1 to 100; records
  // for the Platonic solids with N in {0, 3, 4, 5, 6, 8} (docs/spaces/SURFACE.md)
  surface: surfaceDomain,
  curved: curvedDomain,
  sphere: sphereDomain,
  torus: torusDomain,
};

/** The largest P of a domain (its field P's range), or 0. */
export function domainMaxP(d: SpaceDomain): number {
  const f = d.info.fields.find((x) => x.key === "P");
  return f?.max ?? 0;
}

/**
 * The choice of a domain's fields with its joined fields written from their parts (`code` from `piece` and
 * `container`) where the choice lacks them.
 */
export function withJoined<V extends string | number>(
  info: SpaceDomainInfo,
  fields: Readonly<Record<string, V>>,
): Record<string, V | string> {
  const out: Record<string, V | string> = { ...fields };
  for (const j of info.joined ?? [])
    if (out[j.key] === undefined && j.parts.every((k) => out[k] !== undefined))
      out[j.key] = j.parts.map((k) => String(out[k])).join(j.separator);
  return out;
}

/**
 * The parts of a joined field's value, the other way: the split of "cubintet" at a separator such that every part is
 * a value of its field ("cub", "tet"), or null.
 */
export function splitJoined(info: SpaceDomainInfo, join: SpaceDomainJoin, value: string): Record<string, string> | null {
  const lists = join.parts.map((k) => info.fields.find((f) => f.key === k)?.values);
  if (join.parts.length !== 2 || lists.some((l) => !l)) return null;
  for (let i = value.indexOf(join.separator, 1); i !== -1; i = value.indexOf(join.separator, i + 1)) {
    const a = value.slice(0, i);
    const b = value.slice(i + join.separator.length);
    if (lists[0]!.includes(a) && lists[1]!.includes(b)) return { [join.parts[0]]: a, [join.parts[1]]: b };
  }
  return null;
}

/** The id of a choice of the domain's fields, from its pattern ("balls/<code>/<P>" with code and P). */
export function domainId(info: SpaceDomainInfo, fields: Readonly<Record<string, string | number>>): string {
  const all: Record<string, string | number> = withJoined(info, fields);
  // a joined value (the code) is the truth: the parts of a parsed id may be names, not the menus' values
  for (const j of info.joined ?? []) {
    const parts = typeof fields[j.key] === "string" ? splitJoined(info, j, fields[j.key] as string) : null;
    if (parts) Object.assign(all, parts);
  }
  return info.id.replace(/<([A-Za-z]+)>/g, (_, k: string) => String(all[k]));
}
