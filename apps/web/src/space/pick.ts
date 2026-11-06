/**
 * The problem picker of each space: one field per part of the problem id, each offering only the
 * values the catalogue has with the fields before it. Pure and light (no geometry), so that the
 * board's space mode and the 3D on 4D viewer (src/boundary-viewer.ts) pick problems the same way.
 */
import type { SpaceDomain, SpaceDomainInfo, SpaceName } from "@polypack/spaces";
import type { FamilyScope } from "../dimension-table";
import { type FieldSpec, SPACE_FIELDS, fieldValues } from "../spaces-model";

/** The problem a space opens with when the address names none (the first listed one when it is missing). */
export const DEFAULT_PROBLEM: Record<SpaceName, string> = {
  surface: "surface/cube/fold/0/10",
  curved: "curved/-1/3/4/5",
  sphere: "sphere/4/12",
  torus: "torus/sq/5/7",
  // nine balls: without folding one cell must hold two of them, so folding gains much here
  boundary: "boundary/tesseract/ball/9",
  polyhedra: "polyhedra/cubincub/11",
  // 13 balls: twelve round a thirteenth in a ball of diameter 3 (the kissing arrangement)
  balls: "balls/ballinball/13",
  // the first problem of 4D in 4D (the other dimensions start from the same shapes, with the nearest P)
  ndim: "ndim/4/cube/cube/12",
};

/** Labels of the picker's fields, in the board's words ("Piece (N)", "Pieces (P)"). */
const PICK_LABELS: Record<string, string> = {
  solid: "Solid",
  mode: "Folding",
  N: "Piece (N)",
  K: "Curvature (K)",
  M: "Container (M)",
  family: "Torus",
  polytope: "Polytope",
  piece: "Piece",
  container: "Container",
  code: "Problem",
  P: "Pieces (P)",
};

export interface PickField {
  key: string;
  label: string;
  /** Each value, its text and, where the values come in groups (the surface solids), its group. */
  options: { value: string; text: string; group?: string }[];
  value: string;
  /** True for a field the family's scope fixes to one value (the dimension of an nD problem): it is kept, not shown. */
  hidden?: boolean;
}

/** The picker's fields of a space: the id's fields as the dimensions page lists them, and P. */
function pickSpecs(space: SpaceName): FieldSpec[] {
  const p: FieldSpec = {
    key: "P",
    at: -1,
    label: "P",
    option: (v) => v,
    cell: (v) => v,
    start: "",
  };
  return [...SPACE_FIELDS[space], p];
}

/** A field of a problem id; P is its last segment. */
function valueOf(id: string, f: FieldSpec): string {
  const parts = id.split("/");
  return f.key === "P" ? parts[parts.length - 1] : (parts[f.at] ?? "");
}

/** The fields of a problem id, keyed as the picker keys them. */
export function fieldsOfId(space: SpaceName, id: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of pickSpecs(space)) out[f.key] = valueOf(id, f);
  return out;
}

/**
 * The picker for a wish: each field offers the values that occur among the problems matching the
 * fields before it, and takes the wished value when it is offered; otherwise the field's starting
 * value, and for P the offered value nearest the wished one. The last field then fixes one
 * problem: its id, or null when the space has no problems.
 */
export function pickProblem(
  space: SpaceName,
  problems: readonly { id: string }[],
  wish: Record<string, string>,
): { fields: PickField[]; id: string | null } {
  const fields: PickField[] = [];
  let left = problems.slice();
  for (const f of pickSpecs(space)) {
    const values =
      f.key === "P"
        ? [...new Set(left.map((p) => valueOf(p.id, f)))].sort((a, b) => Number(a) - Number(b))
        : fieldValues(left, f);
    if (!values.length) return { fields, id: null };
    let value = wish[f.key];
    if (value === undefined || !values.includes(value)) {
      if (f.key === "P" && value !== undefined && Number.isFinite(Number(value))) {
        const want = Number(value);
        value = values.reduce((a, b) => (Math.abs(Number(b) - want) < Math.abs(Number(a) - want) ? b : a));
      } else value = values.includes(f.start) ? f.start : values[0];
    }
    fields.push({
      key: f.key,
      label: PICK_LABELS[f.key] ?? f.label,
      options: values.map((v) => ({
        value: v,
        text: f.key === "P" ? v : f.option(v),
        ...(f.group ? { group: f.group(v) } : {}),
      })),
      value,
    });
    left = left.filter((p) => valueOf(p.id, f) === value);
  }
  return { fields, id: left[0]?.id ?? null };
}

/**
 * The wish with the parts of its joined fields (polyhedra's `code` "cubintet" is the piece "cub" and the container
 * "tet"): the split of the joined value at its separator into values of the parts' menus. A wish that names the
 * parts already is kept as it is.
 */
