import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { createApp } from "../../server/src/app";
import { SqliteStore } from "../../server/src/sqlite-store";
import { SITE_UNITS } from "../src/api";
import { spaceSubmissionBody } from "../src/tighter/space-submission";
import { answerTrouble, classifyAnswer, submissionBody, troubleText } from "../src/tighter/submission";

// Trouble with sending, as the notice line under the board tells it: what happened, then what the
// game does next. Points waiting for the server's answer are not shown at all.

const TITLE = "24-gons in a 30-gon, 3 pieces";
const trouble = (status: number | null, body: unknown = null, timedOutAfter: number | null = null) =>
  answerTrouble(classifyAnswer(status, body), status, timedOutAfter, TITLE, "5.7");

describe("Tighter trouble with sending", () => {
  it("is nothing for an answer the game can act on", () => {
    expect(trouble(200, { valid: true, score: 9.5, leader: true, id: 4 })).toBeNull();
    expect(trouble(200, { valid: true, score: 9.5, leader: false, leader_score: 9.3 })).toBeNull();
    expect(trouble(409, { reasons: ["this problem is closed"] })).toBeNull();
  });

  it("tells an unreachable server, a late answer, a 5xx and a 429 apart, each with when sending tries again", () => {
    expect(troubleText(trouble(null)!)).toBe("The server cannot be reached. Sending will try again in 30 seconds.");
    expect(troubleText(trouble(null, null, 30_000)!)).toBe(
      "The server did not answer within 30 seconds. Sending will try again in 30 seconds.",
    );
    expect(troubleText(trouble(502)!)).toBe(
      "The server answered with an error (502). Sending will try again in 30 seconds.",
    );
    expect(troubleText(trouble(429, { reasons: ["too many submissions from this address; wait a minute"] })!)).toBe(
      "The server says too many submissions came from your address. Sending will try again in a minute.",
    );
  });

  it("names the refused board, the server's reasons (the first two) and the points taken back", () => {
    expect(troubleText(trouble(400, { valid: false, reasons: ["name is required"] })!)).toBe(
      `The server refused your board on ${TITLE} (name is required). The 5.7 RP it paid were taken back. Your next better board will be sent as usual.`,
    );
    const overlaps = Array.from({ length: 20 }, (_, i) => `pieces ${i} and ${i + 1} overlap`);
    const text = troubleText(
      answerTrouble(classifyAnswer(422, { valid: false, reasons: overlaps }), 422, null, TITLE, null)!,
    );
    expect(text).toBe(
      `The server refused your board on ${TITLE} (pieces 0 and 1 overlap, pieces 1 and 2 overlap and 18 more). Your next better board will be sent as usual.`,
    );
  });

  it("says when an answer that never came cannot be checked, and when the game checks again", () => {
    expect(troubleText({ kind: "lost", title: TITLE })).toBe(
      `The server never answered your board on ${TITLE}, and it cannot be reached to check whether the board arrived. The game checks again in 30 seconds.`,
    );
  });

  it("is written in plain sentences: no semicolons, no colons, no dashes", () => {
    const all = [
      troubleText({ kind: "unreachable" }),
      troubleText({ kind: "timeout", waitedMs: 30_000 }),
      troubleText({ kind: "error", status: 500 }),
      troubleText({ kind: "rate-limited" }),
      troubleText({ kind: "refused", title: TITLE, reasons: ["x"], takenBack: "1.0" }),
      troubleText({ kind: "lost", title: TITLE }),
    ];
    for (const t of all) expect(t).not.toMatch(/[;:—–]/);
  });
});

// Since 2026-10-27 disks and balls have diameter 1, and the server refuses a board of a problem with disk
// or ball pieces or a circle or ball container unless it says `"units": "diameter"`.
describe("Tighter's sends", () => {
  const ROOT = resolve(import.meta.dirname, "../../..");
  const source = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
  const run = { method: "mc_compress", params: {}, seed: 1, budget: { evals: 100 } };
  /** Two disks of diameter 1 in a circle of diameter 2. */
  const disks = {
    N: 0,
    M: 0,
    P: 2,
    pieces: [
      { x: -0.5, y: 0, theta: 0 },
      { x: 0.5, y: 0, theta: 0 },
    ],
    container_phi: 0,
  };
  const balls = {
    s: 2,
    pieces: [
      [0.5, 0, 0],
      [-0.5, 0, 0],
    ],
  };

  it("carry the units in both bodies", () => {
    expect(SITE_UNITS).toBe("diameter");
    expect(submissionBody(disks, "Ada", run).units).toBe("diameter");
    // a polygon problem too: the field is harmless where the change did not reach
    expect(submissionBody({ ...disks, N: 24, M: 30 }, "Ada", run).units).toBe("diameter");
    expect(spaceSubmissionBody({ family: "balls", id: "balls/ballinball/2" }, balls, "Ada", run).units).toBe(
      "diameter",
    );
  });

  it("all go through those two bodies", () => {
    const dir = "apps/web/src/tighter";
    const files = (d: string): string[] =>
      readdirSync(resolve(ROOT, d), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(`${d}/${e.name}`) : /\.ts$/.test(e.name) ? [`${d}/${e.name}`] : [],
      );
    // the submit routes are named only where the two posts are: api.ts (outside Tighter) and space-submission.ts
    const naming = files(dir).filter((f) => /["'`]\/api\/(?:spaces\/)?submit["'`]/.test(source(f)));
    expect(naming).toEqual([`${dir}/space-submission.ts`]);
    const main = source(`${dir}/main.ts`);
    const count = (re: RegExp) => (main.match(re) ?? []).length;
    expect(count(/api\.postSubmission\(/g)).toBe(1);
    expect(count(/api\.postSubmission\(submissionBody\(/g)).toBe(1);
    expect(count(/postSpaceSubmission\(/g)).toBe(1);
    expect(count(/postSpaceSubmission\(spaceSubmissionBody\(/g)).toBe(1);
    expect(count(/api\.submit\(/g)).toBe(0);
  });

  it("are taken by the server, which refuses the same boards without the units", async () => {
    const store = new SqliteStore(":memory:");
    const app = createApp({
      store,
      records: [],
      clientIp: () => "1.1.1.1",
      log: () => {},
      spaces: { index: loadSpacesIndex(ROOT), store },
    });
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const planar = submissionBody(disks, "Ada", run);
    const { units: _, ...bare } = planar;
    expect((await post("/api/submit", bare)).status).toBe(426);
    const r = await post("/api/submit", planar);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ valid: true, score: 2 });
    const space = spaceSubmissionBody({ family: "balls", id: "balls/ballinball/2" }, balls, "Ada", run);
    const { units: __, ...bareSpace } = space;
    expect((await post("/api/spaces/submit", bareSpace)).status).toBe(426);
    expect((await post("/api/spaces/submit", space)).status).toBe(200);
  });
});
