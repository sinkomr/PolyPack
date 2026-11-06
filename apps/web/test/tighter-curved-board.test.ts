import { describe, expect, it } from "vitest";
import { curvedMaxP } from "@polypack/curved/bound";
import { CURVED_MENU_K_IDS, CURVED_TILING_KS, SPACE_DOMAINS, formatCurvature, parseSpaceId } from "@polypack/spaces";
import {
  CURVED_KS,
  CURVED_MS,
  CURVED_PROBLEMS,
  DOMAIN_MAX_P,
  RuleLimits,
  STARTER_P,
  domainProblems,
  drawSliceProblem,
} from "../src/tighter/catalogue";
import { SMALL_TOTAL } from "../src/tighter/frontier";
import { newDealer } from "../src/tighter/dealer";

describe("Tighter's curved deals follow the board", () => {
  it("deals the board's 16 curvatures and containers 0 and 3 to 100", () => {
    expect(CURVED_KS).toEqual(CURVED_MENU_K_IDS);
    expect(CURVED_MS).toEqual([0, ...Array.from({ length: 98 }, (_, i) => i + 3)]);
    expect(DOMAIN_MAX_P.curved).toBe(100);
  });

  it("deals only problems that can exist, within the rules' limits", () => {
    const tiling = new Set(CURVED_TILING_KS.map(formatCurvature));
    const rules: [string, RuleLimits, boolean][] = [
      ["no rule", {}, false],
      ["small", { small: true }, false],
      ["circles", { circles: true }, false],
      ["small and circles", { small: true, circles: true }, false],
      ["starter", {}, true],
    ];
    const ks = new Set<string>();
    let diskContainers = 0;
    let bigM = 0;
    let n = 0;
    for (const [name, limits, starter] of rules) {
      const d = newDealer(5);
      for (let i = 0; i < 1000; i++) {
        const k = drawSliceProblem(d, "curved", { listings: {}, exclude: new Set(), starter, ...limits });
        // a draw may fail only when 40 redraws all do: not within these 5,000
        expect(k, name).not.toBeNull();
        const parsed = parseSpaceId("curved", k!.id);
        expect(typeof parsed, k!.id).toBe("object");
        const bound = SPACE_DOMAINS.curved!.bound(parsed as Exclude<typeof parsed, string>);
        expect(bound, `${name}: ${k!.id}`).not.toBeUndefined();
        expect(bound, `${name}: ${k!.id}`).not.toBeNull();
        const [, K, N, M, P] = k!.id.split("/");
        expect(tiling.has(K), k!.id).toBe(false);
        expect(Number(P)).toBe(k!.P);
        expect(k!.P).toBeLessThanOrEqual(100);
        expect(k!.P).toBeGreaterThanOrEqual(starter ? STARTER_P.min : 2);
        if (starter) expect(k!.P).toBeLessThanOrEqual(STARTER_P.max);
        if (limits.small) expect(Number(N) + Number(M) + k!.P, k!.id).toBeLessThanOrEqual(SMALL_TOTAL);
        if (limits.circles) expect(Number(N) === 0 || Number(M) === 0, k!.id).toBe(true);
        ks.add(K);
        if (Number(M) === 0) diskContainers++;
        if (Number(M) > 12) bigM++;
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(3000);
    expect([...ks].sort()).toEqual([...CURVED_KS].sort());
    expect(diskContainers).toBeGreaterThan(0);
    expect(bigM).toBeGreaterThan(0);
  });

  it("counts the problems it can deal", () => {
    let n = 0;
    for (const K of CURVED_KS)
      for (let N = 0; N <= 100; N++) {
        if (N === 1 || N === 2) continue;
        for (const M of CURVED_MS) n += Math.max(0, Math.min(100, curvedMaxP(Number(K), N, M, 100)) - 1);
      }
    expect(CURVED_PROBLEMS).toBe(n);
    expect(domainProblems("curved")).toBe(n);
  });
});
