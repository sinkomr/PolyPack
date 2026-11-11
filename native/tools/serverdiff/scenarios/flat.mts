// Scenarios of the polygon ("flat") family: POST /api/submit and every route that reads its entries.
// The literature is fixtures/records.json, small and made up, so that each case is there by design:
// 4/4/2 proven (closed), 4/4/3 easy to beat (review), 4/4/4 a tiling (closed), 4/4/5 and 4/4/8 with
// coordinates, 4/4/6 unrefereed (open), 4/4/7 without coordinates, 0/0/2 closed disks, and so on.
import { SOLVER_METHODS } from "../../../../apps/server/src/docs.ts";
import { AUTH, Pose, Scenario, SQ, disks, grid, row, squares } from "./dsl.mts";

export const NOLIMIT = { perIp: 1_000_000, verifyMsPerMinute: 1e12, perKey: 1_000_000, keyVerifyMsPerMinute: 1e12 };
const METHODS = SOLVER_METHODS.map(([name]) => name);
const scaled = (pieces: Pose[], f: number): Pose[] => pieces.map((p) => ({ ...p, x: p.x * f, y: p.y * f }));
const enc = encodeURIComponent;
/** `levels` arrays, one inside the other. */
const nest = (levels: number): unknown => {
  let v: unknown = [];
  for (let i = 1; i < levels; i++) v = [v];
  return v;
};
/** `levels` objects `{"a": ...}`, one inside the other, around a 1. */
const nestObjects = (levels: number): unknown => {
  let v: unknown = 1;
  for (let i = 0; i < levels; i++) v = { a: v };
  return v;
};

