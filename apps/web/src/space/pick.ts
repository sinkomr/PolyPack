/**
 * The problem picker of each space: one field per part of the problem id, each offering only the
 * values the catalogue has with the fields before it. Pure and light (no geometry), so that the
 * board's space mode and the 3D on 4D viewer (src/boundary-viewer.ts) pick problems the same way.
 */
import type { SpaceName } from "@polypack/spaces";
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
  // 13 balls: twelve round one, and the best known packing has room to spare
  balls: "balls/ballinball/13",
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
  code: "Problem",
  P: "Pieces (P)",
};

export interface PickField {
  key: string;
  label: string;
  options: { value: string; text: string }[];
  value: string;
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
      options: values.map((v) => ({ value: v, text: f.key === "P" ? v : f.option(v) })),
      value,
    });
    left = left.filter((p) => valueOf(p.id, f) === value);
  }
  return { fields, id: left[0]?.id ?? null };
}
