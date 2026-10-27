import { describe, expect, it } from "vitest";
import { evaluate, type PackingConfig } from "@polypack/geometry";
import {
  contactResiduals,
  identifyContacts,
  packContactVariables,
  polish,
  unpackContactVariables,
} from "../src/polish";

function squares(expansion: number): PackingConfig {
  const d = ((1 + Math.SQRT1_2) / 2) * expansion;
  return {
    N: 4,
    M: 4,
    P: 5,
    container_phi: 0,
    pieces: [
      { x: 0, y: 0, theta: 0 },
      ...[
        [-d, -d],
        [d, -d],
        [-d, d],
        [d, d],
      ].map(([x, y]) => ({ x, y, theta: Math.PI / 4 })),
    ],
  };
}

function circles(expansion: number): PackingConfig {
  return {
    N: 0,
    M: 0,
    P: 7,
    container_phi: 0,
    pieces: [
      { x: 0, y: 0, theta: 0 },
      ...Array.from({ length: 6 }, (_, k) => ({
        x: expansion * Math.cos((k * Math.PI) / 3),
        y: expansion * Math.sin((k * Math.PI) / 3),
        theta: 0,
      })),
    ],
  };
}

describe("contact active-set polish", () => {
  // [CALC] Same construction as geometry/test/enclose.test.ts, loosened before solving.
  it("tightens five squares to side 2 + 1/sqrt(2) without known-answer branches", async () => {
    const start = squares(1.02);
    const original = structuredClone(start);
    const result = await polish(start);
    expect(start).toEqual(original);
    expect(result).toBeDefined();
    const e = evaluate(result!, { autoOrient: true });
    expect(e.valid).toBe(true);
    expect(e.score).toBeCloseTo(2 + Math.SQRT1_2, 7);
    expect(e.score!).toBeLessThan(evaluate(start, { autoOrient: true }).score! - 0.01);
  });

  // [CALC] Six centres on a unit hexagon and one central unit-diameter disk fit a circle of diameter 3.
  it("tightens the seven-circle ring to diameter 3", async () => {
    const result = await polish(circles(1.02));
    expect(result).toBeDefined();
    const e = evaluate(result!, { autoOrient: true });
    expect(e.valid).toBe(true);
    expect(e.score).toBeCloseTo(3, 7);
  });

  it("repairs slight overlap and never returns an invalid configuration", async () => {
    const start = circles(0.99999);
    expect(evaluate(start).valid).toBe(false);
    const result = await polish(start);
    expect(result).toBeDefined();
    expect(evaluate(result!).valid).toBe(true);
  });

  it("retains a valid optimum and handles malformed starts", async () => {
    const start = squares(1);
    const result = await polish(start);
    expect(evaluate(result!, { autoOrient: true }).score!).toBeLessThanOrEqual(
      evaluate(start, { autoOrient: true }).score!,
    );
    expect(await polish({ ...start, P: 6 })).toBeUndefined();
    expect(await polish({ ...start, container_phi: NaN })).toBeUndefined();
  });

  it("cooperatively stops inside numerical work and counts every assessment through the hook", async () => {
    let checkpoints = 0,
      assessments = 0,
      stopChecks = 0;
    const start = circles(1.02);
    const result = await polish(start, {
      checkpoint: async () => {
        checkpoints++;
        return true;
      },
      shouldStop: () => ++stopChecks >= 10,
      evaluate: async (c) => {
        assessments++;
        return evaluate(c, { autoOrient: true });
      },
    });
    expect(assessments).toBe(1);
    expect(checkpoints).toBe(2);
    expect(stopChecks).toBe(10);
    expect(result).toEqual(start);
  });

  it("exports a portable system with correct signs for all shape combinations", () => {
    for (const N of [0, 3, 4, 5])
      for (const M of [0, 3, 4, 5]) {
        const config: PackingConfig = {
          N,
          M,
          P: 2,
          pieces: [
            { x: -3, y: 0, theta: 0.3 },
            { x: 3, y: 0, theta: -0.2 },
          ],
          container_phi: 0.1,
        };
        const c = evaluate(config, { autoOrient: true }).container!;
        const contacts = identifyContacts(config, c);
        expect(contacts.length).toBeGreaterThan(0);
        expect(Math.min(...contactResiduals(config, c, contacts))).toBeGreaterThan(-1e-9);
        const unpacked = unpackContactVariables(config, packContactVariables(config, c));
        expect(unpacked.container).toEqual(c);
        expect(unpacked.config.pieces).toEqual(config.pieces);
      }
  });
});
