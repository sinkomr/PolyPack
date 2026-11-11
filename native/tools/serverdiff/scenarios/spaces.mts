// Scenarios of the other families: the routes under /api/spaces, for each of the eight spaces, on
// the repository's own catalogues (data/<space>/). Valid configurations are real ones: research
// records, and the site's leading entries of the nightly snapshot where it is at hand.
import { getProblem, latticeStart } from "@polypack/polyhedra";
import { acceptsSubmissions } from "@polypack/spaces";
import { spaceAffected } from "../../../../apps/server/src/units-gate.ts";
import { AUTH, Scenario, rng } from "./dsl.mts";
import { NOLIMIT } from "./flat.mts";
import { Record_, recordById, SPACE_NAMES, SiteEntry, SpaceName, index, piecesKey, researchRecords, scaled, siteEntries } from "./data.mts";

const enc = encodeURIComponent;
const ENCODINGS = [undefined, "gzip", "gzip;q=0", "*", "*;q=0", "x-gzip", "GZIP", "br", "gzip;q=0.5, *;q=0", "identity", "gzip ; q=0.001", "deflate, gzip;q=abc", ""];
const body = (space: string, id: string, config: unknown, extra: Record<string, unknown> = {}) => ({
  space,
  id,
  config,
  name: "ann",
  units: "diameter",
  ...extra,
});

