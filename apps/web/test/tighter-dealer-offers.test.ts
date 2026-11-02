import { describe, expect, it } from "vitest";
import type { HolderResponse, LeaderboardEntry } from "@polypack/geometry";
import type { RecordsResponse } from "../src/api";
import { contestedCandidates, filterSources } from "../src/tighter/dealer";
import type { SourceReach } from "../src/tighter/dealer";
import {
  OFFER_LIFE_MS,
  Offer,
  expireOffers,
  newPicks,
  normalizePicks,
  offerExpired,
  skipOffer,
} from "../src/tighter/picks";
import type { Tier } from "../src/tighter/points";
import { normalizeFilters, passes } from "../src/tighter/rank";
import {
  HOLDER_ASK_MS,
  HOLDER_PER_MINUTE,
  HolderReader,
  MAX_RIVALS,
  addRival,
  heldByTighter,
  heldKeys,
  normalizeRivals,
  removeRival,
} from "../src/tighter/rivals";

const T0 = 1_700_000_000_000;

const offer = (P: number, over: Partial<Offer> = {}): Offer => ({
  family: "polygon",
  N: 7,
  M: 7,
  P,
  tier: "batch",
  weakness: 0,
  leader: { score: 9, name: "Bob", id: P },
  target: null,
  source: null,
  retake: false,
  score: 1,
  prior: 1,
  bucket: "b",
  at: T0,
  ...over,
});
const key = (x: Offer) => `${x.N}/${x.M}/${x.P}`;

describe("offers that are skipped or grow old", () => {
  it("expire after 30 minutes, except a retake and an offer without a time", () => {
    const picks = newPicks();
    picks.offers = [offer(10), offer(11, { retake: true }), offer(12, { at: 0 }), offer(13, { at: T0 + 20 * 60_000 })];
    expect(expireOffers(picks, T0 + OFFER_LIFE_MS)).toBe(0);
    expect(expireOffers(picks, T0 + OFFER_LIFE_MS + 1)).toBe(1);
    expect(picks.offers.map((x) => x.P)).toEqual([11, 12, 13]);
    expect(offerExpired(offer(13, { at: T0 + 20 * 60_000 }), T0 + 51 * 60_000)).toBe(true);
    // a long time later only the retake and the offer without a time are left
    expect(expireOffers(picks, T0 + 10 * 86_400_000)).toBe(1);
    expect(picks.offers.map((x) => x.P)).toEqual([11, 12]);
  });

  it("skip removes the offer, and a skipped retake leaves the retake list", () => {
    const picks = newPicks();
    picks.offers = [offer(10), offer(11, { retake: true })];
    picks.retake = ["7/7/11", "7/7/99"];
    expect(skipOffer(picks, "7/7/10")?.P).toBe(10);
    expect(picks.offers.map(key)).toEqual(["7/7/11"]);
    expect(skipOffer(picks, "7/7/10")).toBeNull();
    expect(skipOffer(picks, "7/7/11")?.retake).toBe(true);
    expect(picks.offers).toEqual([]);
    expect(picks.retake).toEqual(["7/7/99"]);
  });
});

