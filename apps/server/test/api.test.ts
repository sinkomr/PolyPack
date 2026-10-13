import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { AtlasResponse, LiteratureRecord, PackingConfig, SubmitResponse, evaluate } from "@polypack/geometry";
import { beforeEach, describe, expect, it } from "vitest";
import { ATLAS_MAX_PIECES, ATLAS_MAX_SPAN, atlasSource, createApp } from "../src/app";
import { SqliteStore } from "../src/sqlite-store";
import { GET_MANY_LIMIT } from "../src/store";

const SQ = Math.PI / 4;
const row = (n: number, gap = 1): PackingConfig["pieces"] =>
  Array.from({ length: n }, (_, i) => ({ x: i * gap, y: 0, theta: SQ }));

// A made-up published value, far above what three squares need, to trigger the review path.
const fakeRecord: LiteratureRecord = {
  N: 4,
  M: 4,
  P: 3,
  value: 5,
  display: "5.00",
  display_precision: 2,
  status: "best_known",
  source_name: "test",
  source_url: "https://example.invalid",
  accessed: "2026-10-07",
  conversion_note: "none",
};

let app: ReturnType<typeof createApp>;
let logs: string[];
let ip = "1.1.1.1";

beforeEach(() => {
  logs = [];
  ip = "1.1.1.1";
  app = createApp({
    store: new SqliteStore(":memory:"),
    records: [fakeRecord],
    adminToken: "secret",
    clientIp: () => ip,
    log: (m) => logs.push(m),
    limits: { perIp: 8, perName: 5 },
  });
});