/** The read routes: the listing of the spaces, each space's records, problems, site-only pages, share links. */
function reads(): Scenario {
  const s = new Scenario("spaces-read", "spaces: reading", {
    about: "GET /api/spaces, the listing of each space with every Accept-Encoding, problems by id, site-only pages, entries, unknown spaces",
    options: { limits: NOLIMIT },
  });
  for (const e of ENCODINGS) s.get("/api/spaces", 200, e === undefined ? undefined : { "accept-encoding": e });
  for (const space of SPACE_NAMES) {
    s.get(`/api/spaces/${space}/records`, 200).get(`/api/spaces/${space}/problems`, 200, { "accept-encoding": "gzip" });
    s.get(`/api/spaces/${space}/records`, 200, { "accept-encoding": "gzip" }).get(`/api/spaces/${space}/site-only`, 200);
    const cat = index()[space]!;
    const some = [cat.problems[0], cat.problems[Math.floor(cat.problems.length / 2)], cat.problems[cat.problems.length - 1]].filter((p) => p);
    for (const p of some) s.get(`/api/spaces/${space}/problems/${p!.id}`, 200).get(`/api/spaces/${space}/problems/${p!.id}`, 200, { "accept-encoding": "gzip" });
    const closed = cat.problems.find((p) => !acceptsSubmissions(p));
    if (closed) s.get(`/api/spaces/${space}/problems/${closed.id}`, 200);
    // ids that are not of the space's form, of another space, outside the catalogue, or not a path
    const first = cat.problems[0]?.id ?? `${space}/x/1`;
    const parts = first.split("/");
    for (const id of [space, `${space}/`, "x", parts.slice(0, -1).join("/"), `${first}/1`, parts.slice(0, -1).concat("0").join("/"), parts.slice(0, -1).concat("99999").join("/"), parts.slice(0, -1).concat("1.5").join("/"), parts.slice(0, -1).concat("x").join("/"), first.replace(space, "nospace"), first.toUpperCase(), `${first}%20`, `%20${first}`, first.replace(/\//g, "%2F"), "%E0%A4%A", "%", first + "?x=1", parts.slice(0, -1).concat("01").join("/"), parts.slice(0, -1).concat("1e1").join("/"), parts.slice(0, -1).concat("+1").join("/")])
      s.get(`/api/spaces/${space}/problems/${id}`);
    for (const q of ["limit=1", "limit=5000", "limit=5001", "limit=0", "limit=x", "limit=", "limit=1&limit=2", "after=", `after=${enc(first)}`, "after=a&after=b", "other=1", "limit=2&after=zzz&x=1&y=2", "limit=1.5", "limit=1e1"])
      s.get(`/api/spaces/${space}/site-only?${q}`);
  }
  for (const path of ["nospace/records", "nospace/problems", "nospace/site-only", "nospace/problems/x/1", "Sphere/records", "sphere/records/", "sphere/nothing", "sphere", "sphere/", "/records", "entries", "entries/", "submit"])
    s.get(`/api/spaces/${path}`);
  for (const id of ["1", "0", "abc", "1.5", "-1", "1e0", "0x1", "999999", "01", "1234567890", "%31", "%201"]) s.get(`/api/spaces/entries/${id}`);
  s.req("POST", "/api/spaces").req("POST", "/api/spaces/sphere/records").req("PUT", "/api/spaces/submit").req("HEAD", "/api/spaces").req("HEAD", "/api/spaces/sphere/records");
  s.get("/api/leaders?keys=" + SPACE_NAMES.map((sp) => index()[sp]!.problems[0]?.id ?? `${sp}/x`).join(","), 200);
  return s;
}

/** POST /api/spaces/submit: the body's own errors, before any geometry. */
function bodies(recs: Record_[]): Scenario {
  const s = new Scenario("spaces-submit-bodies", "spaces: submit", {
    about: "malformed bodies, wrong space, id, name, note, software, method, seed, config; the body limit; closed problems; the units gate",
    options: { limits: NOLIMIT },
  });
  const ip = { "x-test-client-ip": "10.0.0.1" };
  const r = recordById("sphere", "sphere/3/6") ?? recs[0]!;
  for (const text of ["{", "", "nul", "﻿{}", '{"space":"sphere",}'])
    s.req("POST", "/api/spaces/submit", { text, headers: ip, expect: 400 });
  for (const text of ["null", "[]", '"x"', "5", "true", "[{}]"]) s.req("POST", "/api/spaces/submit", { text, headers: ip, expect: 400 });
  const good = body(r.space, r.id, r.config);
  const bad = (change: Record<string, unknown>, expect?: number) => s.spaceSubmit({ ...good, ...change }, expect);
  bad({}, 200);
  for (const space of [undefined, null, 5, "", "nospace", "Sphere", ["sphere"], "sphere "]) bad({ space }, 400);
  for (const id of [undefined, null, 5, "", "sphere", "sphere/", "sphere/3", "sphere/3/0", "sphere/3/x", "sphere/2/5", "sphere/3/101", "sphere/3/6/7", "torus/sq/0/2", ["sphere/3/6"], {}, "sphere/3/6 ", "sphere/03/6", "sphere/3/1e1", "sphere/101/2", "sphere/3/1.0"])
    bad({ id }, 400);
  for (const name of [undefined, null, 5, "", "   ", "<>", ["ann"]]) bad({ name }, 400);
  for (const agent_note of [5, [], {}, true]) bad({ agent_note }, 400);
  for (const software of [5, [], "s".repeat(81)]) bad({ software }, 400);
  for (const method of [5, {}, "m".repeat(81)]) bad({ method }, 400);
  for (const seed of [-1, 1.5, "1", 9007199254740992, [], {}]) bad({ seed }, 400);
  bad({ config: undefined }, 400);
  bad({ name: 5, agent_note: 5, software: 5, method: 5, seed: -1, config: undefined }, 400);
  // accepted forms of the optional fields
  bad({ agent_note: null, software: null, method: null, seed: null }, 200);
  bad({ agent_note: " a <b>note</b> " + "n".repeat(300), software: "  soft\tware ", method: "m".repeat(80), seed: 0 }, 200);
  bad({ agent_note: "", software: " ", method: "\u0001", seed: 9007199254740991, extra: { ignored: true } }, 200);
  // the body limit
  const head = JSON.stringify(good).slice(0, -1) + ',"agent_note":"';
  s.req("POST", "/api/spaces/submit", { repeat: { prefix: head, text: "a", count: 262144 - head.length - 2, suffix: '"}' }, headers: ip, expect: 200 });
  s.req("POST", "/api/spaces/submit", { repeat: { prefix: head, text: "a", count: 262145 - head.length - 2, suffix: '"}' }, headers: ip, expect: 413 });
  s.req("POST", "/api/spaces/submit", { repeat: { prefix: head, text: "a", count: 262145 - head.length - 2, suffix: '"}' }, headers: ip, chunked: 30000, expect: 413 });
  s.req("POST", "/api/spaces/submit", { json: good, headers: ip, chunked: 64, expect: 200 });
  // closed problems (409 before the packing is looked at) and the units gate (426 before that)
  for (const space of SPACE_NAMES) {
    const cat = index()[space]!;
    const closed = cat.problems.filter((p) => !acceptsSubmissions(p)).slice(0, 2);
    for (const p of closed) {
      s.spaceSubmit(body(space, p.id, {}), 409).spaceSubmit(body(space, p.id, { anything: 1 }, { units: undefined }));
      s.spaceSubmit(body(space, p.id, {}, { name: "" }), 409);
    }
    const affected = cat.problems.find((p) => acceptsSubmissions(p) && spaceAffected(space, p.id));
    const free = cat.problems.find((p) => acceptsSubmissions(p) && !spaceAffected(space, p.id));
    if (affected) {
      s.spaceSubmit(body(space, affected.id, {}, { units: undefined }), 426).spaceSubmit(body(space, affected.id, {}, { units: "radius" }), 400);
      s.spaceSubmit(body(space, affected.id, {}, { units: 2 }), 400).spaceSubmit(body(space, affected.id, {}, { units: null }), 400).spaceSubmit(body(space, affected.id, {}));
    }
    if (free) s.spaceSubmit(body(space, free.id, {}, { units: undefined })).spaceSubmit(body(space, free.id, {}, { units: "furlong" }));
  }
  // disk and ball problems of the domains that have no research record
  for (const [space, id] of [["balls", "balls/ballinball/2"], ["balls", "balls/ballincub/3"], ["balls", "balls/tetinball/2"], ["balls", "balls/cubincub/2"], ["curved", "curved/1/0/0/3"], ["curved", "curved/0.5/3/0/2"], ["curved", "curved/-1/0/5/2"], ["ndim", "ndim/4/ball/cube/2"], ["boundary", "boundary/5cube/ball/2"], ["surface", "surface/cube/fold/0/3"], ["torus", "torus/hex/0/7"]] as const)
    s.spaceSubmit(body(space, id, {}, { units: undefined })).spaceSubmit(body(space, id, {}));
  s.control({ flushStats: true });
  return s;
}

/** Generic damage to a configuration: each is refused as malformed (400) or invalid (422) by the space's own rules. */
function damaged(space: SpaceName, c: Record<string, unknown>): unknown[] {
  const key = piecesKey(space);
  const list = (c[key] as unknown[]) ?? [];
  const out: unknown[] = [null, [], "x", 5, {}, true];
  for (const k of Object.keys(c)) {
    const { [k]: _gone, ...rest } = c;
    out.push(rest, { ...c, [k]: "x" }, { ...c, [k]: null }, { ...c, [k]: -1 }, { ...c, [k]: 0 }, { ...c, [k]: [] }, { ...c, [k]: {} });
  }
  out.push({ ...c, [key]: [null] }, { ...c, [key]: ["x"] }, { ...c, [key]: [{}] }, { ...c, [key]: [[]] }, { ...c, [key]: list.slice(0, -1) });
  out.push({ ...c, [key]: [...list, list[0]] }, { ...c, [key]: [...list, ...list] }, { ...c, unknown_field: 1 });
  const first = list[0];
  if (Array.isArray(first)) {
    out.push({ ...c, [key]: [first.map(() => "1"), ...list.slice(1)] }, { ...c, [key]: [first.slice(0, -1), ...list.slice(1)] });
    out.push({ ...c, [key]: [[...first, 0], ...list.slice(1)] }, { ...c, [key]: [first.map(() => null), ...list.slice(1)] });
    out.push({ ...c, [key]: [first.map(() => 1e7), ...list.slice(1)] }, { ...c, [key]: [first.map(() => 0), ...list.slice(1)] });
  } else if (first && typeof first === "object") {
    for (const k of Object.keys(first)) {
      const { [k]: _gone, ...rest } = first as Record<string, unknown>;
      out.push({ ...c, [key]: [rest, ...list.slice(1)] }, { ...c, [key]: [{ ...first, [k]: "x" }, ...list.slice(1)] });
      out.push({ ...c, [key]: [{ ...first, [k]: -7 }, ...list.slice(1)] }, { ...c, [key]: [{ ...first, [k]: 1e9 }, ...list.slice(1)] });
      out.push({ ...c, [key]: [{ ...first, [k]: [1] }, ...list.slice(1)] }, { ...c, [key]: [{ ...first, [k]: 0.5 }, ...list.slice(1)] });
    }
    out.push({ ...c, [key]: [{ ...first, unknown_field: 1 }, ...list.slice(1)] });
  }
  return out;
}

/** One space: research records posted back and damaged, the site's leading entries replayed, ties, moderation. */
function oneSpace(space: SpaceName, recs: Record_[], site: SiteEntry[]): Scenario {
  const s = new Scenario(`spaces-${space}`, "spaces: submit", {
    about: `${space}: research records posted back, shrunk and damaged; leading entries replayed, tied, beaten, edited, removed`,
    options: { limits: NOLIMIT },
  });
  const pages = (id: string) => s.get(`/api/spaces/${space}/problems/${id}`).get(`/api/leaders?keys=${id}`);
  for (const r of recs) {
    pages(r.id);
    s.spaceSubmit(body(space, r.id, r.config));
    for (const f of [1 - 1e-10, 1 - 3e-9, 1 - 1e-6, 0.9, 0.5, 1.000001, 1.01, 2])
      s.spaceSubmit(body(space, r.id, scaled(space, r.id, r.config, f), { name: `scaled ${f}` }));
    pages(r.id);
  }
  // damage: on the first record, and on a problem whose entry could be kept (a site entry's)
  const victim = recs[0];
  if (victim) for (const c of damaged(space, victim.config)) s.spaceSubmit(body(space, victim.id, c));
  const first = site[0];
  if (first) for (const c of damaged(space, first.config).slice(6)) s.spaceSubmit(body(space, first.problem, c));
  // the site's entries: the first is kept, the same again is a tie and is not, a worse one is not
  let kept = 0;
  for (const e of site) {
    const b = body(space, e.problem, e.config, { name: e.name, software: e.software, method: e.method });
    s.spaceSubmit({ ...b, units: undefined }).spaceSubmit(b);
    s.spaceSubmit({ ...b, name: "the same again" });
    s.spaceSubmit(body(space, e.problem, scaled(space, e.problem, e.config, 1.001), { name: "worse" }));
    s.spaceSubmit(body(space, e.problem, scaled(space, e.problem, e.config, 1 - 2e-10), { name: "inside the tie" }));
    s.spaceSubmit(body(space, e.problem, scaled(space, e.problem, e.config, 1 - 1e-7), { name: "squeezed" }));
    pages(e.problem);
    kept++;
  }
  s.get(`/api/spaces/${space}/records`, 200).get(`/api/spaces/${space}/records`, 200, { "accept-encoding": "gzip" });
  s.get(`/api/spaces/${space}/site-only`, 200).get(`/api/spaces/${space}/site-only?limit=2`);
  if (site[1]) s.get(`/api/spaces/${space}/site-only?limit=2&after=${enc(site[1].problem)}`);
  for (let id = 1; id <= Math.min(2 * kept + 2, 12); id++) s.get(`/api/spaces/entries/${id}`).get(`/api/spaces/entries/${id}`, undefined, { "accept-encoding": "gzip" });
  s.get("/api/leaders?keys=" + site.map((e) => e.problem).concat(recs.map((r) => r.id)).slice(0, 60).join(","));
  // moderation
  s.post("/api/admin/spaces/remove", { id: 1 }, 401).post("/api/admin/spaces/edit", { id: 1, name: "x" }, 401);
  s.admin("/api/admin/spaces/edit", { id: 1, name: "  A <new> name ", agent_note: "edited\nnote" }).get("/api/spaces/entries/1");
  s.admin("/api/admin/spaces/edit", { id: 1 }).admin("/api/admin/spaces/edit", { id: 1, agent_note: "" }).admin("/api/admin/spaces/edit", { id: 1, config: {}, score: 0 });
  for (const b of [null, [], {}, { id: "1" }, { id: 1.5 }, { id: 1, name: "" }, { id: 1, name: 5 }, { id: 1, agent_note: 5 }, { id: 1, name: " ", agent_note: [] }, "x"])
    s.admin("/api/admin/spaces/edit", b, 400);
  s.admin("/api/admin/spaces/edit", { id: 99999, name: "x" }, 404).admin("/api/admin/spaces/edit", { id: 99999 }, 404);
  s.req("POST", "/api/admin/spaces/edit", { text: "{", headers: AUTH, expect: 400 }).req("POST", "/api/admin/spaces/remove", { text: "", headers: AUTH, expect: 400 });
  s.get(`/api/spaces/${space}/records`, 200);
  for (const b of [null, [], {}, { id: "1" }, { id: 1.5 }]) s.admin("/api/admin/spaces/remove", b, 400);
  s.admin("/api/admin/spaces/remove", { id: 1 }).admin("/api/admin/spaces/remove", { id: 1 }, 404).admin("/api/admin/spaces/remove", { id: 99999 }, 404);
  if (first) {
    pages(first.problem);
    s.get("/api/spaces/entries/1").get(`/api/spaces/${space}/records`, 200).get(`/api/spaces/${space}/site-only`, 200);
    // the removed entry's problem takes it again
    s.spaceSubmit(body(space, first.problem, first.config, { name: "back again" }));
    pages(first.problem);
  }
  s.control({ flushStats: true });
  return s;
}

/** The heavy checks: one at a time per address, one at a time on the server, a few waiting, the rest refused. */
function heavy(): Scenario {
  const s = new Scenario("spaces-heavy", "spaces: submit", {
    about: "500 polyhedra: one entry at a time per address (429), the queue of heavy checks and its refusal (503); these answers depend on a check outlasting the arrival of the next request",
    options: { limits: NOLIMIT },
  });
  // 500 truncated icosidodecahedra on a lattice, the last one a copy of the first: the whole scan runs, then 422
  const id = "polyhedra/tidintid/500";
  const config = latticeStart(getProblem("tidintid")!, 500);
  const forged = { ...config, pieces: [...config.pieces.slice(0, 499), [...config.pieces[0]!]] };
  const one = (ip: string) => ({ method: "POST", path: "/api/spaces/submit", headers: { "x-test-client-ip": ip }, json: body("polyhedra", id, forged) });
  s.spaceSubmit(body("polyhedra", id, forged), 422);
  // eight at once from one address: one is checked, the others are told to wait
  s.add({ op: "burst", unordered: true, requests: Array.from({ length: 8 }, () => one("10.2.0.1")) });
  // twelve at once from twelve addresses: one runs, eight wait their turn, three are refused
  s.add({ op: "burst", unordered: true, requests: Array.from({ length: 12 }, (_, i) => one(`10.1.0.${i}`)) });
  // a malformed heavy body is refused before the queue and before the address's one check
  // (sent 15 ms apart, so that the first is being checked when the others arrive)
  s.add({ op: "burst", staggerMs: 15, requests: [one("10.3.0.1"), { ...one("10.3.0.1"), json: body("polyhedra", id, { s: "x" }) }, { ...one("10.3.0.2"), json: body("polyhedra", id, { ...forged, pieces: forged.pieces.slice(1) }) }] });
  // a valid one is kept: the problem has no research record
  s.spaceSubmit(body("polyhedra", "polyhedra/cubincub/500", latticeStart(getProblem("cubincub")!, 500)), 200);
  s.get("/api/spaces/polyhedra/problems/polyhedra/cubincub/500", 200, { "accept-encoding": "gzip" }).get("/api/spaces/polyhedra/site-only", 200);
  s.spaceSubmit(body("polyhedra", "polyhedra/cubincub/500", latticeStart(getProblem("cubincub")!, 500)), 200);
  s.control({ flushStats: true });
  return s;
}

/** Every space as a domain without research records: an empty data directory. */
function withoutRecords(site: SiteEntry[]): Scenario {
  const s = new Scenario("spaces-no-records", "spaces: reading", {
    about: "a server whose data directory holds no records: every space is its domain alone",
    options: { limits: NOLIMIT, spacesRoot: "{tmp}/empty" },
    autostart: false,
  });
  s.add({ op: "file", path: "empty/data/keep", text: "" });
  s.add({ op: "file", path: "empty/data/sphere/records.json", text: "{ not json" });
  s.add({ op: "file", path: "empty/data/torus/records.json", text: JSON.stringify({ generated: "serverdiff", records: [{ problem: "torus/sq/0/1", family: "sq", N: 0, P: 1, score_cert: 1.000000000001, display: "1.000000", status: "best_known", configuration: { lattice: { L: 1 }, poses: [[0, 0, 0]] }, bound: { value: 1, label: "one disk" } }, { problem: "torus/nope/0/1" }, 5] }) });
  s.add({ op: "start" });
  s.get("/api/spaces", 200);
  for (const space of SPACE_NAMES) s.get(`/api/spaces/${space}/records`).get(`/api/spaces/${space}/site-only`);
  for (const e of site.slice(0, 24)) {
    s.spaceSubmit(body(e.space, e.problem, e.config, { name: e.name }));
    s.get(`/api/spaces/${e.space}/problems/${e.problem}`);
  }
  for (const space of SPACE_NAMES) s.get(`/api/spaces/${space}/records`).get(`/api/spaces/${space}/site-only`).get(`/api/spaces/${space}/site-only?limit=1`);
  s.get("/api/leaders?keys=" + site.slice(0, 24).map((e) => e.problem).join(","));
  return s;
}

export async function spaceScenarios(): Promise<Scenario[]> {
  const out: Scenario[] = [reads()];
  const allRecs: Record_[] = [];
  const allSite: SiteEntry[] = [];
  const perSpace: Scenario[] = [];
  for (const space of SPACE_NAMES) {
    const recs = researchRecords(space, 4, space === "polyhedra" || space === "ndim" ? 12 : 30, 7);
    const random = rng(11);
    // a few leading entries of small problems, and one of a large one where the snapshot has one
    const snap = await siteEntries(space);
    // one small entry of each kind of problem (the second part of the id: the solid, the curvature, the torus, the
    // polytope, the pair of solids, the dimension), seven kinds at most, drawn with a fixed seed
    const kinds = new Map<string, SiteEntry>();
    for (const e of snap.filter((x) => x.P <= 12)) {
      const kind = e.problem.split("/")[1]!;
      const had = kinds.get(kind);
      if (!had || e.P < had.P) kinds.set(kind, e);
    }
    const small = [...kinds.values()].map((e) => [random(), e] as const).sort((a, b) => a[0] - b[0]).slice(0, 7).map((x) => x[1]);
    const large = snap.filter((e) => e.P >= 30 && e.P <= 60).slice(0, 1);
    const site = [...small, ...large];
    allRecs.push(...recs);
    allSite.push(...small.slice(0, 3));
    perSpace.push(oneSpace(space, recs, site));
  }
  out.push(bodies(allRecs), ...perSpace);
  out.push(heavy(), withoutRecords(allSite));
  return out;
}
