import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "@polypack/solver";
import type { ParameterSchema } from "@polypack/solver";
import { ParameterError, displayBound, displayNumber, isAngular, parameterForm, parameterLabel, parseNumber } from "../src/solve-params";

// Vitest runs in Node without a DOM. This is the small part of an element that the form uses.
class FakeElement {
  children: FakeElement[] = [];
  value = "";
  checked = false;
  type = "";
  id = "";
  title = "";
  className = "";
  textContent = "";
  placeholder = "";
  step = "";
  min = "";
  max = "";
  required = false;
  constructor(public tagName: string) {}
  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }
  replaceChildren() {
    this.children = [];
  }
  find(id: string): FakeElement {
    const all = (e: FakeElement): FakeElement[] => [e, ...e.children.flatMap(all)];
    const found = all(this).find((e) => e.id === id);
    if (!found) throw new Error(`no field ${id}`);
    return found;
  }
  inputs(): FakeElement[] {
    const all = (e: FakeElement): FakeElement[] => [e, ...e.children.flatMap(all)];
    return all(this).filter((e) => e.tagName === "input");
  }
}
function form(method: string) {
  const definition = registry.list().find((m) => m.name === method)!;
  const host = new FakeElement("div");
  const read = parameterForm(host as unknown as HTMLElement, definition.schema, definition.defaults);
  return { host, read, definition };
}
const field = (schema: Partial<ParameterSchema>): ParameterSchema => ({ type: "number", ...schema });
const DEGREES = 180 / Math.PI;

beforeEach(() => vi.stubGlobal("document", { createElement: (tag: string) => new FakeElement(tag) }));
afterEach(() => vi.unstubAllGlobals());

