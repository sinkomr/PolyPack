/**
 * The board's menus for curved problems (2026-11-05): only problems that can exist are offered; the tiling curvatures
 * stay out of the menu but open from a link; a link to an id that cannot exist keeps its fields and gives the reason.
 */
import {
  CURVED_KS,
  CURVED_MENU_KS,
  CURVED_MENU_K_IDS,
  CURVED_TILING_KS,
  SPACE_DOMAINS,
  formatCurvature,
  impossibleReason,
  parseSpaceId,
} from "@polypack/spaces";
import { curvedMaxP } from "@polypack/curved/bound";
import { describe, expect, it } from "vitest";
import { fieldsOfId, pickFromDomain } from "../src/space/pick";

const domain = SPACE_DOMAINS.curved!;
const pick = (id: string, keep = false) =>
  pickFromDomain("curved", domain.info, fieldsOfId("curved", id), null, domain.menu, keep);
const field = (p: ReturnType<typeof pick>, key: string) => p.fields.find((f) => f.key === key)!;

describe("curved menus", () => {
  it("offers the 16 menu curvatures in numeric order, not the tiling ones", () => {
    expect(CURVED_MENU_KS).toHaveLength(16);
    expect([...CURVED_MENU_KS]).toEqual([...CURVED_MENU_KS].sort((a, b) => a - b));
    expect(CURVED_MENU_K_IDS).toEqual(CURVED_MENU_KS.map(formatCurvature));
    expect(CURVED_KS).toHaveLength(22);
    const k = field(pick("curved/-1/3/4/5"), "K");
    expect(k.options.map((o) => o.value)).toEqual(CURVED_MENU_K_IDS);
    expect(CURVED_TILING_KS.map(formatCurvature).filter((t) => k.options.some((o) => o.value === t))).toEqual([]);
  });
  it("opens a tiling curvature from a link, and offers it while it is chosen", () => {
    const p = pick("curved/-1.1892985685754194/3/7/7");
    expect(p.id).toBe("curved/-1.1892985685754194/3/7/7");
    const k = field(p, "K");
    expect(k.value).toBe("-1.1892985685754194");
    expect(k.options).toHaveLength(17);
    expect(pick("curved/1.225778283313099/3/6/6").id).toBe("curved/1.225778283313099/3/6/6");
  });
  it("offers the pieces that exist at K, the containers that hold one and P up to the area limit", () => {
    const p = pick("curved/1/3/4/3");
    expect(field(p, "N").options.map((o) => o.value)).toEqual(["0", "3", "4", "5", "6"]);
    const ms = field(p, "M").options.map((o) => o.value);
    for (const m of ms) expect(curvedMaxP(1, 3, Number(m), 1)).toBe(1);
    expect(ms.length).toBeGreaterThan(50);
    const max = curvedMaxP(1, 3, 4);
    expect(field(p, "P").options.at(-1)!.value).toBe(String(max));
    expect(field(pick("curved/-0.0001/4/100/500"), "P").options).toHaveLength(500);
  });
  it("moves an impossible choice made through the menus to a problem that exists", () => {
    // N = 8 is not offered at K = 1: the wish goes to the nearest piece, and the id is a possible one
    const p = pick("curved/1/8/4/3");
    expect(domain.bound(parseSpaceId("curved", p.id) as never)).not.toBeNull();
    expect(impossibleReason("curved", parseSpaceId("curved", p.id) as never)).toBeNull();
  });
  it("keeps the fields of an impossible id for a link, with the reason", () => {
    const id = "curved/1/8/4/3";
    const p = pick(id, true);
    expect(p.id).toBe(id);
    expect(field(p, "N").value).toBe("8");
    const parsed = parseSpaceId("curved", id);
    if (typeof parsed === "string") throw new Error(parsed);
    expect(impossibleReason("curved", parsed)).toBe(
      "No unit 8-gon exists at K = 1: its perimeter, 8, is longer than a great circle, 2π/√K ≈ 6.283.",
    );
    // a piece that exists in a container that cannot hold P of them: the area reason
    const max = curvedMaxP(1, 3, 4);
    const more = parseSpaceId("curved", `curved/1/3/4/${max + 1}`);
    if (typeof more === "string") throw new Error(more);
    expect(impossibleReason("curved", more)).toMatch(/holds at most \d+ unit 3-gons/);
    expect(pick(more.id, true).id).toBe(more.id);
  });
  it("counts only the ids that can exist, and answers the others with a null bound", () => {
    expect(domain.info.problems).toBe(26_830_100);
    const out = parseSpaceId("curved", "curved/1/8/4/3");
    if (typeof out === "string") throw new Error(out);
    expect(domain.bound(out)).toBeNull();
    expect(domain.bound({ ...out, fields: { ...out.fields, K: 2 } })).toBeUndefined();
    expect(domain.bound({ ...out, P: 501 })).toBeUndefined();
    const tiling = parseSpaceId("curved", "curved/-1.1892985685754194/3/7/7");
    if (typeof tiling === "string") throw new Error(tiling);
    expect(domain.bound(tiling)?.value).toBeGreaterThan(0);
  });
});
