import type { ParameterSchema } from "@polypack/solver";

const DEGREES = 180 / Math.PI;
const angleKeys = new Set([
  "orientation",
  "latticeAngle",
  "angleRange",
  "orientationRange",
  "rotationStep",
  "containerRotation",
  "containerRotationStep",
  "rotationMagnitude",
  "alignmentTolerance",
  "angularSpeed",
]);
// One scalar scales both a position offset (piece units) and an angle offset (radians) in
// penalty.jitter and morph.jitter, so converting it to degrees would rescale the translation too.
const mixedUnitKeys = new Set(["jitter"]);
export const readable = (key: string) => key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");

/** A setting the user must correct; `control` is the field to reveal and focus. */
export class ParameterError extends Error {
  control?: HTMLElement;
}

const numeric = (schema: ParameterSchema) => schema.type === "number" || schema.type === "integer";
/** Angles are radians in the solver and degrees in the panel. */
export const isAngular = (key: string, schema: ParameterSchema) => angleKeys.has(key) && numeric(schema);

/**
 * Solver value or bound as shown in its field. Twelve significant digits hide binary noise in
 * the degree conversion. Bounds use displayBound, which never rounds inside this value.
 */
export const displayNumber = (value: number, angular: boolean) =>
  angular ? Number((value * DEGREES).toPrecision(12)) : value;

/**
 * A schema bound as the field's min (direction -1) or max (+1). The nearest twelve-digit value
 * is kept when it converts back to the bound or beyond; otherwise it moves one last digit
 * outward. Native validation then accepts everything the solver accepts, and parseNumber maps
 * the sliver between the exact and the displayed bound onto the exact bound.
 */
export function displayBound(bound: number, angular: boolean, direction: -1 | 1): number {
  if (!angular || bound === 0) return bound;
  const degrees = bound * DEGREES;
  const nearest = Number(degrees.toPrecision(12));
  if ((nearest / DEGREES - bound) * direction >= 0) return nearest;
  const lastDigit = 10 ** (Math.floor(Math.log10(Math.abs(degrees))) - 11);
  return Number((nearest + direction * lastDigit).toPrecision(12));
}

/** Label and hover description with truthful units. */
export function parameterLabel(key: string, schema: ParameterSchema): { text: string; description: string } {
  const title = schema.title ?? readable(key),
    description = schema.description ?? "";
  if (isAngular(key, schema))
    return { text: `${title} (degrees)`, description: description.replace(/radians/gi, "degrees") };
  if (mixedUnitKeys.has(key) && numeric(schema))
    return {
      text: `${title} (piece units and radians)`,
      description: `${description} One value sets both the position offset in piece units and the angle offset in radians, so it is not converted to degrees.`,
    };
  return { text: title, description };
}

/** Field text to a solver value (degrees to radians for angles), or a ParameterError. */
export function parseNumber(raw: string, schema: ParameterSchema, angular: boolean, label: string): number {
  const shown = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(shown))
    throw new ParameterError(`${label}: enter a valid number; this setting cannot be left empty.`);
  let value = angular ? shown / DEGREES : shown;
  if (angular) {
    // Displayed bounds are rounded outward, so a value at or within one means the exact bound.
    if (schema.maximum !== undefined && value > schema.maximum && shown <= displayBound(schema.maximum, true, 1))
      value = schema.maximum;
    if (schema.minimum !== undefined && value < schema.minimum && shown >= displayBound(schema.minimum, true, -1))
      value = schema.minimum;
  }
  if (schema.type === "integer" && !Number.isInteger(value))
    throw new ParameterError(`${label}: enter a whole number.`);
  if (
    (schema.minimum !== undefined && value < schema.minimum) ||
    (schema.maximum !== undefined && value > schema.maximum) ||
    (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) ||
    (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum)
  )
    throw new ParameterError(`${label}: value is outside its allowed range.`);
  return value;
}

