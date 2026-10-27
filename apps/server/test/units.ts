/** Test helper: a body as a current client sends it, with the confirmation of the diameter units added when absent. */
export function withUnits<T>(body: T): T {
  if (typeof body !== "object" || body === null || Array.isArray(body) || "units" in body) return body;
  return { ...body, units: "diameter" };
}