function withParts(domain: SpaceDomainInfo, wish: Record<string, string>): Record<string, string> {
  const out = { ...wish };
  for (const j of domain.joined ?? []) {
    const value = wish[j.key];
    if (value === undefined || j.parts.some((k) => out[k] !== undefined) || j.parts.length !== 2) continue;
    const menus = j.parts.map((k) => domain.fields.find((f) => f.key === k)?.values);
    if (!menus[0] || !menus[1]) continue;
    for (let i = value.indexOf(j.separator, 1); i !== -1; i = value.indexOf(j.separator, i + 1)) {
      const a = value.slice(0, i);
      const b = value.slice(i + j.separator.length);
      if (menus[0].includes(a) && menus[1].includes(b)) {
        out[j.parts[0]] = a;
        out[j.parts[1]] = b;
        break;
      }
    }
  }
  return out;
}

/**
 * The picker of a space whose problems are given by a domain (packages/spaces domain.ts), as the polygon board's N, M
 * and P menus are: each field offers its domain's values (or its range of integers) whatever the records, and takes
 * the wished value when it is offered; otherwise the value of the space's starting problem, or the first, and for P
 * the offered value nearest the wished one. The id is written from the domain's pattern; a field written from several
 * menus (polyhedra's piece and container make its code) is also read from a wish that names it whole, so that an old
 * address with the code opens the same problem.
 *
 * A `scope` (dimension-table.ts) limits one field to the values of a family: the dimension of an nD problem, or the
 * polytopes of 3D on 4D. A field left with one value is marked hidden: the Problem set menu already says it.
 *
 * `menu` is the domain's hook for menus that depend on several earlier fields (SpaceDomain.menu: curved's containers and
 * P); it is passed in, so that this file keeps no geometry. A field's `unlisted` values are left out of its menu, but a
 * wished one is kept and offered while chosen. With `keep`, a wished value of the domain that the menus do not offer
 * (an id that cannot be a problem, shown with the reason) is kept too, and offered while chosen.
 */
export function pickFromDomain(
  space: SpaceName,
  domain: SpaceDomainInfo,
  wished: Record<string, string>,
  scope?: FamilyScope | null,
  menu?: SpaceDomain["menu"],
  keep = false,
): { fields: PickField[]; id: string } {
  const wish = withParts(domain, wished);
  const start = withParts(domain, fieldsOfId(space, DEFAULT_PROBLEM[space]));
  // a field whose values or range depend on an earlier field's value (boundary: the pieces and the P range of each polytope)
  // offers those of the value chosen; fields are read in order, so the field it depends on is already chosen
  const picked: Record<string, string> = {};
  const fields: PickField[] = domain.fields.map((f) => {
    const dep = f.dependent && picked[f.dependent.on] !== undefined ? f.dependent : undefined;
    const hook = menu?.(f.key, picked);
    const listed = hook?.values ?? dep?.values?.[picked[dep.on]];
    const range = hook?.range ?? dep?.ranges?.[picked[dep.on]];
    const integers = (lo: number, hi: number) => Array.from({ length: Math.max(hi - lo + 1, 0) }, (_, i) => String(lo + i));
    // every value the field's ids take, whatever the earlier fields
    const whole = f.values ?? (f.min !== undefined && f.max !== undefined ? integers(f.min, f.max) : []);
    let values = listed ? [...listed] : range ? integers(range[0], range[1]) : whole;
    const scoped = !!scope && f.key === scope.field;
    if (scope && scoped) values = values.filter((v) => scope.values.includes(v));
    let value = wish[f.key];
    // an unlisted value, or with `keep` any value of the domain, stays the chosen one while the menu would not offer it
    const kept = value !== undefined && !scoped && (f.unlisted?.includes(value) || (keep && whole.includes(value)));
    if (kept && !values.includes(value!)) values = whole.filter((v) => v === value || values.includes(v));
    if (value === undefined || !values.includes(value)) {
      if (f.values === undefined && value !== undefined && Number.isFinite(Number(value)) && values.length) {
        const want = Number(value);
        value = values.reduce((a, b) => (Math.abs(Number(b) - want) < Math.abs(Number(a) - want) ? b : a));
      } else value = values.includes(start[f.key]) ? start[f.key] : values[0];
    }
    picked[f.key] = value;
    return {
      key: f.key,
      label: PICK_LABELS[f.key] ?? f.label,
      options: values.filter((v) => v === value || !f.unlisted?.includes(v)).map((v) => ({ value: v, text: f.titles?.[v] ?? v, ...(f.groups?.[v] ? { group: f.groups[v] } : {}) })),
      value,
      ...(scoped && values.length === 1 ? { hidden: true } : {}),
    };
  });
  const chosen: Record<string, string> = Object.fromEntries(fields.map((f) => [f.key, f.value]));
  for (const j of domain.joined ?? []) chosen[j.key] = j.parts.map((k) => chosen[k]).join(j.separator);
  return { fields, id: domain.id.replace(/<([A-Za-z]+)>/g, (_, k: string) => chosen[k] ?? "") };
}