/** Schema-driven settings. Untouched fields are omitted so exact library defaults survive. */
export function parameterForm(
  host: HTMLElement,
  schema: ParameterSchema,
  defaults: Record<string, unknown>,
): () => Record<string, unknown> {
  host.replaceChildren();
  const readers: (() => void)[] = [];
  let params: Record<string, unknown> = {};
  const put = (path: string[], value: unknown) => {
    let object = params;
    for (const key of path.slice(0, -1)) object = (object[key] ??= {}) as Record<string, unknown>;
    object[path[path.length - 1]] = value;
  };
  const fields = (parent: HTMLElement, shape: ParameterSchema, values: Record<string, unknown>, path: string[]) => {
    for (const [key, child] of Object.entries(shape.properties ?? {})) {
      // The compatibility alias is intentionally hidden in favor of maxIterations.
      if (key === "iterations" && shape.properties?.maxIterations) continue;
      const name = [...path, key];
      const value = values[key];
      if (child.type === "object" && value && typeof value === "object") {
        const group = document.createElement("fieldset"),
          legend = document.createElement("legend");
        legend.textContent = child.title ?? readable(key);
        group.append(legend);
        parent.append(group);
        fields(group, child, value as Record<string, unknown>, name);
        continue;
      }
      const label = document.createElement("label"),
        text = document.createElement("span");
      label.className = "parameter";
      const angular = isAngular(key, child);
      const described = parameterLabel(key, child);
      text.textContent = described.text;
      label.title = described.description;
      label.append(text);
      let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      let checkbox = false,
        number = false;
      if (child.enum) {
        input = document.createElement("select");
        for (const choice of child.enum) {
          const option = document.createElement("option");
          option.value = JSON.stringify(choice);
          option.textContent = readable(String(choice));
          input.append(option);
        }
        input.value = JSON.stringify(value ?? child.enum[0]);
      } else if (child.type === "object" || child.type === "array") {
        input = document.createElement("textarea");
        input.placeholder = key === "record" ? "Paste adjacent record JSON (angles in radians)" : "Optional JSON";
        input.value = value === undefined ? "" : JSON.stringify(value, null, 2);
      } else {
        input = document.createElement("input");
        checkbox = child.type === "boolean";
        number = numeric(child);
        input.type = checkbox ? "checkbox" : number ? "number" : "text";
        if (checkbox) input.checked = value === true;
        else {
          input.value = value === undefined ? "" : String(number ? displayNumber(Number(value), angular) : value);
          if (number) {
            input.step = child.type === "integer" && !angular ? "1" : "any";
            if (child.minimum !== undefined) input.min = String(displayBound(child.minimum, angular, -1));
            if (child.maximum !== undefined) input.max = String(displayBound(child.maximum, angular, 1));
          }
        }
      }
      input.id = `solve-param-${name.join("-")}`;
      // A number shown with a default may not be cleared: the run would silently use a value
      // the user cannot see. Numbers without a default stay optional.
      const required = shape.required?.includes(key) === true || (number && value !== undefined);
      if (required) input.required = true;
      input.title = label.title;
      label.append(input);
      parent.append(label);
      const read = () => (checkbox ? (input as HTMLInputElement).checked : input.value);
      const initial = read();
      readers.push(() => {
        const current = read();
        try {
          if (number && required && String(current).trim() === "") parseNumber("", child, angular, described.text);
          if (current === initial || current === "") return;
          let parsed: unknown;
          if (child.enum || child.type === "object" || child.type === "array") {
            try {
              parsed = JSON.parse(String(current));
            } catch {
              throw new ParameterError(`${described.text}: enter valid JSON.`);
            }
          } else if (number) parsed = parseNumber(String(current), child, angular, described.text);
          else parsed = current;
          put(name, parsed);
        } catch (error) {
          if (error instanceof ParameterError) error.control = input;
          throw error;
        }
      });
    }
  };
  fields(host, schema, defaults, []);
  return () => {
    params = {};
    for (const read of readers) read();
    return params;
  };
}
