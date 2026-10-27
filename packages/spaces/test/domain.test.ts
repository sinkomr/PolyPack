/**
 * Spaces whose problems are given by a domain (domain.ts): records only where they exist, any id of the domain a
 * problem (status no_record) with its bound, the strict check of every entry of such a problem, and the loading of
 * a space with a domain and no records file.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SPACE_DOMAINS,
  SPACE_STRICT_NO_RECORD_REASON,
  acceptsSubmissions,
  buildSpaceCatalogue,
  domainId,
  domainMaxP,
  hasRecord,
  parseSpaceId,
  problemOf,
  spaceProblemSummary,
  validateSpaceSubmission,
} from "../src";
import { loadSpacesIndex } from "../src/load";
import { checkSpaceConfig } from "../src/search";
import { TORUS_TEST_DOMAIN } from "./testing-domain";

const L2 = 2 * Math.SQRT2;
const record = (P: number) => ({
  problem: `torus/sq/0/${P}`,
  family: "sq",
  N: 0,
  P,
  score_cert: 3,
  display: "3.000000",
  status: "best_known",
  configuration: {
    lattice: { L: 3 },
    poses: [
      [0, 0, 0],
      [1.5, 1.5, 0],
    ],
  },
  bound: { value: L2, label: "a test bound" },
});
const id = (text: string) => {
  const p = parseSpaceId("torus", text);
  if (typeof p === "string") throw new Error(p);
  return p;
};
const twoDisks = (k: number) => ({
  lattice: { L: L2 * Math.max(1, k) },
  poses: [
    [0, 0, 0],
    [Math.SQRT2 * k, Math.SQRT2 * k, 0],
  ],
});

describe("a catalogue with a domain", () => {
  it("holds the records only, and makes any other problem of the domain on demand", () => {
    const c = buildSpaceCatalogue(
      "torus",
      { records: [record(2), { ...record(2), problem: "torus/sq/0/4", P: 4 }] },
      TORUS_TEST_DOMAIN,
    );
    // a record outside the domain is left out
    expect(c.problems.map((p) => p.id)).toEqual(["torus/sq/0/2"]);
    expect(c.skipped).toEqual(["torus/sq/0/4: outside the space's domain"]);
    expect(c.maxP).toBe(3);
    expect(problemOf(c, id("torus/sq/0/2"))!.status).toBe("best_known");
    const p = problemOf(c, id("torus/sq/0/3"))!;
    expect(p).toMatchObject({ status: "no_record", certified: null, config: null, closed_reason: null });
    expect(p.bound!.value).toBeCloseTo(Math.sqrt(3 * Math.PI), 14);
    expect(acceptsSubmissions(p)).toBe(true);
    expect(hasRecord(p)).toBe(false);
    // the space's id but outside the domain: no problem
    expect(problemOf(c, id("torus/sq/0/5"))).toBeNull();
    expect(problemOf(c, id("torus/hex/0/2"))).toBeNull();
    // without a domain, only the records
    expect(problemOf(buildSpaceCatalogue("torus", { records: [record(2)] }), id("torus/sq/0/3"))).toBeNull();
    // a domain and no records file
    expect(buildSpaceCatalogue("torus", null, TORUS_TEST_DOMAIN).skipped).toEqual([]);
    expect(buildSpaceCatalogue("torus", null).skipped).toEqual(["the file has no records list"]);
  });

  it("describes its fields, and writes an id from them", () => {
    expect(domainMaxP(TORUS_TEST_DOMAIN)).toBe(3);
    expect(domainId(TORUS_TEST_DOMAIN.info, { family: "sq", N: 0, P: 3 })).toBe("torus/sq/0/3");
    expect(TORUS_TEST_DOMAIN.sample(1)).toEqual(["torus/sq/0/2"]);
  });

  it("summarises a problem without a record with no best until a site entry", () => {
    const c = buildSpaceCatalogue("torus", null, TORUS_TEST_DOMAIN);
    const p = problemOf(c, id("torus/sq/0/3"))!;
    expect(spaceProblemSummary(p, null)).toMatchObject({
      status: "no_record",
      certified: null,
      best_score: null,
      accepts_submissions: true,
    });
    const site = { id: 4, score: 3.5, name: "ann", created_at: "2026-10-25T00:00:00.000Z" };
    expect(spaceProblemSummary(p, site).best_score).toBe(3.5);
  });

  it("asks the strict check of every entry of a problem without a record", () => {
    const pid = "torus/sq/0/2";
    // an overlap of 4e-10: within the touching tolerance, not within the strict one
    const loose = twoDisks(1 - 2e-10);
    expect(validateSpaceSubmission("torus", pid, loose).valid).toBe(true);
    const v = validateSpaceSubmission("torus", pid, loose, { noRecord: true });
    expect(v.valid).toBe(false);
    expect(v.reasons[0]).toBe(SPACE_STRICT_NO_RECORD_REASON);
    expect(validateSpaceSubmission("torus", pid, twoDisks(1), { noRecord: true }).valid).toBe(true);
    // the searches' check applies the same rule
    expect(checkSpaceConfig("torus", pid, loose, { noRecord: true }).valid).toBe(false);
    expect(checkSpaceConfig("torus", pid, loose, {}).valid).toBe(true);
  });
});

describe("a space with a domain", () => {
  const saved = SPACE_DOMAINS.torus;
  afterEach(() => {
    if (saved) SPACE_DOMAINS.torus = saved;
    else delete SPACE_DOMAINS.torus;
  });

  it("is loaded without a records file, with one line of log", () => {
    SPACE_DOMAINS.torus = TORUS_TEST_DOMAIN;
    const empty = mkdtempSync(join(tmpdir(), "polypack-domain-"));
    const logs: string[] = [];
    const index = loadSpacesIndex(empty, (m) => logs.push(m));
    expect(index.torus!.problems).toEqual([]);
    expect(index.torus!.domain).toBe(TORUS_TEST_DOMAIN);
    expect(logs).toContain("[spaces] torus: a domain of 2 problems, 0 with a record (no records file)");
    expect(index.boundary).toBeUndefined();
    expect(index.sphere!.domain).toBe(SPACE_DOMAINS.sphere);
  });
});
