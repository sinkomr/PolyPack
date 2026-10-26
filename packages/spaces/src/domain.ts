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
 *  - `sample(limit)`: at most `limit` ids of the domain, in the order in which the volunteers' work list offers them
 *    (deterministic, e.g. small P first): the work list holds the records, the problems with site entries, and this
 *    bounded sample of the others, never the whole domain.
 */
import { ballsDomain } from "@polypack/balls";
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
  /** The range of integers, both ends included; absent for a list. */
  min?: number;
  max?: number;
}

/** What /api/spaces says about a space's domain. */
export interface SpaceDomainInfo {
  /** The id pattern with the fields in angle brackets, e.g. "balls/<code>/<P>". */
  id: string;
  fields: readonly SpaceDomainField[];
  /** How many problems the domain holds. */
  problems: number;
}

export interface SpaceDomain {
  info: SpaceDomainInfo;
  /** The lower bound of a problem of the domain (null: none known), or undefined when `id` is outside the domain. */
  bound(id: ParsedSpaceId): { value: number; label: string } | null | undefined;
  /** At most `limit` ids of the domain, in the order the volunteers' work list offers them. */
  sample(limit: number): string[];
}

/** The spaces whose problems are given by a domain. */
export const SPACE_DOMAINS: Partial<Record<SpaceName, SpaceDomain>> = {
  // 3D in 3D, balls: 7 problems for P = 2 to 100, without records (docs/spaces/BALLS.md)
  balls: ballsDomain,
};

/** The largest P of a domain (its field P's range), or 0. */
export function domainMaxP(d: SpaceDomain): number {
  const f = d.info.fields.find((x) => x.key === "P");
  return f?.max ?? 0;
}

/** The id of a choice of the domain's fields, from its pattern ("balls/<code>/<P>" with code and P). */
export function domainId(info: SpaceDomainInfo, fields: Readonly<Record<string, string | number>>): string {
  return info.id.replace(/<([A-Za-z]+)>/g, (_, k: string) => String(fields[k]));
}