async function submit(body: unknown): Promise<{ status: number; body: SubmitResponse }> {
  const r = await app.request("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as SubmitResponse };
}
const get = async (path: string, headers?: Record<string, string>) => {
  const r = await app.request(path, { headers });
  // responses differ per route; the assertions below check the fields they use
  return { status: r.status, body: (await r.json()) as any };
};
const squares = (P: number, extra: object = {}) => ({
  N: 4,
  M: 4,
  P,
  pieces: row(P),
  container_phi: 0,
  name: "ann",
  ...extra,
});

describe("POST /api/submit", () => {
  it("accepts a valid packing and stores the server-computed score", async () => {
    const r = await submit(squares(2, { score: 0.001, container: { size: 0.001 } }));
    expect(r.status).toBe(200);
    expect(r.body.valid).toBe(true);
    expect(r.body.score).toBeCloseTo(2, 9);
    expect(r.body.rank).toBe(1);
    const lb = await get("/api/leaderboard/4/4/2");
    expect(lb.body.entries[0].score).toBe(r.body.score);
    expect(lb.body.total).toBe(1);
  });

  it("scores at the better of the submitted phi and the auto-oriented phi", async () => {
    const r = await submit(squares(2, { container_phi: 0.3 }));
    expect(r.body.score).toBeCloseTo(2, 9);
    expect(evaluate(squares(2, { container_phi: 0.3 })).score!).toBeGreaterThan(2.1);
  });

  it("rejects overlaps, wrong counts and malformed bodies with reasons", async () => {
    const overlap = await submit({ ...squares(2), pieces: row(2, 0.9) });
    expect(overlap.status).toBe(422);
    expect(overlap.body.reasons[0]).toMatch(/overlapping/);
    const count = await submit({ ...squares(3), pieces: row(2) });
    expect(count.status).toBe(422);
    expect(count.body.reasons[0]).toMatch(/exactly 3 pieces/);
    expect((await submit("{nope")).status).toBe(400);
    expect((await submit({ ...squares(2), N: 2 })).status).toBe(400);
    expect((await submit({ ...squares(2), P: 501 })).status).toBe(400);
    expect((await submit({ ...squares(2), name: "  " })).body.reasons).toEqual(["name is required"]);
    expect(
      (
        await submit({
          ...squares(2),
          pieces: [
            { x: 0, y: 0, theta: 0 },
            { x: "1", y: 0, theta: 0 },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await get("/api/leaderboard/4/4/2")).body.total).toBe(0);
  });

  it("caps the payload size", async () => {
    const r = await submit(squares(2, { agent_note: "x".repeat(300_000) }));
    expect(r.status).toBe(413);
  });

  it("sanitizes names and notes", async () => {
    await submit(
      squares(2, { name: "  <b>Bob</b>\u0000\n  the   builder ", agent: "ai", agent_note: "<script>x</script>" }),
    );
    const e = (await get("/api/leaderboard/4/4/2")).body.entries[0];
    expect(e.name).toBe("b Bob /b the builder");
    expect(e.agent).toBe("ai");
    expect(e.agent_note).not.toMatch(/[<>]/);
  });

  it("rate-limits by address and by name", async () => {
    for (let i = 0; i < 5; i++) expect((await submit(squares(2))).status).toBe(200);
    expect((await submit(squares(2))).status).toBe(429);
    for (let i = 0; i < 2; i++) expect((await submit(squares(2, { name: `n${i}` }))).status).toBe(200);
    expect((await submit(squares(2, { name: "fresh" }))).status).toBe(429);
    ip = "2.2.2.2";
    expect((await submit(squares(2, { name: "fresh" }))).status).toBe(200);
  });
});

describe("GET /api", () => {
  it("serves the documentation page", async () => {
    const r = await app.request("/api");
    expect(r.status).toBe(200);
    const html = await r.text();
    for (const part of [
      "POST /api/submit",
      "GET /api/problems/{N}/{M}/{P}",
      "Example in Python",
      "Example with curl",
      "derived-records",
    ]) {
      expect(html).toContain(part);
    }
  });
});

describe("leaderboard", () => {
  it("keeps every submission, ranks by score and shows the top three", async () => {
    const gaps = [1.5, 1.2, 1.0, 1.3, 1.1];
    const ranks: number[] = [];
    for (const [i, gap] of gaps.entries()) {
      ranks.push((await submit({ ...squares(2, { name: `p${i}` }), pieces: row(2, gap) })).body.rank!);
    }
    expect(ranks).toEqual([1, 1, 1, 3, 2]);
    const lb = (await get("/api/leaderboard/4/4/2")).body;
    expect(lb.total).toBe(5);
    expect(lb.entries.map((e: { name: string }) => e.name)).toEqual(["p2", "p4", "p1"]);
    const problem = (await get("/api/problems/4/4/2")).body;
    expect(problem.site_best.name).toBe("p2");
    expect(problem.area_bound).toBeCloseTo(Math.SQRT2, 12);
    const stored = (await get(`/api/submissions/${problem.site_best.id}`)).body;
    expect(stored.pieces).toEqual(row(2, 1.0));
    const records = (await get("/api/records?N=4&M=4")).body;
    expect(records.site.map((s: { P: number }) => s.P)).toEqual([2]);
    expect(records.literature).toHaveLength(1);
  });

  it("sends a live event when a submission enters the top list", async () => {
    const res = await app.request("/api/events");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const readUntil = async (needle: string) => {
      while (!seen.includes(needle)) seen += decoder.decode((await reader.read()).value);
    };
    await readUntil("hello");
    await submit(squares(2));
    await readUntil("event: leaderboard");
    await readUntil('"rank":1');
    await reader.cancel();
  });
});

describe("submissions that beat the literature", () => {
  it("are accepted as pending, logged, strictly re-verified and reviewable", async () => {
    const r = await submit(squares(3));
    expect(r.body.valid).toBe(true);
    expect(r.body.pending_verification).toBe(true);
    expect(r.body.strict_check!.ok).toBe(true);
    expect(r.body.strict_check!.certifiedSize).toBeGreaterThan(r.body.score!);
    expect(logs[0]).toMatch(/\[review\] submission 1 .* below the published 5/);
    expect((await get("/api/leaderboard/4/4/3")).body.entries[0].verification).toBe("pending");

    expect((await get("/api/admin/pending")).status).toBe(401);
    const auth = { authorization: "Bearer secret" };
    expect((await get("/api/admin/pending", auth)).body.pending).toHaveLength(1);
    const review = await app.request("/api/admin/review", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ id: 1, decision: "rejected" }),
    });
    expect(review.status).toBe(200);
    expect((await get("/api/leaderboard/4/4/3")).body.total).toBe(0);
    expect((await get("/api/submissions/1")).status).toBe(404);
  });

  it("lets the admin remove an ordinary entry, which no review applies to", async () => {
    const send = (headers: Record<string, string>, body: unknown) =>
      app.request("/api/admin/remove", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const auth = { authorization: "Bearer secret" };
    const r = await submit(squares(2, { name: "test entry" }));
    expect(r.body.pending_verification).toBe(false);
    const id = r.body.id!;
    expect((await get("/api/leaderboard/4/4/2")).body.total).toBe(1);

    expect((await send({}, { id })).status).toBe(401);
    expect((await send(auth, { id: "1" })).status).toBe(400);
    expect((await send(auth, { id: id + 1 })).status).toBe(404);
    expect((await get("/api/leaderboard/4/4/2")).body.total).toBe(1);

    expect((await send(auth, { id })).status).toBe(200);
    expect((await get("/api/leaderboard/4/4/2")).body.total).toBe(0);
    expect((await get(`/api/submissions/${id}`)).status).toBe(404);
    // a removed entry is no longer listed, so there is nothing left to remove
    expect((await send(auth, { id })).status).toBe(404);
  });
});

describe("GET /api/atlas", () => {
  const lit = (P: number, value: number, extra: Partial<LiteratureRecord> = {}): LiteratureRecord => ({
    ...fakeRecord,
    P,
    value,
    display: String(value),
    display_precision: 6,
    ...extra,
  });
  // 2 squares with published coordinates, 3 and 5 squares with a value only, and a long run of
  // (made-up) circle records that is larger than one response may carry
  const circles = (P: number) => Array.from({ length: P }, (_, i) => ({ x: 2 * i, y: 0, theta: 0 }));
  const records: LiteratureRecord[] = [
    lit(2, 2, { status: "proven", pieces: row(2), container_phi: 0 }),
    fakeRecord,
    lit(5, 2.707107),
    lit(6, 9, { pieces: row(6), container_phi: 0 }),
    ...Array.from({ length: 16 }, (_, i) => lit(450 + i, 900 + 2 * i, { N: 0, M: 0, pieces: circles(450 + i) })),
  ];
  const atlas = async (query: string) => {
    const r = await get(`/api/atlas?${query}`);
    return { status: r.status, body: r.body as AtlasResponse & { error?: string } };
  };

  beforeEach(() => {
    app = createApp({
      store: new SqliteStore(":memory:"),
      records,
      adminToken: "secret",
      clientIp: () => ip,
      log: (m) => logs.push(m),
    });
  });

  it("prefers a verified site entry only when it is at least as good as the published value", () => {
    const rec = lit(7, 3, { pieces: [] });
    expect(atlasSource(undefined, undefined)).toBeNull();
    expect(atlasSource(undefined, lit(7, 3))).toBeNull();
    expect(atlasSource(undefined, rec)).toBe("literature");
    expect(atlasSource({ score: 9 }, undefined)).toBe("verified");
    expect(atlasSource({ score: 2.9 }, rec)).toBe("verified");
    expect(atlasSource({ score: 3.0000000000000004 }, { ...rec, display_precision: 14 })).toBe("verified");
    expect(atlasSource({ score: 3.0000005 }, rec)).toBe("verified"); // within the 6 printed decimals
    expect(atlasSource({ score: 3.00001 }, rec)).toBe("literature");
    expect(atlasSource({ score: 3.00001 }, lit(7, 3))).toBe("verified"); // nothing else to draw
  });

  it("draws a pending entry only when nothing else can be drawn", () => {
    const pending = { score: 2.5 };
    expect(atlasSource(undefined, lit(7, 3), pending)).toBe("pending");
    expect(atlasSource(undefined, undefined, pending)).toBe("pending");
    // published coordinates and verified entries always come first, however good the claim
    expect(atlasSource(undefined, lit(7, 3, { pieces: [] }), pending)).toBe("literature");
    expect(atlasSource({ score: 3 }, lit(7, 3), pending)).toBe("verified");
    expect(atlasSource({ score: 3.4 }, lit(7, 3), pending)).toBe("verified");
    expect(atlasSource({ score: 3.4 }, lit(7, 3, { pieces: [] }), pending)).toBe("literature");
  });

  it("returns the single best drawable packing per P", async () => {
    // only published coordinates so far
    let a = await atlas("N=4&M=4&from=1&to=10");
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ N: 4, M: 4, from: 1, to: 10, next: null });
    expect(a.body.tiles).toEqual([
      { P: 2, source: "literature", score: 2, pieces: row(2), container_phi: 0 },
      { P: 6, source: "literature", score: 9, pieces: row(6), container_phi: 0 },
    ]);

    // a worse site entry does not replace published coordinates, a matching one does
    await submit({ ...squares(2), pieces: row(2, 1.5) });
    expect((await atlas("N=4&M=4&from=2&to=2")).body.tiles[0].source).toBe("literature");
    const match = await submit(squares(2, { name: "bea" }));
    a = await atlas("N=4&M=4&from=2&to=2");
    expect(a.body.tiles).toEqual([
      {
        P: 2,
        source: "site",
        score: match.body.score,
        pieces: row(2),
        container_phi: match.body.container!.phi,
        id: match.body.id,
        verification: "none",
      },
    ]);

    // no published value (P = 4), and a published value without coordinates that the entry does not reach (P = 5)
    await submit(squares(4, { name: "cy" }));
    await submit(squares(5, { name: "di" }));
    a = await atlas("N=4&M=4");
    expect(a.body.tiles.map((t) => [t.P, t.source])).toEqual([
      [2, "site"],
      [4, "site"],
      [5, "site"],
      [6, "literature"],
    ]);
    expect(a.body.tiles[2].score).toBeGreaterThan(2.71); // auto-oriented row of five, still above the published value
    expect(a.body.tiles.every((t) => t.pieces.length === t.P)).toBe(true);
    // other shapes are not mixed in
    expect((await atlas("N=4&M=3")).body.tiles).toEqual([]);
  });

  const review = (id: number | null, decision: "confirmed" | "rejected") =>
    app.request("/api/admin/review", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ id, decision }),
    });

  it("marks pending entries and never shows rejected ones", async () => {
    const r = await submit(squares(3));
    expect(r.body.pending_verification).toBe(true);
    let a = await atlas("N=4&M=4&from=3&to=3");
    expect(a.body.tiles[0]).toMatchObject({ P: 3, source: "site", id: r.body.id, verification: "pending" });
    expect((await review(r.body.id, "rejected")).status).toBe(200);
    a = await atlas("N=4&M=4&from=3&to=3");
    expect(a.body.tiles).toEqual([]);
    expect(JSON.stringify((await atlas("N=4&M=4")).body)).not.toContain(`"id":${r.body.id}`);
  });

  it("never lets a pending entry stand in for a verified one", async () => {
    // three squares far apart: a valid entry well above the made-up published value of 5, so not pending
    const loose = await submit({ ...squares(3, { name: "lou" }), pieces: row(3, 4) });
    expect(loose.body.pending_verification).toBe(false);
    expect(loose.body.score).toBeGreaterThan(5);
    const claim = await submit(squares(3, { name: "pat" }));
    expect(claim.body.pending_verification).toBe(true);

    // the listing shows the claim as the site's best entry and the reviewed one beside it
    let records = (await get("/api/records?N=4&M=4")).body;
    expect(records.site.find((e: { P: number }) => e.P === 3)).toMatchObject({
      id: claim.body.id,
      verification: "pending",
    });
    expect(records.site_verified).toEqual([expect.objectContaining({ P: 3, id: loose.body.id, verification: "none" })]);
    // the atlas draws the reviewed entry, although the claim is smaller
    let a = await atlas("N=4&M=4&from=3&to=3");
    expect(a.body.tiles).toEqual([
      expect.objectContaining({ P: 3, source: "site", id: loose.body.id, verification: "none" }),
    ]);

    // a claim against a published value with coordinates is not drawn either (the record for P = 6 is made up)
    const six = await submit(squares(6, { name: "pat" }));
    expect(six.body.pending_verification).toBe(true);
    a = await atlas("N=4&M=4&from=6&to=6");
    expect(a.body.tiles).toEqual([expect.objectContaining({ P: 6, source: "literature", score: 9 })]);
    records = (await get("/api/records?N=4&M=4")).body;
    expect(records.site_verified.map((e: { P: number }) => e.P)).toEqual([3]);

    // once confirmed, the claim is a verified entry like any other
    expect((await review(claim.body.id, "confirmed")).status).toBe(200);
    a = await atlas("N=4&M=4&from=3&to=3");
    expect(a.body.tiles).toEqual([
      expect.objectContaining({ P: 3, source: "site", id: claim.body.id, verification: "confirmed" }),
    ]);
    records = (await get("/api/records?N=4&M=4")).body;
    expect(records.site_verified.map((e: { P: number }) => e.P)).toEqual([]);
    // without anything pending the field is still there, and empty
    expect((await get("/api/records?N=4&M=3")).body.site_verified).toEqual([]);
  });

  it("bounds the range and the payload", async () => {
    for (const bad of [
      "M=4",
      "N=4&M=2",
      "N=4&M=4&from=0",
      "N=4&M=4&from=5&to=4",
      "N=4&M=4&from=1.5&to=3",
      "N=4&M=4&from=x",
      "N=4&M=4&to=501",
      `N=4&M=4&from=1&to=${ATLAS_MAX_SPAN + 1}`,
      // empty values are not circles, and only plain decimal integers are numbers here
      "N=&M=",
      "N=4&M=",
      "N=&M=4",
      "N=4&M=4&from=",
      "N=4&M=4&to=",
      "N=4&M=4&from=0x10",
      "N=4&M=4&from=1e2",
      "N=4&M=4&to=1e1",
      "N=4.0&M=4",
      "N=+4&M=4",
      "N=4&M=4&from=-1",
      "N=4&M=4&from=%201",
    ]) {
      const r = await atlas(bad);
      expect([bad, r.status]).toEqual([bad, 400]);
      expect(r.body.error).toBeTruthy();
    }
    expect((await atlas(`N=4&M=4&from=401&to=${400 + ATLAS_MAX_SPAN}`)).status).toBe(200);
    // the default range ends at the largest P
    expect((await atlas("N=0&M=0&from=450")).body.to).toBe(500);

    // sixteen drawings of 450 to 465 circles: more than one answer may carry
    const count = (t: AtlasResponse) => t.tiles.reduce((n, tile) => n + tile.pieces.length, 0);
    const seen: number[] = [];
    let from: number | null = 440;
    let answers = 0;
    while (from !== null) {
      const part: { body: AtlasResponse } = await atlas(`N=0&M=0&from=${from}&to=470`);
      answers++;
      expect(part.body.tiles.length).toBeGreaterThan(0);
      expect(count(part.body)).toBeLessThanOrEqual(ATLAS_MAX_PIECES);
      // an answer is cut only when the next drawing would not fit
      if (part.body.next !== null) {
        expect(part.body.next).toBe(part.body.tiles[part.body.tiles.length - 1].P + 1);
        expect(count(part.body) + part.body.next).toBeGreaterThan(ATLAS_MAX_PIECES);
      }
      seen.push(...part.body.tiles.map((t) => t.P));
      from = part.body.next;
    }
    expect(answers).toBeGreaterThan(1);
    expect(seen).toEqual(Array.from({ length: 16 }, (_, i) => 450 + i));
  });

  it("caps the ids of one store lookup", async () => {
    const store = new SqliteStore(":memory:");
    expect(await store.getMany([])).toEqual([]);
    expect(await store.getMany(Array.from({ length: GET_MANY_LIMIT }, (_, i) => i + 1))).toEqual([]);
    await expect(store.getMany(Array.from({ length: GET_MANY_LIMIT + 1 }, (_, i) => i + 1))).rejects.toThrow(
      RangeError,
    );
  });

  it("compresses the coordinates for clients that accept it", async () => {
    const plain = await app.request("/api/atlas?N=0&M=0&from=450&to=455");
    expect(plain.headers.get("content-encoding")).toBeNull();
    const text = await plain.text();
    const packed = await app.request("/api/atlas?N=0&M=0&from=450&to=455", { headers: { "accept-encoding": "gzip" } });
    expect(packed.headers.get("content-encoding")).toBe("gzip");
    const bytes = new Uint8Array(await packed.arrayBuffer());
    expect(bytes.length).toBeLessThan(text.length / 3);
    const unpacked = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    expect(unpacked).toBe(text);
  });

  it("is documented", async () => {
    const html = await (await app.request("/api")).text();
    expect(html).toContain("GET /api/atlas?N=&amp;M=&amp;from=&amp;to=");
    expect(html).toContain(`at most ${ATLAS_MAX_SPAN} values`);
  });
});

// The corpus holds saved configurations with the score recorded when they were saved.
// Client and server share one scoring routine; this guards the shared routine against drift
// and checks that the HTTP path returns exactly what the client computes.
describe("client and server agree on the corpus", () => {
  const dir = resolve(import.meta.dirname, "../../../data/corpus");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    it(file, async () => {
      const saved = JSON.parse(readFileSync(resolve(dir, file), "utf8"));
      const client = evaluate(saved.config, { autoOrient: true });
      expect(client.valid).toBe(true);
      expect(client.score).toBeCloseTo(saved.expected_score, 9);
      ip = file;
      const server = await submit({ ...saved.config, name: file });
      expect(server.body.score).toBe(client.score);
    });
  }
});