/** POST /api/submit: what it accepts and every way it refuses. */
function submit(): Scenario {
  const s = new Scenario("flat-submit", "flat: submit", {
    about: "valid and invalid polygon submissions, malformed bodies, every field's wrong types, body limits, units, closed problems",
    options: { limits: NOLIMIT },
  });
  s.get("/api/health", 200).req("HEAD", "/api/health").get("/api", 200).req("HEAD", "/api");
  // the problem page: open, closed, with coordinates, and every way N, M, P can be wrong (Number() reads them)
  for (const p of ["4/4/11", "4/4/2", "4/4/5", "4/4/3", "0/0/1", "0/0/2", "3/100/500", "100/0/1", "04/4/1", "4/4/1e2", "0x10/4/1", "4.0/4/1", "+4/4/1", "%204/4/1"])
    s.get(`/api/problems/${p}`, 200);
  for (const p of ["2/4/1", "4/4/0", "4/4/501", "x/4/1", "4/101/1", "4/4/1.5", "1/1/1", "-4/4/1", "4/4/-1", "Infinity/4/1", "4/4/", "4/4/NaN", "4/4/1/2", "4/4"])
    s.get(`/api/problems/${p}`);
  for (const p of ["4/4/11", "4/4/2", "2/4/1", "4/4/501", "0/0/3"]) s.get(`/api/leaderboard/${p}`);

  // valid: stored with the score the server computes, at the phi sent
  s.submit(squares(11, {}, grid(11, 4)), 200);
  s.get("/api/leaderboard/4/4/11", 200).get("/api/submissions/1", 200).get("/api/problems/4/4/11", 200);
  s.submit(squares(10, { container_phi: 0.3 }, grid(10, 4)), 200);
  s.submit(squares(10, { container_phi: -7.5 }, grid(10, 4)), 200);
  s.submit({ ...squares(12, {}, grid(12, 4)), container_phi: undefined }, 200);
  s.submit({ N: 3, M: 5, P: 2, pieces: [{ x: 0, y: 0 }, { x: 1.2, y: 0.1 }], name: "theta left out" }, 200);
  s.submit({ N: 100, M: 100, P: 3, pieces: [{ x: 0, y: 0, theta: 0.1 }, { x: 40, y: 0, theta: 1 }, { x: 0, y: 40, theta: -2 }], name: "hectogons" }, 200);
  s.submit({ N: 5, M: 3, P: 1, pieces: [{ x: 1e6, y: -1e6, theta: 1e300 }], name: "at the coordinate limit" });
  s.submit({ N: 4, M: 7, P: 2, pieces: row(2), container_phi: 1e-320, name: "a denormal phi" }, 200);
  s.req("POST", "/api/submit", { text: '{"N":4,"M":4,"P":2,"container_phi":-0.0,"name":"minus zero","pieces":[{"x":-0,"y":-0.0,"theta":-0e0},{"x":-2,"y":-0,"theta":0}]}', headers: { "x-test-client-ip": "10.0.0.1" }, note: "closed, 409" });
  s.req("POST", "/api/submit", { text: '{"N":4,"M":4,"P":13,"container_phi":-0.0,"name":"minus zero","pieces":' + JSON.stringify(grid(13, 4)).replace(/"y":0,/g, '"y":-0.0,') + "}", headers: { "x-test-client-ip": "10.0.0.1" }, expect: 200 });
  // container, score and extra fields in the body are ignored
  s.submit({ ...squares(14, {}, grid(14, 4)), score: 1, container: { size: 1 }, rank: 1, id: 77, extra: [1, 2] }, 200);

  // invalid packings: 422 with reasons
  s.submit(squares(11, {}, row(11, 0.5)), 422);
  s.submit(squares(11, {}, row(10)), 422);
  s.submit(squares(11, {}, row(12, 0.25)), 422);
  s.submit(squares(11, {}, []), 422);
  s.submit(squares(40, {}, Array.from({ length: 40 }, () => ({ x: 0, y: 0, theta: 0 }))), 422);
  s.submit(squares(3, {}, scaled(row(3), 1 - 5e-10)));
  s.submit(squares(3, { name: "just overlapping" }, scaled(row(3), 1 - 3e-9)), 422);
  s.submit({ N: 0, M: 3, P: 2, pieces: disks(2, 0.9), name: "disks", units: "diameter" }, 422);

  // not JSON, and JSON that is not an object
  for (const text of ["{", "", " ", "nul", "{'N':4}", '{"N":4,}', "﻿{}", '{"N":4}{"N":5}', "NaN", "[1,2", '"abc'])
    s.req("POST", "/api/submit", { text, headers: { "content-type": "application/json", "x-test-client-ip": "10.0.0.1" }, expect: 400 });
  for (const text of ["null", "[]", '"text"', "5", "true", "{}", "[{}]"])
    s.req("POST", "/api/submit", { text, headers: { "x-test-client-ip": "10.0.0.1" }, expect: 400 });
  // a backslash before a character of two, three and four bytes, at the end of the text, and an escape cut short: not JSON
  // (the Rust server once answered 500 to the first three)
  for (const text of ['{"x":"\\é"}', '{"N":4,"name":"\\€"}', '["\\😀"]', '{"x":"\\', '"\\u12', '{"name":"\\ud83d\\u"}', '[1e999,"\\é"]'])
    s.req("POST", "/api/submit", { text, headers: { "x-test-client-ip": "10.0.0.1" }, expect: 400 });
  // a number that is too large and not a number of JSON either (a leading zero, no digit after the point): not JSON,
  // also in a field the server does not read (the Rust server once read it as null and took the entry)
  for (const text of [`{"N":4,"M":4,"P":16,"name":"zero","unused":01e999,"pieces":${JSON.stringify(grid(16, 4))}}`, "[1.e999]", '{"x":-01e999}'])
    s.req("POST", "/api/submit", { text, headers: { "x-test-client-ip": "10.0.0.1" }, expect: 400 });
  // any content type is read as JSON; duplicate keys, escapes and whitespace are JSON's own
  s.req("POST", "/api/submit", { text: ` \n{"N":4,"M":4,"P":15,"P":16,"name":"dup\\u0041 \\ud83d\\ude00","pieces":${JSON.stringify(grid(16, 4))}}\r\n`, headers: { "content-type": "text/plain", "x-test-client-ip": "10.0.0.1" } });
  // numbers JSON.parse reads as infinite or loses digits of
  s.req("POST", "/api/submit", { text: '{"N":4,"M":4,"P":1,"name":"inf","pieces":[{"x":1e400,"y":0,"theta":0}]}', headers: { "x-test-client-ip": "10.0.0.1" }, expect: 400 });
  s.req("POST", "/api/submit", { text: '{"N":4,"M":4,"P":1,"name":"inf phi","container_phi":-1e999,"pieces":[{"x":0,"y":0,"theta":0}]}', headers: { "x-test-client-ip": "10.0.0.1" }, expect: 400 });
  s.req("POST", "/api/submit", { text: '{"N":4.0,"M":4e0,"P":1.0,"name":"written as floats","pieces":[{"x":0.1000000000000000055511151231257827,"y":1E-7,"theta":123456789012345678901234567890}]}', headers: { "x-test-client-ip": "10.0.0.1" } });

  // every field with wrong values, one at a time and several at once
  const good = squares(17, {}, grid(17, 5));
  const bad = (change: Record<string, unknown>, expect = 400) => s.submit({ ...good, ...change }, expect);
  for (const N of [2, 101, "4", 4.5, null, -3, 1, true, [4], 1e3]) bad({ N });
  bad({ N: undefined });
  for (const M of [2, 101, "0", 0.5, null, {}]) bad({ M });
  bad({ M: undefined });
  for (const P of [0, 501, 1.5, "17", null, -1, 1e9]) bad({ P });
  bad({ P: undefined });
  for (const pieces of [null, "x", {}, 5, [null], [5], ["x"], [[0, 0, 0]], [{}], [{ x: 0 }], [{ x: "0", y: 0, theta: 0 }], [{ x: 0, y: null, theta: 0 }], [{ x: 0, y: 0, theta: "a" }], [{ x: 0, y: 0, theta: null }], [{ x: 1e6 + 1, y: 0, theta: 0 }], [{ x: 0, y: -1.5e6, theta: 0 }], [{ x: 0, y: 0, theta: 0 }, { x: 1 }, { y: "also bad" }]])
    bad({ pieces });
  bad({ pieces: undefined });
  bad({ pieces: Array.from({ length: 501 }, (_, i) => ({ x: i, y: 0, theta: SQ })) });
  for (const container_phi of ["0", null, [0], {}, true]) bad({ container_phi });
  for (const name of [5, null, [], {}, true]) bad({ name });
  for (const agent_note of [5, null, ["x"]]) bad({ agent_note });
  bad({ N: 2, M: 1, P: 0, pieces: 5, container_phi: "x", name: 1, agent_note: 2, found_with: "magic", seed: -1 });
  // a name is required, after it is cleaned
  for (const name of [undefined, "", "   ", "\u0000\u0001", "<>", "​‎"]) bad({ name });

  // names and notes are cleaned: control characters, angle brackets, invisible marks, runs of spaces, length
  const tidy = (P: number, name: string, agent_note?: string) =>
    s.submit(squares(P, { name, ...(agent_note === undefined ? {} : { agent_note }) }, grid(P, 5)), 200);
  tidy(18, "  <b>Ann</b>\tof\n\nGreen   Gables\u0007 ", " a  note with <script>alert(1)</script> and ‮RTL ");
  tidy(19, "école nöel Ångström", "x".repeat(300));
  tidy(20, "n".repeat(39) + "😀", "y".repeat(199) + "😀");
  tidy(21, "a".repeat(38) + "   " + "b".repeat(10), "");
  tidy(22, "\u{1F600}".repeat(30), "é".repeat(250));
  tidy(23, "naïve 中文 عربي 🇺🇳", "ﬁ ligature Ω ohm Å angstrom");
  tidy(24, " nbsp　ideographic em﻿ bom", "tabs\tand\u000bvt\u000cff\u0085nel ");
  for (const id of [1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) s.get(`/api/submissions/${id}`);
  for (const P of [18, 19, 20, 21, 22, 23, 24]) s.get(`/api/leaderboard/4/4/${P}`, 200);

  // the body limit: 256 KiB by Content-Length, and by what is read of a chunked body
  const head = '{"N":4,"M":4,"P":25,"name":"big","pieces":' + JSON.stringify(grid(25, 5)) + ',"agent_note":"';
  const pad = (bytes: number) => ({ prefix: head, text: "a", count: bytes - head.length - 2, suffix: '"}' });
  const ip = { "x-test-client-ip": "10.0.0.1" };
  s.req("POST", "/api/submit", { repeat: pad(262144), headers: ip, expect: 200, note: "exactly the limit" });
  s.req("POST", "/api/submit", { repeat: pad(262145), headers: ip, expect: 413, note: "one byte over" });
  s.req("POST", "/api/submit", { repeat: pad(400000), headers: ip, expect: 413 });
  s.req("POST", "/api/submit", { repeat: pad(262144), headers: ip, chunked: 16384, expect: 200, note: "chunked, at the limit" });
  s.req("POST", "/api/submit", { repeat: pad(262145), headers: ip, chunked: 16384, expect: 413, note: "chunked, one byte over" });
  s.req("POST", "/api/submit", { repeat: pad(600000), headers: ip, chunked: 65536, expect: 413 });
  s.req("POST", "/api/submit", { json: squares(26, {}, grid(26, 6)), headers: ip, chunked: 100, expect: 200, note: "a small chunked body" });
  // multi-byte text: the limit is in bytes
  s.req("POST", "/api/submit", { repeat: { prefix: head, text: "é", count: 131000, suffix: '"}' }, headers: ip, note: "262 kB of two-byte characters" });
  s.req("POST", "/api/submit", { repeat: { prefix: head, text: "é", count: 132000, suffix: '"}' }, headers: ip, expect: 413 });

  // the units gate: disk pieces or a circle container need "units": "diameter"
  const three = [{ x: 0, y: 0, theta: 0 }, { x: 1, y: 0, theta: 0 }, { x: 0.5, y: Math.sqrt(3) / 2, theta: 0 }];
  s.submit({ N: 0, M: 0, P: 3, pieces: three, name: "ann" }, 426);
  s.submit({ N: 0, M: 0, P: 3, pieces: three, name: "ann", units: "radius" }, 400);
  s.submit({ N: 0, M: 0, P: 3, pieces: three, name: "ann", units: null }, 400);
  s.submit({ N: 0, M: 0, P: 3, pieces: three, name: "ann", units: "diameter" }, 200);
  s.submit({ N: 0, M: 5, P: 3, pieces: three, name: "ann" }, 426);
  s.submit({ N: 0, M: 5, P: 3, pieces: three, name: "ann", units: "diameter" }, 200);
  s.submit({ N: 6, M: 0, P: 3, pieces: scaled(three, 2.5), name: "ann" }, 426);
  s.submit({ N: 6, M: 0, P: 3, pieces: scaled(three, 2.5), name: "ann", units: "diameter" }, 200);
  s.submit({ N: 6, M: 5, P: 3, pieces: scaled(three, 2.5), name: "ann", units: "furlong" }, 200);
  // the gate comes after the parse and before the closed check, the name and the packing
  s.submit({ N: 0, M: 0, P: 2, pieces: disks(2), name: "ann" }, 426);
  s.submit({ N: 0, M: 0, P: 2, pieces: disks(2), name: "ann", units: "diameter" }, 409);
  s.submit({ N: 0, M: 0, P: 3, pieces: "x", units: "diameter" }, 400);
  s.submit({ N: 0, M: 0, P: 3, pieces: disks(3, 0.1) }, 426);

  // closed problems: 409 before the name and the packing are looked at
  s.submit(squares(2), 409);
  s.submit(squares(2, { name: "" }, row(2, 0.1)), 409);
  s.submit(squares(4, {}, grid(4, 2)), 409);
  s.submit({ N: 3, M: 6, P: 6, pieces: [], name: "x" }, 409);
  s.submit(squares(6, {}, grid(6, 3)), 200);
  for (const p of ["4/4/2", "4/4/4", "4/4/6", "0/0/3", "0/5/3", "6/0/3"]) s.get(`/api/leaderboard/${p}`).get(`/api/problems/${p}`);

  // routes that do not exist, and methods a route does not take
  for (const [method, path] of [
    ["GET", "/api/nothing"], ["GET", "/api/targets"], ["GET", "/api/spaces/targets"], ["POST", "/api/health"], ["PUT", "/api/submit"],
    ["GET", "/api/submit"], ["DELETE", "/api/submissions/1"], ["OPTIONS", "/api/submit"], ["PATCH", "/api/leaderboard/4/4/11"],
    ["GET", "/api/"], ["GET", "/api/health/"], ["GET", "/api/Health"], ["GET", "/api//health"], ["GET", "/api/health?x=1"], ["GET", "/API/health"],
    ["GET", "/"], ["GET", "/index.html"], ["POST", "/"], ["GET", "/__test/control"], ["HEAD", "/api/nothing"], ["GET", "/apix"],
  ] as const)
    s.req(method, path);
  for (const id of ["abc", "1.5", "99999", "1e0", "0x1", "-1", "0", "1%20", "9007199254740993", ""]) s.get(`/api/submissions/${id}`);
  s.post("/__test/control", [1]).req("POST", "/__test/control", { text: "{" }).post("/__test/control", {}, 200);
  s.control({ flushStats: true });
  return s;
}

/** How an entry was found: the provenance fields of POST /api/submit. */
function provenance(): Scenario {
  const s = new Scenario("flat-provenance", "flat: submit", {
    about: "found_with, method, method_params, seed, budget, software: every accepted form and every refusal",
    options: { limits: NOLIMIT },
  });
  let P = 30;
  const ok = (extra: Record<string, unknown>) => {
    P++;
    s.submit(squares(P, extra, grid(P, 7)), 200).get(`/api/submissions/${P - 30}`, 200);
  };
  ok({});
  ok({ found_with: "hand" });
  ok({ found_with: "external" });
  ok({ found_with: "external", software: "my own solver 1.0" });
  ok({ found_with: "optimizer", method: "polish" });
  ok({ found_with: "optimizer_edited", method: "penalty", method_params: { restarts: 5, nested: { a: [1, 2.5, "x", null, true] } }, seed: 0, budget: { evals: 1000 }, software: "polypack-volunteer/1.0" });
  ok({ found_with: "optimizer", method: "seed", seed: 9007199254740991, budget: { time_s: 0.5 } });
  ok({ found_with: "optimizer", method: "identity", budget: { evals: 1, time_s: 1e-9 }, method_params: {} });
  ok({ found_with: "optimizer", method: "polish", software: "  <i>spaced   out</i>  " });
  ok({ found_with: "optimizer", method: "polish", software: " \u0001 " });
  ok({ found_with: "optimizer", method: "polish", software: "s".repeat(80) });
  ok({ found_with: "optimizer", method: "polish", method_params: { text: "p".repeat(4096 - 11) } });
  ok({ found_with: "optimizer", method: "polish", method_params: { "é": "😀".repeat(1021) } });
  // Nesting. A method_params may be 4,096 bytes of JSON, which nest at most 2,046 levels deep: stored as sent
  // and read back. (The Rust server once read no body nested deeper than 128 levels and no stored row deeper than 512.)
  ok({ found_with: "optimizer", method: "polish", method_params: { a: nest(129) } });
  ok({ found_with: "optimizer", method: "polish", method_params: { a: nest(2000) } });
  ok({ found_with: "optimizer", method: "polish", method_params: { a: nest(2045) } });
  ok({ found_with: "optimizer", method: "polish", method_params: nestObjects(682) });
  // a field the server does not read may nest deeper than any it stores
  ok({ extra: nest(3000), more: nestObjects(1500) });
  // the legacy `agent` field: "ai" without found_with is "not recorded", anything else is ignored
  ok({ agent: "ai" });
  ok({ agent: "human" });
  ok({ agent: "ai", found_with: "hand" });
  ok({ agent: 5 });
  for (const method of METHODS) ok({ found_with: "optimizer", method });

  const base = squares(29, {}, grid(29, 6));
  const no = (extra: Record<string, unknown>) => s.submit({ ...base, ...extra }, 400);
  for (const found_with of ["magic", "", "Hand", 5, null, ["hand"], {}]) no({ found_with });
  no({ found_with: "optimizer" });
  no({ found_with: "optimizer_edited" });
  for (const method of ["nope", "", 5, null, ["polish"], "Polish"]) no({ found_with: "optimizer", method });
  no({ method: "polish" });
  no({ found_with: "hand", method: "polish" });
  no({ found_with: "external", method: "polish", seed: 1, budget: { evals: 1 }, method_params: {} });
  no({ found_with: "hand", software: "x" });
  no({ software: "x" });
  no({ agent: "ai", software: "x", seed: 1 });
  for (const method_params of [[], "x", 5, null, { text: "p".repeat(4096 - 10) }, { "é": "😀".repeat(1022) }])
    no({ found_with: "optimizer", method: "polish", method_params });
  // one level more than 4,096 bytes hold, and far more: refused for the size, in the same words
  for (const method_params of [{ a: nest(2046) }, nestObjects(683), { a: nest(3000) }, nestObjects(2500)]) no({ found_with: "optimizer", method: "polish", method_params });
  // every other field nested where a number or a text belongs
  no({ found_with: nest(3000), method: nest(3000), seed: nest(3000), budget: nestObjects(3000), software: nest(3000) });
  no({ N: nest(3000), M: nestObjects(3000), P: nest(3000), pieces: nest(3000), container_phi: nest(3000), name: nest(3000), agent_note: nestObjects(3000) });
  for (const seed of [-1, 1.5, "1", null, 9007199254740992, 1e300, [1]]) no({ found_with: "optimizer", method: "polish", seed });
  for (const budget of [{}, { evals: 0 }, { evals: 1.5 }, { evals: "1" }, { time_s: 0 }, { time_s: -1 }, { time_s: "1" }, { x: 1 }, { evals: 1, x: 1 }, [], "x", 5, null, { evals: null }, { time_s: 1e999 }])
    no({ found_with: "optimizer", method: "polish", budget });
  for (const software of [5, null, [], "s".repeat(81)]) no({ found_with: "external", software });
  // errors of the packing's fields and of the provenance are reported together
  no({ N: 1, found_with: "x", method: 1, method_params: 1, seed: "s", budget: 1, software: 1 });
  s.submit({ ...base, name: "", found_with: "optimizer" }, 400);
  s.get("/api/leaderboard/4/4/29", 200);
  return s;
}

/** One leader per problem: ties, losing entries, counts, and every listing that shows them. */
function leaders(): Scenario {
  const s = new Scenario("flat-leaders", "flat: leaders and listings", {
    about: "ties and losing entries, ranks, counts, /api/records, /api/records/pairs, /api/leaders, /api/atlas with its paging",
    options: { limits: NOLIMIT },
  });
  s.get("/api/records/pairs", 200).get("/api/records?N=4&M=4", 200).get("/api/atlas?N=4&M=4", 200);
  s.get("/api/leaders?keys=4/4/11,4/4/2,4/4/3", 200);
  // the first entry leads; an equal one does not; one within the tie tolerance does not either
  const three = row(3, 3);
  s.submit(squares(11, { name: "first" }, grid(11, 4, 1.5)), 200);
  s.submit(squares(11, { name: "equal" }, grid(11, 4, 1.5)), 200);
  s.submit(squares(11, { name: "worse" }, grid(11, 4, 1.6)), 200);
  s.submit(squares(11, { name: "tie above" }, scaled(grid(11, 4, 1.5), 1 + 4e-10)), 200);
  s.submit(squares(11, { name: "tie below" }, scaled(grid(11, 4, 1.5), 1 - 4e-10)), 200);
  s.get("/api/leaderboard/4/4/11", 200).get("/api/problems/4/4/11").get("/api/submissions/1").get("/api/submissions/2").get("/api/submissions/5");
  // a chain of near ties: each within the tolerance of the one before, the last beyond it of the first
  s.submit(squares(11, { name: "chain" }, scaled(grid(11, 4, 1.5), 1 - 1.2e-9)), 200);
  s.get("/api/leaderboard/4/4/11", 200);
  s.submit(squares(11, { name: "better" }, grid(11, 4, 1.2)), 200);
  s.submit(squares(11, { name: "best" }, grid(11, 4)), 200);
  s.submit(squares(11, { name: "late and worse" }, grid(11, 4, 1.4)), 200);
  s.get("/api/leaderboard/4/4/11", 200);
  for (const id of [1, 6, 7, 8, 9]) s.get(`/api/submissions/${id}`);
  // other pairs and problems
  for (const P of [1, 12, 13, 30]) s.submit(squares(P, { name: `bot ${P % 2}` }, grid(P, 6)), 200);
  s.submit({ N: 3, M: 4, P: 2, pieces: [{ x: 0, y: 0, theta: 0 }, { x: 2, y: 0, theta: 0 }], name: "tri" }, 200);
  s.submit({ N: 0, M: 4, P: 2, pieces: disks(2, 1.5), name: "disk", units: "diameter" }, 200);
  s.submit({ N: 0, M: 4, P: 2, pieces: [{ x: 0, y: 0, theta: 0 }, { x: Math.SQRT1_2, y: Math.SQRT1_2, theta: 0 }], name: "disk diagonal", units: "diameter" }, 200);
  s.submit({ N: 7, M: 0, P: 1, pieces: [{ x: 0, y: 0, theta: 0 }], name: "heptagon", units: "diameter" }, 200);
  s.submit(squares(5, { name: "five" }, row(5)), 200);
  s.submit(squares(5, { name: "five in three" }, grid(5, 3)), 200);
  s.submit(squares(7, { name: "seven" }, grid(7, 3, 1.2)), 200);
  s.submit(squares(8, { name: "eight" }, grid(8, 3)), 200);
  s.submit(squares(9, { name: "nine" }, grid(9, 3)), 200);
  s.submit(squares(3, { name: three.length ? "claim" : "" }, row(3)), 200);

  // /api/records: kept until the pair changes
  for (const q of ["N=4&M=4", "N=4&M=4", "N=0&M=4", "N=3&M=4", "N=7&M=0", "N=5&M=5", "N=4", "M=4", "", "N=2&M=4", "N=4&M=101", "N=x&M=4", "N=4&M=4&P=5", "N=04&M=4.0", "N=&M=", "N=4&N=5&M=4", "M=4&N=1e1"])
    s.get(`/api/records?${q}`);
  s.submit(squares(13, { name: "new in the pair" }, grid(13, 4)), 200).get("/api/records?N=4&M=4", 200).get("/api/records?N=0&M=4", 200);
  for (const h of [undefined, { "accept-encoding": "gzip" }, { "accept-encoding": "br, gzip;q=0.5" }, { "accept-encoding": "identity" }, { "accept-encoding": "deflate" }, { "accept-encoding": "gzip;q=0" }])
    s.get("/api/records/pairs", 200, h);
  s.get("/api/records?N=4&M=4", 200, { "accept-encoding": "gzip" });

  // /api/leaders
  const keys = (list: string) => `/api/leaders?keys=${list}`;
  s.get(keys("4/4/11,4/4/2,4/4/3,4/4/5,0/4/2,7/0/1,3/4/2,9/9/9"), 200);
  s.get(keys("4/4/11,4/4/11,04/4/11,4/4/0,4/4/501,2/4/1,x,,4/4,4/4/11/1,101/4/1,4/4/1e1,-1/4/1,4/04/1,sphere/0/12,nospace/1,4/4/500"), 200);
  s.get(keys(""), 400).get("/api/leaders", 400).get("/api/leaders?keys=4/4/1&keys=4/4/2", 400).get("/api/leaders?keys=4/4/1&other=1", 400).get("/api/leaders?other=1", 400);
  s.get(keys(Array.from({ length: 200 }, (_, i) => `4/4/${i + 1}`).join(",")), 200);
  s.get(keys(Array.from({ length: 201 }, (_, i) => `4/4/${i + 1}`).join(",")), 400);
  s.get(keys(Array.from({ length: 201 }, () => "4/4/1").join(",")), 400);
  s.get(keys("4%2F4%2F11,4/4/12%2C4/4/13"), 200).get(keys("4/4/11+4/4/12"), 200).get(keys("4/4/11&"), 200).get(keys("%zz"));
  s.get(keys("x".repeat(11_960)), 200).get(keys("x".repeat(12_100)), 414);
  s.get(keys("4/4/11,4/4/12,4/4/13,4/4/30,4/4/1"), 200, { "accept-encoding": "gzip" });

  // /api/atlas: the best drawable packing per P, the range and the payload both bounded
  for (const q of ["N=4&M=4", "N=4&M=4&from=1&to=20", "N=4&M=4&from=5", "N=4&M=4&to=8", "N=4&M=4&from=3&to=3", "N=0&M=4", "N=7&M=0&from=1&to=1", "N=5&M=5", "N=4&M=4&from=401&to=500", "N=4&M=4&from=401"])
    s.get(`/api/atlas?${q}`, 200);
  for (const q of ["", "N=4", "M=4", "N=&M=4", "N=4&M=", "N=0x4&M=4", "N=1e1&M=4", "N=4.0&M=4", "N=2&M=4", "N=4&M=4&from=0", "N=4&M=4&to=501", "N=4&M=4&from=10&to=9", "N=4&M=4&from=1&to=101", "N=4&M=4&from=1&to=100", "N=4&M=4&from=x", "N=4&M=4&to=", "N=4&M=4&from=1.5", "N=4&M=4&from=450", "N=4&M=4&from=1234567890&to=1234567891", "N=4&M=4&from=500&to=500", "N=+4&M=4", "N=4&M=4&from=-1"])
    s.get(`/api/atlas?${q}`);
  s.get("/api/atlas?N=4&M=4&from=1&to=30", 200, { "accept-encoding": "gzip" }).get("/api/atlas?N=4&M=4&from=1&to=1", 200, { "accept-encoding": "gzip" });
  // thirteen boards of 488 to 500 pieces: more than one answer may carry
  for (let P = 488; P <= 500; P++) s.submit(squares(P, { name: "long row" }, row(P)), 200);
  s.get("/api/atlas?N=4&M=4&from=401&to=500", 200).get("/api/atlas?N=4&M=4&from=500&to=500", 200).get("/api/atlas?N=4&M=4&from=499", 200);
  s.get("/api/atlas?N=4&M=4&from=401&to=500", 200, { "accept-encoding": "gzip, deflate, br" });
  s.get("/api/records/pairs", 200).get("/api/holders", 200).get("/api/records?N=4&M=4", 200);
  s.control({ flushStats: true });
  return s;
}

/** Entries that beat a published value: the review path, and the administrator's routes. */
function review(): Scenario {
  const s = new Scenario("flat-review", "flat: review and admin", {
    about: "pending claims, the strict check, the log, /api/admin/pending, review, edit and remove, and what each listing shows meanwhile",
    options: { limits: NOLIMIT },
  });
  const all = () => {
    s.get("/api/leaderboard/4/4/3").get("/api/problems/4/4/3").get("/api/records?N=4&M=4").get("/api/atlas?N=4&M=4&from=1&to=10");
    s.get("/api/holders").get("/api/leaders?keys=4/4/3,4/4/7,4/4/5,4/0/2").get("/api/admin/pending", 200, AUTH).get("/api/records/pairs");
  };
  // without the token, and with a wrong one
  s.get("/api/admin/pending", 401).get("/api/admin/pending", 401, { authorization: "Bearer wrong" }).get("/api/admin/pending", 401, { authorization: "Bearer " });
  s.get("/api/admin/pending", 401, { authorization: AUTH.authorization + "x" }).get("/api/admin/pending", 200, { authorization: AUTH.authorization.replace("Bearer", "bearer") });
  s.get("/api/admin/pending", 200, { authorization: AUTH.authorization.replace("Bearer ", "BEARER   ") }).get("/api/admin/pending", 200, { authorization: AUTH.authorization.slice(7) });
  s.get("/api/admin/pending", 401, { authorization: "Basic " + AUTH.authorization.slice(7) });
  for (const path of ["review", "remove", "edit", "holder-peaks", "spaces/remove", "spaces/edit"]) s.post(`/api/admin/${path}`, { id: 1 }, 401);
  s.get("/api/admin/review", undefined, AUTH).get("/api/admin/nothing", 404, AUTH);

  // a reviewed entry first (worse than the published 5), then a claim: the entry stays behind the claim
  s.submit(squares(3, { name: "modest" }, row(3, 2.5)), 200);
  all();
  s.submit(squares(3, { name: "claimant", found_with: "external", software: "solver" }, row(3)), 200);
  all();
  s.get("/api/submissions/1").get("/api/submissions/2");
  // a better claim replaces the first; a worse claim is not kept; a reviewed entry between them is not kept either
  s.submit(squares(3, { name: "better claim" }, [{ x: 0, y: 0, theta: SQ }, { x: 1, y: 0, theta: SQ }, { x: 0, y: 1, theta: SQ }]), 200);
  s.submit(squares(3, { name: "worse claim" }, row(3, 1.2)), 200);
  s.submit(squares(3, { name: "modest again" }, row(3, 2.4)), 200);
  all();
  for (const id of [1, 2, 3, 4, 5]) s.get(`/api/submissions/${id}`);
  // rejected: the claim goes and the reviewed entry leads again
  s.admin("/api/admin/review", { id: 3, decision: "rejected" }, 200);
  all();
  s.admin("/api/admin/review", { id: 3, decision: "rejected" }, 404).admin("/api/admin/review", { id: 5, decision: "confirmed" }, 404);
  // a new claim, confirmed: it is kept alone
  s.submit(squares(3, { name: "second claimant" }, row(3)), 200);
  s.admin("/api/admin/review", { id: 6, decision: "confirmed" }, 200);
  all();
  s.admin("/api/admin/review", { id: 6, decision: "confirmed" }, 200).admin("/api/admin/review", { id: 6, decision: "rejected" }, 200);
  all();
  // bodies the review refuses
  for (const body of [null, [], {}, { id: "1", decision: "confirmed" }, { id: 1.5, decision: "confirmed" }, { id: 1 }, { id: 1, decision: "maybe" }, { id: 1, decision: null }, { decision: "rejected" }, 5, "x"])
    s.admin("/api/admin/review", body, 400);
  s.req("POST", "/api/admin/review", { text: "{", headers: AUTH, expect: 400 }).req("POST", "/api/admin/review", { headers: AUTH, expect: 400 });
  s.admin("/api/admin/review", { id: 1e15, decision: "confirmed" }, 404).admin("/api/admin/review", { id: -1, decision: "rejected" }, 404).admin("/api/admin/review", { id: 1.0, decision: "confirmed" });

  // squares in a circle: the tolerance of a published diameter is twice its printed precision
  s.submit({ N: 4, M: 0, P: 2, pieces: row(2), name: "circle claim", units: "diameter" }, 200);
  s.submit(squares(7, { name: "seven wide" }, grid(7, 3, 1.3)), 200);
  s.submit(squares(7, { name: "seven tight" }, grid(7, 3)), 200);
  s.submit(squares(5, { name: "five" }, grid(5, 3)), 200);
  s.submit(squares(9, { name: "nine" }, grid(9, 3)), 200);
  s.submit(squares(8, { name: "eight in a row" }, row(8)), 200);
  s.submit(squares(6, { name: "six" }, grid(6, 3)), 200);
  all();
  s.get("/api/atlas?N=4&M=0").get("/api/records?N=4&M=0").get("/api/leaderboard/4/0/2");

  // edit: name, note, provenance; never the packing
  s.admin("/api/admin/edit", { id: 7, name: "  Renamed <b> ", agent_note: "a  corrected\nnote" }, 200).get("/api/submissions/7").get("/api/holders");
  s.admin("/api/admin/edit", { id: 7, found_with: "optimizer", method: "polish", method_params: { a: 1 }, seed: 5, budget: { evals: 3 }, software: " tool " }, 200).get("/api/submissions/7");
  s.admin("/api/admin/edit", { id: 7, found_with: "hand" }, 200).get("/api/submissions/7");
  s.admin("/api/admin/edit", { id: 7, found_with: "external", software: "\u0001" }, 200).get("/api/submissions/7");
  s.admin("/api/admin/edit", { id: 7 }, 200).admin("/api/admin/edit", { id: 7, agent_note: "" }, 200).admin("/api/admin/edit", { id: 7, pieces: [], score: 1, N: 3 }, 200).get("/api/submissions/7");
  s.admin("/api/admin/edit", { id: 999 }, 404).admin("/api/admin/edit", { id: 999, name: "x" }, 404).admin("/api/admin/edit", { id: 3, name: "deleted" }, 404);
  for (const body of [null, [], { name: "x" }, { id: "8" }, { id: 7, name: "" }, { id: 7, name: 5 }, { id: 7, name: " <> " }, { id: 7, agent_note: 5 }, { id: 7, method: "polish" }, { id: 7, seed: 1 }, { id: 7, software: "x" }, { id: 7, found_with: "magic" }, { id: 7, found_with: "hand", method: "polish" }, { id: 7, found_with: "optimizer" }, { id: 7, name: "", agent_note: 1, found_with: "x", budget: 1 }, { id: 7, found_with: null }, { id: 7, budget: undefined, seed: null, found_with: "hand" }])
    s.admin("/api/admin/edit", body, 400);
  s.req("POST", "/api/admin/edit", { text: "nope", headers: AUTH, expect: 400 });
  s.get("/api/submissions/7").get("/api/leaderboard/4/0/2");
  // an edit of a pending entry and of the entry kept behind a claim
  s.submit(squares(3, { name: "modest" }, row(3, 2.5)), 200).submit(squares(3, { name: "third claimant" }, row(3)), 200);
  s.admin("/api/admin/edit", { id: 15, name: "third, renamed" }, 200).admin("/api/admin/edit", { id: 14, agent_note: "kept behind the claim" }, 200);
  all();

  // remove: any listed entry
  s.admin("/api/admin/remove", { id: 15 }, 200);
  all();
  s.admin("/api/admin/remove", { id: 15 }, 404).admin("/api/admin/remove", { id: 14 }, 200).admin("/api/admin/remove", { id: 7 }, 200).admin("/api/admin/remove", { id: 12 }, 200);
  all();
  for (const body of [null, [], {}, { id: "1" }, { id: 1.5 }, { id: null }, "x"]) s.admin("/api/admin/remove", body, 400);
  s.req("POST", "/api/admin/remove", { text: "", headers: AUTH, expect: 400 });
  s.get("/api/atlas?N=4&M=0").get("/api/records?N=4&M=0").get("/api/leaderboard/4/0/2").get("/api/records/pairs");
  // a claim, then the entry behind it removed, then the claim removed: the problem is left to its published value
  s.submit(squares(3, { name: "modest once more" }, row(3, 2.5)), 200).submit(squares(3, { name: "last claimant" }, row(3)), 200);
  s.admin("/api/admin/remove", { id: 16 }, 200);
  all();
  s.admin("/api/admin/remove", { id: 17 }, 200);
  all();
  s.control({ flushStats: true });
  return s;
}

/** /api/holders and /api/holder: the counts, the peaks, the answers that are kept. */
function holders(): Scenario {
  const s = new Scenario("flat-holders", "flat: holders", {
    about: "who leads what: counts by name, peaks kept and raised, the page of one name and its paging, the answers kept for 15 minutes, restarts",
    options: { limits: NOLIMIT, holdersChunk: 3, holderChunk: 2 },
  });
  const holder = (name: string, headers?: Record<string, string>) => s.get(`/api/holder?name=${enc(name)}`, 200, headers);
  s.get("/api/holders", 200);
  holder("nobody");
  for (const q of ["", "name=", `name=${"n".repeat(41)}`, "other=1", `name=${"n".repeat(40)}`, "name=a&name=b", "name=%zz", "name=a+b", "name=%F0%9F%98%80"])
    s.get(`/api/holder?${q}`);
  // ann leads five problems in two pairs, bob two; one of ann's is a pending claim; a closed problem counts for no one
  for (const P of [11, 12, 13]) s.submit(squares(P, { name: "ann" }, grid(P, 4)), 200);
  s.submit({ N: 3, M: 4, P: 2, pieces: [{ x: 0, y: 0, theta: 0 }, { x: 2, y: 0, theta: 0 }], name: "ann" }, 200);
  s.submit(squares(3, { name: "ann" }, row(3)), 200);
  for (const P of [14, 15]) s.submit(squares(P, { name: "bob" }, grid(P, 4)), 200);
  s.submit(squares(5, { name: "bob" }, grid(5, 3)), 200);
  s.submit(squares(7, { name: "carol/with slash & more" }, grid(7, 3)), 200);
  s.submit(squares(8, { name: "Ann" }, row(8)), 200);
  s.get("/api/holders", 200);
  for (const n of ["ann", "bob", "Ann", "carol/with slash & more", "nobody", " ann", "ann "]) holder(n);
  // bob takes one of ann's leads; the kept answers stay as they were, the counts follow at once
  s.submit(squares(11, { name: "bob" }, grid(11, 4, 0.99999)), 422).submit(squares(11, { name: "bob" }, grid(11, 4, 1.5)), 200);
  s.submit(squares(12, { name: "bob" }, grid(12, 6)), 200).submit(squares(12, { name: "ann" }, grid(12, 4)), 200);
  s.get("/api/holders", 200);
  holder("ann");
  holder("bob");
  // 14 minutes later the answers are still the kept ones; after 15 they are made again
  s.control({ clockAdvanceMs: 14 * 60_000 });
  holder("ann");
  holder("bob");
  s.control({ clockAdvanceMs: 61_000 });
  holder("ann");
  holder("bob");
  holder("ann", { "accept-encoding": "gzip" });
  // an administrator's change forgets every kept answer at once
  s.submit(squares(13, { name: "dave" }, grid(13, 5)), 200);
  holder("dave");
  s.admin("/api/admin/edit", { id: 1, name: "ann the first" }, 200);
  for (const n of ["ann", "ann the first", "dave", "bob"]) holder(n);
  s.get("/api/holders", 200);
  s.admin("/api/admin/review", { id: 5, decision: "confirmed" }, 200);
  holder("ann");
  s.get("/api/holders", 200);
  s.admin("/api/admin/remove", { id: 6 }, 200);
  holder("bob");
  s.get("/api/holders", 200);
  s.admin("/api/admin/edit", { id: 7, agent_note: "a note changes no count" }, 200);
  holder("bob");
  // 33 names asked for: the answers kept are 32, the one asked longest ago goes first
  for (let i = 0; i < 33; i++) holder(`name ${i}`);
  s.submit(squares(16, { name: "ann" }, grid(16, 4)), 200);
  holder("ann");
  holder("name 0");
  // a long page: 40 leads of one name in three pairs, read two problems at a time
  for (let P = 20; P < 45; P++) s.submit(squares(P, { name: "erin" }, grid(P, 7)), 200);
  for (let P = 2; P < 12; P++) s.submit({ N: 5, M: 7, P, pieces: row(P, 2), name: "erin" }, 200);
  for (let P = 2; P < 7; P++) s.submit({ N: 5, M: 6, P, pieces: row(P, 2), name: "erin" }, 200);
  holder("erin");
  holder("erin", { "accept-encoding": "gzip" });
  s.get("/api/holders", 200).get("/api/holders", 200, { "accept-encoding": "gzip" });
  // requests that arrive together share one answer
  s.control({ clockAdvanceMs: 16 * 60_000 });
  s.add({ op: "burst", requests: Array.from({ length: 6 }, () => ({ path: "/api/holder?name=erin" })) });
  s.add({ op: "burst", requests: [{ path: "/api/holders" }, { path: "/api/holder?name=ann" }, { path: "/api/holders" }, { path: "/api/records/pairs" }, { path: "/api/records/pairs" }] });

  // peaks: given by an administrator, never lowered, kept across a restart
  const peaks = (rows: unknown, expect?: number) => s.admin("/api/admin/holder-peaks", { peaks: rows }, expect);
  peaks([{ name: "ann", peak: 9 }, { name: "gone", peak: 4 }, { name: "bob", peak: 1 }, { name: "gone", peak: 2 }], 200);
  s.get("/api/holders", 200);
  holder("ann");
  holder("gone");
  peaks([{ name: "ann", peak: 3 }], 200);
  for (const body of [null, {}, { peaks: [] }, { peaks: "x" }, { peaks: [{ name: "", peak: 1 }] }, { peaks: [{ name: " ann", peak: 1 }] }, { peaks: [{ name: "a<b", peak: 1 }] }, { peaks: [{ name: "ann", peak: 0 }] }, { peaks: [{ name: "ann", peak: 1.5 }] }, { peaks: [{ name: "ann", peak: "2" }] }, { peaks: [{ name: 5, peak: 2 }] }, { peaks: [null] }, { peaks: [{ name: "n".repeat(41), peak: 1 }] }, { peaks: [{ name: "ok", peak: 1 }, { peak: 1 }] }])
    s.admin("/api/admin/holder-peaks", body, 400);
  s.admin("/api/admin/holder-peaks", { peaks: Array.from({ length: 10_001 }, (_, i) => ({ name: `n${i}`, peak: 1 })) }, 400);
  s.req("POST", "/api/admin/holder-peaks", { text: "[", headers: AUTH, expect: 400 });
  s.dump();
  // a name whose only lead is taken stays listed at zero with its peak
  s.submit(squares(8, { name: "zed" }, grid(8, 3)), 200);
  s.get("/api/holders", 200);
  holder("Ann");
  s.add({ op: "restart" });
  // The first count is under way (three problems a step) while entries change. Each of these changes leaves
  // every count as it is (a worse entry, a note, a name set to what it was), so the answers do not depend on
  // where the count was when the change came. The requests are sent 15 ms apart, so that they arrive in
  // their order: sent in one instant, the order in which a server takes them up (and so the order of its
  // log lines) is its own, and a server with more than one thread takes them up in another.
  const worse = (body: unknown) => ({ method: "POST", path: "/api/submit", headers: { "x-test-client-ip": "10.0.0.1" }, json: body });
  s.add({
    op: "burst",
    staggerMs: 15,
    requests: [
      { path: "/api/holders" },
      worse(squares(11, { name: "late and worse" }, grid(11, 4, 3))),
      worse({ N: 5, M: 7, P: 11, pieces: row(11, 3), name: "late and worse" }),
      { method: "POST", path: "/api/admin/edit", headers: AUTH, json: { id: 7, agent_note: "edited during the count" } },
      { method: "POST", path: "/api/admin/edit", headers: AUTH, json: { id: 7, name: "bob" } },
      { path: "/api/holders" },
    ],
  });
  // an administrator's change while the page of a name is being made (two problems a step)
  // (15 ms apart for the same reason: whether the second reading joins the first or follows the change is otherwise a race)
  s.add({ op: "burst", staggerMs: 15, requests: [{ path: "/api/holder?name=erin" }, { method: "POST", path: "/api/admin/edit", headers: AUTH, json: { id: 7, agent_note: "edited during the page" } }, { path: "/api/holder?name=erin" }] });
  holder("erin");
  // after a restart: peaks given before the first count are merged into it
  s.add({ op: "restart" });
  peaks([{ name: "early", peak: 2 }], 200);
  holder("ann");
  s.get("/api/holders", 200);
  holder("ann");
  holder("gone");
  s.submit(squares(17, { name: "zed" }, grid(17, 5)), 200).submit(squares(18, { name: "zed" }, grid(18, 5)), 200);
  s.get("/api/holders", 200);
  s.add({ op: "restart", options: { holdersChunk: 1000, holderChunk: 1000 } });
  s.get("/api/holders", 200);
  holder("zed");
  holder("erin");
  return s;
}

/** Problems closed after entries were stored for them: a restart with another literature file. */
function closed(): Scenario {
  const s = new Scenario("flat-closed", "flat: leaders and listings", {
    about: "entries stored before their problem was closed are listed nowhere and keep their share links",
    options: { limits: NOLIMIT, recordsFile: "{tmp}/records-open.json", snapshotStartDelayMs: 300 },
    env: { SNAPSHOT_DIR: "{tmp}/snap" },
    autostart: false,
  });
  const record = (P: number, status: string, value: number) => ({ N: 4, M: 4, P, value, display: String(value), display_precision: 0, status, source_name: "later proof", source_url: "https://example.invalid/z", accessed: "2026-11-01", conversion_note: "none" });
  s.add({ op: "file", path: "records-open.json", text: JSON.stringify({ records: [record(9, "best_known", 3)] }) });
  s.add({ op: "file", path: "records-closed.json", text: JSON.stringify({ records: [record(9, "proven", 3), record(10, "trivial_tiling", 4), record(11, "proven_unrefereed", 4), { ...record(6, "proven", 1), N: 3, M: 6 }] }) });
  s.add({ op: "start" }).wait(1200);
  const all = () => {
    for (const P of [9, 10, 11]) s.get(`/api/leaderboard/4/4/${P}`).get(`/api/problems/4/4/${P}`);
    s.get("/api/records?N=4&M=4").get("/api/atlas?N=4&M=4&from=1&to=20").get("/api/holders").get("/api/holder?name=ann").get("/api/records/pairs");
    s.get("/api/leaders?keys=4/4/9,4/4/10,4/4/11").get("/api/submissions/1").get("/api/submissions/2").get("/api/submissions/3");
  };
  s.submit(squares(9, {}, grid(9, 3)), 200).submit(squares(10, {}, grid(10, 4)), 200).submit(squares(11, {}, grid(11, 4)), 200);
  s.submit({ N: 5, M: 5, P: 1, pieces: [{ x: 0, y: 0, theta: 0 }], name: "ann" }, 200);
  // the only entry of its pair, on a problem that is closed later
  s.submit({ N: 3, M: 6, P: 6, pieces: row(6, 3), name: "ann" }, 200);
  all();
  // a day later, with the problems closed: the snapshot built at startup leaves their entries out, and the pair that has no other
  s.add({ op: "restart", options: { recordsFile: "{tmp}/records-closed.json" }, clockAdvanceMs: 26 * 3_600_000 }).wait(1500);
  s.get("/api/snapshot", 200).get("/api/snapshot/4-4.json.gz").get("/api/snapshot/3-6.json.gz").get("/api/snapshot/5-5.json.gz");
  all();
  s.submit(squares(9, {}, grid(9, 3)), 409).submit(squares(10, {}, grid(10, 4)), 409).submit(squares(11, {}, grid(11, 4)), 200);
  s.admin("/api/admin/remove", { id: 1 }, 200).admin("/api/admin/edit", { id: 2, name: "renamed while closed" }, 200);
  all();
  return s;
}

export function flatScenarios(): Scenario[] {
  return [submit(), provenance(), leaders(), review(), holders(), closed()];
}
