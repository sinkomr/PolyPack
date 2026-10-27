/**
 * The registry's metadata, over every generic method it holds (src/methods/index.ts): what the
 * board lists (title, summary), the page that documents each method, the kernel capabilities it
 * needs, and parameter defaults that agree with its schema.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ParameterSchema, clone, fillDefaults, validate } from "@polypack/solver/schema";
import { describe, expect, it } from "vitest";
import { listMethods, methodParams, methodsFor } from "../src";
import { OPERATORS } from "../src/methods/basin-operators";
import { disksKernel } from "../src/reference/disks";

const root = resolve(__dirname, "../../..");
const methods = listMethods();
/** The kernel capabilities each method needs, as docs/methods/dimensions/README.md lists them. */
const NEEDS: Record<string, string[]> = {
  penalty: [],
  mc_compress: [],
  asc: [],
  basin_hopping: [],
  shrink_repair: [],
  harden: ["shape"],
  morph: ["shape"],
  seed: [],
};

/** Paths in `value` where a schema's stated default differs from it, or where a value has no property in the schema. */
function disagreements(schema: ParameterSchema, value: unknown, path = "defaults"): string[] {
  const out: string[] = [];
  if (schema.default !== undefined && JSON.stringify(schema.default) !== JSON.stringify(value))
    out.push(`${path}: the schema's default is ${JSON.stringify(schema.default)}`);
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    for (const [key, v] of Object.entries(value)) {
      if (!Object.hasOwn(props, key)) out.push(`${path}.${key}: not in the schema`);
      else out.push(...disagreements(props[key], v, `${path}.${key}`));
    }
  }
  return out;
}

describe("the registry", () => {
  it("holds the generic methods in the order the board lists them", () => {
    expect(methods.map((m) => m.name)).toEqual(Object.keys(NEEDS));
  });

  it("gives each a board title of its own and a summary of one plain sentence", () => {
    for (const m of methods) {
      expect(m.title, m.name).toMatch(/^[A-Z][^.]*[^.\s]$/);
      expect(m.summary.length, m.name).toBeGreaterThan(20);
      expect(m.summary, m.name).toMatch(/^[A-Z].*\.$/);
      expect(m.summary.slice(0, -1), m.name).not.toMatch(/\.\s/);
    }
    expect(new Set(methods.map((m) => m.title)).size).toBe(methods.length);
  });

  it("documents each on its own page, under its board title, and in the list of methods with what it needs", () => {
    const list = readFileSync(resolve(root, "docs/methods/dimensions/README.md"), "utf8");
    for (const m of methods) {
      expect(m.doc).toBe(`docs/methods/dimensions/${m.name}.md`);
      const page = readFileSync(resolve(root, m.doc), "utf8");
      expect(page.split("\n")[0], m.doc).toMatch(new RegExp(`^# ${m.title} \\(\`${m.name}\`\\)`));
      // the README's table: "| `harden` | `shape` |", "| `penalty` | — |"
      const row = list.split("\n").find((line) => line.startsWith(`| \`${m.name}\` |`));
      expect(row, m.name).toBeDefined();
      const needs = row!.split("|")[2].trim();
      if (m.requires.length === 0) expect(needs, m.name).toMatch(/^—/);
      else expect(needs, m.name).toBe(m.requires.map((c) => `\`${c}\``).join(", "));
    }
  });

  it("offers each to the kernels that have the capabilities it needs", () => {
    for (const m of methods) expect([...m.requires], m.name).toEqual(NEEDS[m.name]);
    // the reference kernel has soft shapes and seeds: every method
    expect(methodsFor(disksKernel(3)).map((m) => m.name)).toEqual(Object.keys(NEEDS));
    const plain = Object.keys(NEEDS).filter((n) => NEEDS[n].length === 0);
    expect(methodsFor({ capabilities: [] }).map((m) => m.name)).toEqual(plain);
    expect(methodsFor({ capabilities: ["seeds", "swap"] }).map((m) => m.name)).toEqual(plain);
  });

  it("gives each defaults its schema accepts, states and refuses to extend", () => {
    for (const m of methods) {
      expect(() => validate(m.schema, m.defaults), m.name).not.toThrow();
      expect(disagreements(m.schema, m.defaults), m.name).toEqual([]);
      // every parameter has a default, and no other parameter is taken
      expect(Object.keys(m.defaults).sort(), m.name).toEqual(Object.keys(m.schema.properties ?? {}).sort());
      expect(m.schema.additionalProperties, m.name).toBe(false);
      expect(methodParams(m), m.name).toEqual(m.defaults);
      expect(fillDefaults(clone(m.defaults), {}), m.name).toEqual(m.defaults);
    }
    // basin hopping: a weight for each of its operators
    const weights = methods.find((m) => m.name === "basin_hopping")!.defaults.weights as object;
    expect(Object.keys(weights)).toEqual([...OPERATORS]);
  });
});