describe("records held by Tighter players", () => {
  const e = (P: number, name: string, agent_note: string): LeaderboardEntry & { P: number } => ({
    P,
    id: 100 + P,
    name,
    found_with: null,
    agent_note,
    score: 9,
    created_at: "",
    verification: "none",
  });

  it("tell a Tighter entry by its tag, and never the player's own", () => {
    expect(heldByTighter(e(5, "Ada", "tighter/0.1"), "Me")).toBe(true);
    expect(heldByTighter(e(5, "Ada", "tighter/9"), "Me")).toBe(true);
    expect(heldByTighter(e(5, "Ada", "volunteer/1"), "Me")).toBe(false);
    expect(heldByTighter(e(5, "Ada", ""), "Me")).toBe(false);
    expect(heldByTighter({ name: "Ada" }, "Me")).toBe(false);
    // names are compared as the server keeps them
    expect(heldByTighter(e(5, "Me  <b>", "tighter/0.1"), "Me b")).toBe(false);
    expect(heldByTighter(e(5, "Ada", "tighter/0.1"), "Ada")).toBe(false);
  });

  it("limit the contested candidates to those entries", () => {
    const records: RecordsResponse = {
      N: 7,
      M: 7,
      literature: [],
      site: [e(5, "Ada", "tighter/0.1"), e(6, "Bob", ""), e(7, "Me", "tighter/0.1"), e(8, "Cy", "tighter/0.1")],
    };
    const base = { ringMin: 0, tiers: new Set<Tier>(["loose", "batch", "published"]), exclude: new Set<string>() };
    expect(contestedCandidates(records, base).map((c) => c.P)).toEqual([5, 6, 7, 8]);
    const heldBy = (x: { name: string; agent_note?: string }) => heldByTighter(x, "Me");
    expect(contestedCandidates(records, { ...base, heldBy }).map((c) => c.P)).toEqual([5, 8]);
  });

  it("deal a published value only when a Tighter entry holds it", () => {
    const lit = (P: number) =>
      ({
        N: 7,
        M: 7,
        P,
        value: 9.5,
        display: "9.5",
        display_precision: 1,
        status: "best_known",
        source_name: "Erich",
        source_url: "",
        accessed: "",
        conversion_note: "",
        has_coordinates: true,
      }) as RecordsResponse["literature"][number];
    const records: RecordsResponse = { N: 7, M: 7, literature: [lit(5), lit(6)], site: [e(5, "Ada", "tighter/0.1")] };
    const base = { ringMin: 0, tiers: new Set<Tier>(["published"]), exclude: new Set<string>() };
    expect(contestedCandidates(records, base).map((c) => c.P)).toEqual([5, 6]);
    const heldBy = (x: { name: string; agent_note?: string }) => heldByTighter(x, "Me");
    expect(contestedCandidates(records, { ...base, heldBy }).map((c) => c.P)).toEqual([5]);
  });
});

describe("the held-by filters", () => {
  const reach: SourceReach = {
    contested: new Set<Tier>(["batch"]),
    ringMin: 0,
    wide: false,
    space: true,
  };
  const f = (extra: object) => normalizeFilters({ minP: 1, maxP: 500, ...extra });

  it("are kept by normalizeFilters only when on, and do not change which problems pass", () => {
    expect(f({ tighter: true, rivals: true })).toMatchObject({ tighter: true, rivals: true });
    const off = f({ tighter: false, rivals: "yes", pieces: [4] });
    expect(off).not.toHaveProperty("tighter");
    expect(off).not.toHaveProperty("rivals");
    expect(passes(f({ tighter: true }), { family: "polygon", N: 4, M: 4, P: 9 })).toBe(true);
  });

  it("leave only the contested source, so that no draw is spent on open or space problems", () => {
    expect(filterSources(null, reach)).toEqual({ open: true, contested: true, space: true });
    expect(filterSources(f({ tighter: true }), reach)).toEqual({ open: false, contested: true, space: false });
    expect(filterSources(f({ rivals: true }), reach)).toEqual({ open: false, contested: true, space: false });
    // without a contested tier there is nothing to hold
    const none = { ...reach, contested: new Set<Tier>() };
    expect(filterSources(f({ tighter: true }), none)).toEqual({ open: false, contested: false, space: false });
    expect(filterSources(f({ rivals: true }), none)).toEqual({ open: false, contested: false, space: false });
  });
});