describe("solver settings form", () => {
  it("omits every untouched setting so exact library defaults survive", () => {
    for (const method of registry.list()) expect(form(method.name).read(), method.name).toEqual({});
  });

  it("shows angles in degrees and converts an edited angle to radians exactly once", () => {
    const { host, read } = form("mc_compress");
    const rotation = host.find("solve-param-containerRotation");
    expect(Number(rotation.value)).toBeCloseTo(0.1 * DEGREES, 9);
    expect(Number(rotation.max)).toBe(180);
    rotation.value = "10";
    expect(read()).toEqual({ containerRotation: 10 / DEGREES });
    expect((read().containerRotation as number) * 18).toBeCloseTo(Math.PI, 12);
    const { host: bh, read: readBh } = form("basin_hopping");
    expect(bh.find("solve-param-rotationMagnitude").value).toBe("90");
    bh.find("solve-param-rotationMagnitude").value = "45";
    expect(readBh()).toEqual({ rotationMagnitude: Math.PI / 4 });
  });

  it("keeps every default and bound inside the field's own min and max", () => {
    for (const method of registry.list())
      for (const input of form(method.name).host.inputs()) {
        if (input.type !== "number" || input.value === "") continue;
        if (input.min !== "") expect(Number(input.value), input.id).toBeGreaterThanOrEqual(Number(input.min));
        if (input.max !== "") expect(Number(input.value), input.id).toBeLessThanOrEqual(Number(input.max));
      }
    // The reviewed case: 0.1 rad is 5.729577951308232 degrees; value and max now round alike.
    const tolerance = form("basin_hopping").host.find("solve-param-alignmentTolerance");
    expect(tolerance.max).toBe("5.72957795131");
    expect(displayNumber(0.1, true)).toBe(5.72957795131);
    expect(tolerance.max.replace(/^\d+\./, "").length).toBeLessThanOrEqual(12);
  });

  it("maps a value typed at a rounded displayed bound to the exact solver bound", () => {
    const { host, read, definition } = form("basin_hopping");
    const schema = definition.schema.properties!.alignmentTolerance;
    const input = host.find("solve-param-alignmentTolerance");
    expect(5.72957795131 / DEGREES).toBeGreaterThan(schema.maximum!);
    input.value = input.max;
    expect(read()).toEqual({ alignmentTolerance: schema.maximum });
    input.value = "5.73";
    expect(() => read()).toThrow(/outside its allowed range/);
    const step = form("asc");
    const min = step.host.find("solve-param-rotationStep");
    min.value = min.min;
    expect(step.read().rotationStep).toBeGreaterThanOrEqual(step.definition.schema.properties!.rotationStep.minimum!);
  });

  it("rounds displayed angle bounds outward and maps them to the exact solver bounds", () => {
    let angular = 0;
    for (const method of registry.list()) {
      const { host, read, definition } = form(method.name);
      const walk = (schema: ParameterSchema, path: string[]) => {
        for (const [key, child] of Object.entries(schema.properties ?? {})) {
          if (child.type === "object" && child.properties) walk(child, [...path, key]);
          if (!isAngular(key, child)) continue;
          let input: FakeElement;
          try {
            input = host.find(`solve-param-${[...path, key].join("-")}`);
          } catch {
            continue; // nested group without defaults is shown as JSON
          }
          const value = () => [...path, key].reduce<any>((v, k) => v?.[k], read());
          const initial = input.value;
          for (const [bound, shown, direction] of [
            [child.minimum, input.min, -1],
            [child.maximum, input.max, 1],
          ] as const) {
            if (bound === undefined) continue;
            angular++;
            const id = `${method.name}.${key} ${direction}`;
            // (b) nothing inside the true range lies beyond the displayed bound
            expect((Number(shown) / DEGREES - bound) * direction, id).toBeGreaterThanOrEqual(0);
            expect(Math.abs(Number(shown) - bound * DEGREES), id).toBeLessThanOrEqual(Math.abs(bound * DEGREES) * 2e-11);
            // (a) the displayed bound and the full-precision bound both read as the exact bound
            for (const text of [shown, String(bound * DEGREES)]) {
              if (text === initial) continue;
              input.value = text;
              expect(Number(text) * direction, id).toBeLessThanOrEqual(Number(shown) * direction);
              expect(value(), `${id} ${text}`).toBeCloseTo(bound, 15);
              if (text === shown) expect(value(), `${id} ${text}`).toBe(bound);
              expect(value() * direction, id).toBeLessThanOrEqual(bound * direction);
            }
            input.value = initial;
          }
        }
      };
      walk(definition.schema, []);
    }
    expect(angular).toBeGreaterThan(15);
    // The reviewed cases: 0.5 rad and 1e-7 rad used to round inside the true range.
    expect(displayBound(0.5, true, 1)).toBe(28.6478897566);
    expect(displayBound(0.5, true, 1)).toBeGreaterThan(0.5 * DEGREES);
    expect(displayBound(1e-7, true, -1)).toBe(5.7295779513e-6);
    expect(displayBound(Math.PI, true, 1)).toBe(180);
    expect(displayBound(-2 * Math.PI, true, -1)).toBe(-360);
    expect(displayBound(7, false, 1)).toBe(7);
    const half = field({ minimum: 1e-7, maximum: 0.5 });
    expect(parseNumber("28.64788975654116", half, true, "x")).toBeCloseTo(0.5, 15);
    expect(parseNumber("28.6478897566", half, true, "x")).toBe(0.5);
    expect(() => parseNumber("28.6478897567", half, true, "x")).toThrow(ParameterError);
    expect(parseNumber("0.0000057295779513", half, true, "x")).toBe(1e-7);
    expect(() => parseNumber("0.0000057295779512", half, true, "x")).toThrow(ParameterError);
    // Values that are not at a bound are converted and nothing else.
    for (const degrees of ["28.6478897565", "28.64", "0.00001", "10"])
      expect(parseNumber(degrees, half, true, "x")).toBe(Number(degrees) / DEGREES);
  });

  it("does not convert the mixed position and angle jitter and labels its units truthfully", () => {
    for (const [method, id, path] of [
      ["penalty", "solve-param-jitter", ["jitter"]],
      ["morph", "solve-param-jitter", ["jitter"]],
      ["basin_hopping", "solve-param-penalty-jitter", ["penalty", "jitter"]],
    ] as const) {
      const { host, read, definition } = form(method);
      const input = host.find(id);
      const fallback = path.reduce<any>((value, key) => value[key], definition.defaults);
      expect(input.value, method).toBe(String(fallback));
      expect(input.title).toMatch(/not converted to degrees/);
      expect(input.title).not.toMatch(/in degrees/);
      input.value = "0.25";
      expect(path.reduce<any>((value, key) => value[key], read()), method).toBe(0.25);
    }
    const schema = registry.list().find((m) => m.name === "penalty")!.schema.properties!.jitter;
    expect(isAngular("jitter", schema)).toBe(false);
    expect(parameterLabel("jitter", schema).text).toBe("Initial symmetry breaking (piece units and radians)");
    expect(parameterLabel("rotationStep", field({ title: "Rotation step", description: "Half-width in radians." }))).toEqual(
      { text: "Rotation step (degrees)", description: "Half-width in degrees." },
    );
  });

  it("rejects a cleared or unparsable number instead of running with the hidden default", () => {
    const { host, read } = form("mc_compress");
    const sweeps = host.find("solve-param-adaptationSweeps");
    expect(sweeps.required).toBe(true);
    // A real number input reports "" both when cleared and when its text is not a number.
    sweeps.value = "";
    let thrown: unknown;
    try {
      read();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ParameterError);
    expect((thrown as ParameterError).control).toBe(sweeps);
    expect((thrown as ParameterError).message).toMatch(/^Adaptation interval: enter a valid number/);
    sweeps.value = "2.5";
    expect(() => read()).toThrow(/whole number/);
    sweeps.value = "0";
    expect(() => read()).toThrow(/outside its allowed range/);
    sweeps.value = "30";
    expect(read()).toEqual({ adaptationSweeps: 30 });
  });

  it("keeps legitimately blank optional fields optional", () => {
    const { host, read } = form("seed");
    const record = host.find("solve-param-record");
    expect(record.tagName).toBe("textarea");
    expect(record.value).toBe("");
    expect(record.required).toBe(false);
    expect(read()).toEqual({});
    record.value = "{";
    expect(() => read()).toThrow(/valid JSON/);
    // A number without a default is optional and may stay blank.
    const optional = new FakeElement("div");
    const readOptional = parameterForm(
      optional as unknown as HTMLElement,
      { type: "object", properties: { cap: { type: "integer", minimum: 1 }, need: { type: "integer" } }, required: ["need"] },
      {},
    );
    expect(optional.find("solve-param-cap").required).toBe(false);
    expect(optional.find("solve-param-need").required).toBe(true);
    expect(() => readOptional()).toThrow(/Need: enter a valid number/i);
    optional.find("solve-param-need").value = "3";
    expect(readOptional()).toEqual({ need: 3 });
    optional.find("solve-param-cap").value = "4";
    expect(readOptional()).toEqual({ need: 3, cap: 4 });
  });

  it("checks exclusive bounds in solver units", () => {
    const schema = field({ exclusiveMinimum: 0, exclusiveMaximum: 1 });
    expect(parseNumber("0.5", schema, false, "x")).toBe(0.5);
    expect(() => parseNumber("0", schema, false, "x")).toThrow(ParameterError);
    expect(() => parseNumber("1", schema, false, "x")).toThrow(ParameterError);
    expect(parseNumber("180", field({ maximum: Math.PI }), true, "x")).toBe(Math.PI);
  });
});
