import { describe, expect, it } from "vitest";
import { chooseName } from "../src/tighter/name-popup";
import { MAX_NAME_LENGTH, generatePlayerName } from "../src/tighter/names";

describe("generated names", () => {
  it("are TighterGamePlayer and five digits, and vary", () => {
    const names = new Set(Array.from({ length: 50 }, generatePlayerName));
    for (const n of names) expect(n).toMatch(/^TighterGamePlayer\d{5}$/);
    expect(names.size).toBeGreaterThan(40);
  });

  it("use crypto.getRandomValues, with leading zeros kept", () => {
    const real = crypto.getRandomValues.bind(crypto);
    try {
      crypto.getRandomValues = ((a: Uint32Array) => {
        a[0] = 417;
        return a;
      }) as typeof crypto.getRandomValues;
      expect(generatePlayerName()).toBe("TighterGamePlayer00417");
    } finally {
      crypto.getRandomValues = real;
    }
  });
});

describe("the name pop-up's validation", () => {
  it("takes a new name, cleaned the way the server stores it", () => {
    expect(chooseName("  Ada   Lovelace ", "TighterGamePlayer04817")).toEqual({
      name: "Ada Lovelace",
      changed: true,
      problem: null,
    });
    expect(chooseName("x".repeat(100), "Old").name).toHaveLength(MAX_NAME_LENGTH);
  });

  it("keeps the old name for empty input, quietly", () => {
    expect(chooseName("", "Ada")).toEqual({ name: "Ada", changed: false, problem: null });
    expect(chooseName("   ", "Ada")).toEqual({ name: "Ada", changed: false, problem: null });
  });

  it("keeps the old name for input that is empty once cleaned, and says why", () => {
    const c = chooseName("<>", "Ada");
    expect(c.name).toBe("Ada");
    expect(c.changed).toBe(false);
    expect(c.problem).toMatch(/stays the same/);
  });

  it("reports the same name as unchanged", () => {
    expect(chooseName("Ada", "Ada").changed).toBe(false);
  });
});
