import { FOUND_WITH, FoundWith, Provenance, RunBudget } from "./protocol";

/** Largest `method_params` accepted, in bytes of its JSON text. */
export const MAX_METHOD_PARAMS_BYTES = 4096;
/** Longest `software` name accepted. */
export const MAX_SOFTWARE_LENGTH = 80;

export type ProvenanceResult = { ok: true; provenance: Provenance } | { ok: false; errors: string[] };

/** Length of a string in UTF-8 bytes (without TextEncoder, which the solver's core build lacks). */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      // a surrogate pair is one code point of four bytes
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const RUN_FIELDS = ["method", "method_params", "seed", "budget"] as const;

/**
 * Reads how a submission was found from the fields of an untrusted POST /api/submit body.
 * `methods` lists the registered PolyPack search methods. Absent fields are null.
 *
 * Without `found_with` the entry counts as found by hand, except for a legacy body that declares
 * `agent: "ai"`: how such an entry was found is unknown, so it is stored as not recorded (null).
 * `agent` itself is otherwise ignored, whatever its value.
 */
export function parseProvenance(input: Record<string, unknown>, methods: readonly string[]): ProvenanceResult {
  const errors: string[] = [];
  const o = input;
  let found: FoundWith | null;
  if (o.found_with === undefined) found = o.agent === "ai" ? null : "hand";
  else if (typeof o.found_with === "string" && (FOUND_WITH as readonly string[]).includes(o.found_with))
    found = o.found_with as FoundWith;
  else {
    errors.push(`found_with must be one of ${FOUND_WITH.map((v) => `"${v}"`).join(", ")}`);
    found = null;
  }
  const run = found === "optimizer" || found === "optimizer_edited";

  if (o.method !== undefined && (typeof o.method !== "string" || !methods.includes(o.method)))
    errors.push(`method must be the name of a registered search method: ${methods.join(", ")}`);
  else if (run && o.method === undefined) errors.push(`method is required when found_with is "${found}"`);

  if (o.method_params !== undefined) {
    if (!isPlainObject(o.method_params)) errors.push("method_params must be a JSON object");
    else if (utf8Length(JSON.stringify(o.method_params)) > MAX_METHOD_PARAMS_BYTES)
      errors.push(`method_params must be at most ${MAX_METHOD_PARAMS_BYTES} bytes as JSON`);
  }

  if (o.seed !== undefined && !(Number.isSafeInteger(o.seed) && (o.seed as number) >= 0))
    errors.push("seed must be a non-negative integer");

  if (o.budget !== undefined) {
    const b = o.budget;
    const ok =
      isPlainObject(b) &&
      Object.keys(b).length > 0 &&
      Object.keys(b).every((k) => k === "evals" || k === "time_s") &&
      (b.evals === undefined || (Number.isSafeInteger(b.evals) && (b.evals as number) > 0)) &&
      (b.time_s === undefined || (typeof b.time_s === "number" && Number.isFinite(b.time_s) && b.time_s > 0));
    if (!ok)
      errors.push("budget must be {evals?: positive integer, time_s?: positive number} with at least one of them");
  }

  if (o.software !== undefined) {
    if (typeof o.software !== "string") errors.push("software must be a string");
    else if (o.software.length > MAX_SOFTWARE_LENGTH)
      errors.push(`software must be at most ${MAX_SOFTWARE_LENGTH} characters`);
  }

  // The run fields describe a PolyPack optimizer run, and the software field the program that
  // produced the packing: one's own tool, or the client that ran a PolyPack optimizer (such as
  // "polypack-volunteer/1.0"). Each contradicts any other declaration, a packing made by hand
  // included, so it is refused rather than silently dropped.
  if (found !== null || o.found_with === undefined) {
    const stray = RUN_FIELDS.filter((k) => o[k] !== undefined);
    if (!run && stray.length)
      errors.push(
        `${stray.join(", ")} describe a PolyPack optimizer run: they need found_with "optimizer" or "optimizer_edited"`,
      );
    if (!run && found !== "external" && o.software !== undefined)
      errors.push('software needs found_with "external", "optimizer" or "optimizer_edited"');
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    provenance: {
      found_with: found,
      method: (o.method as string | undefined) ?? null,
      method_params: (o.method_params as Record<string, unknown> | undefined) ?? null,
      seed: (o.seed as number | undefined) ?? null,
      budget: (o.budget as RunBudget | undefined) ?? null,
      software: (o.software as string | undefined) ?? null,
    },
  };
}
