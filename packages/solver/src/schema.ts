export interface ParameterSchema {
  title?: string;
  description?: string;
  default?: unknown;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  type: "object" | "array" | "number" | "integer" | "string" | "boolean";
  properties?: Record<string, ParameterSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: ParameterSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

const keywords = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "title",
  "description",
  "default",
  "exclusiveMinimum",
  "exclusiveMaximum",
]);
export function checkSchema(schema: ParameterSchema): void {
  for (const key of Object.keys(schema))
    if (!keywords.has(key)) throw new Error(`unsupported JSON Schema keyword: ${key}`);
  if (!["object", "array", "number", "integer", "string", "boolean"].includes(schema.type))
    throw new Error("unsupported schema type");
  for (const child of Object.values(schema.properties ?? {})) checkSchema(child);
  if (schema.items) checkSchema(schema.items);
}

export function validate(schema: ParameterSchema, value: unknown, path = "params"): void {
  const fail = (reason: string): never => {
    throw new Error(`${path}: ${reason}`);
  };
  if (schema.enum && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) fail("not in enum");
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected object");
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(obj, key)) fail(`missing ${key}`);
    for (const [key, v] of Object.entries(obj)) {
      if (schema.properties && Object.hasOwn(schema.properties, key))
        validate(schema.properties![key], v, `${path}.${key}`);
      else if (schema.additionalProperties === false) fail(`unknown parameter ${key}`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) fail("expected array");
    const array = value as unknown[];
    if (schema.minItems !== undefined && array.length < schema.minItems) fail("too few items");
    if (schema.maxItems !== undefined && array.length > schema.maxItems) fail("too many items");
    if (schema.items) array.forEach((v, i) => validate(schema.items!, v, `${path}[${i}]`));
  } else if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) fail("expected finite number");
    const n = value as number;
    if (schema.type === "integer" && !Number.isInteger(n)) fail("expected integer");
    if (schema.minimum !== undefined && n < schema.minimum) fail("below minimum");
    if (schema.exclusiveMinimum !== undefined && n <= schema.exclusiveMinimum) fail("not above exclusive minimum");
    if (schema.exclusiveMaximum !== undefined && n >= schema.exclusiveMaximum) fail("not below exclusive maximum");
    if (schema.maximum !== undefined && n > schema.maximum) fail("above maximum");
  } else if (typeof value !== schema.type) fail(`expected ${schema.type}`);
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function fillDefaults(
  defaults: Record<string, unknown>,
  supplied: Record<string, unknown>,
): Record<string, unknown> {
  const entries = new Map(Object.entries(defaults));
  for (const [key, value] of Object.entries(supplied)) {
    if (value === undefined) continue;
    const base = entries.get(key);
    entries.set(
      key,
      base &&
        value &&
        typeof base === "object" &&
        typeof value === "object" &&
        !Array.isArray(base) &&
        !Array.isArray(value)
        ? fillDefaults(base as Record<string, unknown>, value as Record<string, unknown>)
        : value,
    );
  }
  return Object.fromEntries(entries);
}