describe("rivals", () => {
  it("keep the newest first, count what each took, and skip the player and unknown names", () => {
    const list: ReturnType<typeof normalizeRivals> = [];
    expect(addRival(list, "Ada", "Me")).toBe(true);
    expect(addRival(list, "Bob", "Me")).toBe(true);
    expect(addRival(list, "Ada", "Me")).toBe(true);
    expect(list).toEqual([
      { name: "Ada", took: 2 },
      { name: "Bob", took: 1 },
    ]);
    expect(addRival(list, "Me", "Me")).toBe(false);
    expect(addRival(list, " Me ", "Me")).toBe(false);
    expect(addRival(list, "another name", "Me")).toBe(false);
    expect(addRival(list, "  ", "Me")).toBe(false);
    expect(list).toHaveLength(2);
  });

  it("keep at most 20, dropping the oldest", () => {
    const list: ReturnType<typeof normalizeRivals> = [];
    for (let i = 0; i < MAX_RIVALS + 5; i++) addRival(list, `n${i}`, "Me");
    expect(list).toHaveLength(MAX_RIVALS);
    expect(list[0].name).toBe(`n${MAX_RIVALS + 4}`);
    expect(list.at(-1)!.name).toBe("n5");
  });

  it("remove one by name", () => {
    const list = [
      { name: "Ada", took: 1 },
      { name: "Bob", took: 2 },
    ];
    expect(removeRival(list, "Ada")).toBe(true);
    expect(removeRival(list, "Ada")).toBe(false);
    expect(list).toEqual([{ name: "Bob", took: 2 }]);
  });

  it("round-trip through a save and read damaged rows safely", () => {
    const picks = newPicks();
    addRival(picks.rivals, "Ada", "Me");
    addRival(picks.rivals, "Bob", "Me");
    const back = normalizePicks(JSON.parse(JSON.stringify(picks)));
    expect(back.rivals).toEqual(picks.rivals);
    const odd = normalizeRivals([
      { name: "Ada", took: 2 },
      { name: "Ada", took: 5 },
      { name: 4, took: 1 },
      { name: "Cy", took: -3 },
      null,
      "x",
    ]);
    expect(odd).toEqual([
      { name: "Ada", took: 2 },
      { name: "Cy", took: 1 },
    ]);
    expect(normalizeRivals(undefined)).toEqual([]);
    expect(normalizeRivals(Array.from({ length: 40 }, (_, i) => ({ name: `n${i}`, took: 1 })))).toHaveLength(
      MAX_RIVALS,
    );
  });
});

describe("reading what the rivals hold", () => {
  const answer = (name: string, pairs: HolderResponse["pairs"] = []): HolderResponse => ({
    name,
    records: 0,
    beat_published: 0,
    site_bests: 0,
    pending: 0,
    computed_at: "",
    pairs,
  });

  it("list the held problems as keys", () => {
    const pairs = [
      { N: 4, M: 6, P: [5, 9], records: 2, beat_published: 0, pending: 0 },
      { N: 30, M: 31, P: [70], records: 1, beat_published: 0, pending: 0 },
    ];
    expect(heldKeys(answer("Ada", pairs))).toEqual(["4/6/5", "4/6/9", "30/31/70"]);
  });

  it("ask for a name once in 15 minutes and keep the answer", async () => {
    let t = T0;
    const asked: string[] = [];
    const reader = new HolderReader(
      async (n) => (asked.push(n), answer(n)),
      () => t,
    );
    expect((await reader.get("Ada"))?.name).toBe("Ada");
    t += HOLDER_ASK_MS - 1;
    expect((await reader.get("Ada"))?.name).toBe("Ada");
    expect(asked).toEqual(["Ada"]);
    t += 1;
    await reader.get("Ada");
    expect(asked).toEqual(["Ada", "Ada"]);
  });

  it("send at most a few requests a minute in all, and give the last answer meanwhile", async () => {
    let t = T0;
    const asked: string[] = [];
    const reader = new HolderReader(
      async (n) => (asked.push(n), answer(n)),
      () => t,
    );
    for (let i = 0; i < HOLDER_PER_MINUTE + 3; i++) await reader.get(`n${i}`);
    expect(asked).toHaveLength(HOLDER_PER_MINUTE);
    expect(await reader.get("n9")).toBeNull();
    t += 61_000;
    expect((await reader.get("n9"))?.name).toBe("n9");
    expect(asked).toHaveLength(HOLDER_PER_MINUTE + 1);
    // an old answer stands while the limit holds a new request back
    t += HOLDER_ASK_MS;
    for (let i = 0; i < HOLDER_PER_MINUTE; i++) await reader.get(`m${i}`);
    expect((await reader.get("n0"))?.name).toBe("n0");
  });

  it("count a failed or refused ask as asked, and keep an earlier answer through it", async () => {
    let t = T0;
    let next: HolderResponse | "refused" | null = answer("Ada");
    let calls = 0;
    const reader = new HolderReader(
      async () => (calls++, next),
      () => t,
    );
    expect((await reader.get("Ada"))?.name).toBe("Ada");
    t += HOLDER_ASK_MS;
    next = null;
    expect((await reader.get("Ada"))?.name).toBe("Ada");
    expect((await reader.get("Ada"))?.name).toBe("Ada");
    expect(calls).toBe(2);
    next = "refused";
    expect(await reader.get("Zed")).toBeNull();
    expect(await reader.get("Zed")).toBeNull();
    expect(calls).toBe(3);
  });
});
