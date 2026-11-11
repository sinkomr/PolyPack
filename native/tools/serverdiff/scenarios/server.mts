// Scenarios of the server around the entries: the live stream, the limits, the snapshot, the units
// gate and old clients, static files, databases of older versions, and the entry point's settings.
import { spaceAffected } from "../../../../apps/server/src/units-gate.ts";
import { AUTH, Pose, Scenario, disks, grid, row, squares } from "./dsl.mts";
import { SPACE_NAMES, SiteEntry } from "./data.mts";
import { NOLIMIT } from "./flat.mts";

const KEY = "serverdiff-submit-key-0123456789abcdef";
const spaceBody = (e: SiteEntry, extra: Record<string, unknown> = {}) => ({ space: e.space, id: e.problem, config: e.config, name: e.name, units: "diameter", ...extra });

/** GET /api/events. */
export function eventsScenario(): Scenario {
  const s = new Scenario("events", "live stream", {
    about: "the streams' keys and greetings, which stream hears of which new leader, refusals, the counts in the load line, the keep-alive after 20 s",
    options: { limits: NOLIMIT },
  });
  const open = (stream: string, query: string, headers?: Record<string, string>) =>
    s.add({ op: "sse_open", stream, path: `/api/events${query}`, ...(headers ? { headers } : {}) });
  const names = ["one", "pair", "other", "both", "all", "none", "norm"];
  const drainAll = () => {
    for (const n of names) s.add({ op: "sse_drain", stream: n });
  };
  open("one", "?keys=4/4/11");
  open("pair", "?keys=4/4/*");
  open("other", "?keys=4/5/2");
  open("both", "?keys=4/4/11,4/4/*");
  open("all", "");
  open("none", "?keys=");
  open("norm", "?keys=04/4/011,4/4/11,000/0/3,4/4/11&keys=9/9/9");
  s.control({ flushStats: true });
  s.submit(squares(11, {}, grid(11, 4, 1.5)), 200).submit(squares(12, {}, grid(12, 4)), 200);
  s.submit({ N: 4, M: 5, P: 2, pieces: row(2), name: "ann" }, 200);
  s.submit({ N: 0, M: 0, P: 3, pieces: disks(3, 1.2), name: "ann", units: "diameter" }, 200);
  drainAll();
  // no new leader, no event: a worse entry, a tie, an invalid one, a refused one
  s.submit(squares(11, { name: "bob" }, grid(11, 4, 1.6)), 200).submit(squares(11, { name: "bob" }, grid(11, 4, 1.5)), 200);
  s.submit(squares(11, {}, row(11, 0.5)), 422).submit(squares(2), 409);
  drainAll();
  s.submit(squares(11, { name: "bob" }, grid(11, 4)), 200);
  // a claim leads at once; its review is not announced
  s.submit(squares(3, { name: "modest" }, row(3, 2.5)), 200).submit(squares(3, { name: "claimant <b>" }, row(3)), 200);
  drainAll();
  s.admin("/api/admin/review", { id: 9, decision: "rejected" }, 200).admin("/api/admin/remove", { id: 8 }, 200);
  drainAll();
  s.control({ flushStats: true });
  // keys that are not such a list
  const hundred = Array.from({ length: 100 }, (_, i) => `4/4/${i + 1}`).join(",");
  for (const q of ["x", "4/4", "4/4/0", "4/4/501", "2/4/1", "4/4/1,", ",", "4/4/**", "4/4/1;4/4/2", "4/101/1", "-4/4/1", "4/4/1.5", " 4/4/1".replace(" ", "%20"), "4/4/1%2C4/4/2%2C", `${hundred},4/4/101`, "a-very-long-key-that-is-cut-at-twenty-characters", "4/4/1/", "*/4/1", "1e1/4/1", "0004/4/1"])
    open("bad", `?keys=${q}`);
  open("full", `?keys=${hundred}`);
  open("escaped", "?keys=4/4/1%2C4/4/2");
  open("star", "?keys=0/0/*,100/100/500,3/0/*");
  open("old", "", { "user-agent": "polypack-volunteer/0.2.0" });
  s.submit(squares(13, {}, grid(13, 4)), 200);
  for (const n of ["full", "escaped", "star"]) s.add({ op: "sse_drain", stream: n });
  s.control({ flushStats: true });
  for (const n of ["one", "pair", "other", "both", "none", "norm", "full", "escaped", "star"]) s.add({ op: "sse_close", stream: n });
  s.wait(300).control({ flushStats: true });
  // the stream that is left gets a keep-alive comment 20 s after its last event
  s.submit(squares(14, {}, grid(14, 4)), 200).add({ op: "sse_drain", stream: "all" });
  s.wait(20_400).add({ op: "sse_drain", stream: "all" });
  s.submit(squares(15, {}, grid(15, 4)), 200).add({ op: "sse_drain", stream: "all" });
  s.add({ op: "sse_close", stream: "all" }).wait(300).control({ flushStats: true }).control({ flushStats: true });
  // a client that reconnects asks for the same keys and is greeted the same
  open("again", "?keys=4/4/11");
  s.submit(squares(11, { name: "carol" }, grid(11, 4, 0.99999999995)), 200).add({ op: "sse_close", stream: "again" });
  return s;
}

/** The limits of submissions: by address, by submit key, by verification time, and overload. */
export function limitsScenario(site: SiteEntry[]): Scenario {
  const s = new Scenario("limits", "limits", {
    about: "submissions per address (IPv6 by /64), the window, the submit key, the verification budget shared by both submit routes, overload",
    options: { limits: { perIp: 3, perKey: 5 } },
    env: { SUBMIT_KEY: ` ${KEY} ` },
  });
  const hit = (ip: string | null, expect?: number, headers: Record<string, string> = {}) =>
    s.req("POST", "/api/submit", { json: {}, headers: { ...(ip === null ? {} : { "x-test-client-ip": ip }), ...headers }, ...(expect === undefined ? {} : { expect }) });
  const spaceHit = (ip: string, expect?: number, headers: Record<string, string> = {}) =>
    s.req("POST", "/api/spaces/submit", { json: {}, headers: { "x-test-client-ip": ip, ...headers }, ...(expect === undefined ? {} : { expect }) });
  // three per window from one address, whatever they hold; both submit routes count together
  hit("1.1.1.1", 400);
  spaceHit("1.1.1.1", 400);
  hit("1.1.1.1", 400);
  hit("1.1.1.1", 429);
  spaceHit("1.1.1.1", 429);
  hit("1.1.1.2", 400);
  s.get("/api/health", 200, { "x-test-client-ip": "1.1.1.1" });
  // an address is its /64 when it is IPv6, however it is written
  const same: [string, string][] = [
    ["2001:db8:1:2::1", "2001:DB8:1:2:ffff:ffff:ffff:ffff"],
    ["::ffff:9.9.9.9", "9.9.9.9"],
    ["[2001:db8:5:6::1]", "2001:db8:5:6:1:2:3:4"],
    ["fe80::1%eth0", "fe80:0:0:0:9::"],
    ["64:ff9b::1.2.3.4", "64:ff9b:0:0:0:0:5.6.7.8"],
    ["::1", "::"],
    [" 7.7.7.7", "7.7.7.7 "],
    ["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::9"],
    ["1::2::3", "1::2::3"],
    ["gggg::1", "GGGG::1"],
    ["1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7:8:9"],
    ["not an address", "NOT AN ADDRESS"],
    ["1:2:3:4:5:6:7::", "1:2:3:4::"],
  ];
  for (const [a, b] of same) {
    hit(a, 400);
    hit(a, 400);
    hit(b, 400);
    hit(b, 429);
  }
  // different keys
  for (const ip of ["2001:db8:1:3::1", "1::2::4", "gggg::2", "1:2:3:4:5:6:7:8:a", "::ffff:9.9.9.8", "12345::1", "1:2:3", "::ffff:999.1.1.1", "1.2.3.4.5", ""]) hit(ip, 400);
  // without the header, or with an empty one (the last address above): the address of the connection
  hit(null, 400);
  hit(null, 400);
  hit(null, 429);
  hit(null, 429);
  // a minute later the window is over
  s.control({ clockAdvanceMs: 59_000 });
  hit("1.1.1.1", 429);
  s.control({ clockAdvanceMs: 2_000 });
  hit("1.1.1.1", 400);
  hit("1.1.1.1", 400);
  hit("1.1.1.1", 400);
  hit("1.1.1.1", 429);

  // the submit key: its own count, for every address that sends it; a wrong one is 401 and counts against the address
  const key = { "x-submit-key": KEY };
  for (let i = 0; i < 5; i++) hit(i % 2 ? "3.3.3.3" : "1.1.1.1", 400, key);
  hit("3.3.3.4", 429, key);
  spaceHit("3.3.3.5", 429, key);
  hit("3.3.3.3", 400);
  for (const k of ["wrong", KEY + "x", KEY.slice(1), KEY.toUpperCase()]) hit("4.4.4.4", 401, { "x-submit-key": k });
  hit("4.4.4.4", 401, { "x-submit-key": "" });
  hit("4.4.4.4", 429);
  spaceHit("4.4.4.5", 401, { "x-submit-key": "wrong" });
  s.control({ flushStats: true });
  // a server without a key refuses every key; so does one whose key is too short to be used
  s.add({ op: "restart", env: { SUBMIT_KEY: null } });
  hit("1.1.1.1", 401, key);
  hit("1.1.1.1", 401, { "x-submit-key": "" });
  hit("1.1.1.1", 400);
  s.add({ op: "restart", env: { SUBMIT_KEY: "short-key", OVERLOAD_DELAY_MS: "abc", PIECES_MIGRATION_BATCH: "-5", SNAPSHOT_HOUR: "1.5" } });
  hit("1.1.1.1", 401, { "x-submit-key": "short-key" });
  // behind a proxy: the first entry of X-Forwarded-For, when no header is named for the address
  s.add({ op: "restart", env: { SUBMIT_KEY: KEY, CLIENT_IP_HEADER: null, TRUST_PROXY: "1", OVERLOAD_DELAY_MS: null, PIECES_MIGRATION_BATCH: null, SNAPSHOT_HOUR: null } });
  for (const [xff, expect] of [["5.5.5.5, 6.6.6.6", 400], [" 5.5.5.5 ,7.7.7.7", 400], ["5.5.5.5", 400], ["5.5.5.5,8.8.8.8", 429], ["6.6.6.6, 5.5.5.5", 400], ["", 400]] as const)
    s.req("POST", "/api/submit", { json: {}, headers: { "x-forwarded-for": xff, "x-test-client-ip": "ignored" }, expect });
  s.add({ op: "restart", env: { CLIENT_IP_HEADER: "X-Test-Client-IP", TRUST_PROXY: "0" } });
  hit("1.1.1.1", 400);
  s.req("POST", "/api/submit", { json: {}, headers: { "x-forwarded-for": "5.5.5.5" }, expect: 400 });

  // the verification budget: so little that one check uses it up, for the address or for the key
  s.add({ op: "restart", options: { limits: { perIp: 1000, perKey: 1000, verifyMsPerMinute: 1e-3, keyVerifyMsPerMinute: 1e-3 } } });
  const board = squares(11, {}, grid(11, 4));
  s.submit(board, 200, "1.1.1.1").submit(board, 429, "1.1.1.1").submit({}, 429, "1.1.1.1");
  s.spaceSubmit({}, 429, "1.1.1.1").submit(board, 200, "1.1.1.2");
  // refusals before the check cost no budget
  s.submit({}, 400, "1.1.1.3").submit(squares(2), 409, "1.1.1.3").submit(squares(11, {}, row(11, 0.5)), 422, "1.1.1.3").submit(board, 429, "1.1.1.3");
  s.submit(board, 200, "1.1.1.4", key).submit(board, 429, "1.1.1.5", key).spaceSubmit({}, 429, "1.1.1.6", key).submit(board, 200, "1.1.1.6");
  const e = site[0];
  if (e) {
    // a space's check reserves its estimate first, and is charged what it took
    s.spaceSubmit(spaceBody(e), undefined, "2.2.2.1").spaceSubmit(spaceBody(e), 429, "2.2.2.1").submit(board, 429, "2.2.2.1");
    s.spaceSubmit({ ...spaceBody(e), config: {} }, undefined, "2.2.2.2").spaceSubmit(spaceBody(e), undefined, "2.2.2.2");
  }
  // the budget refills with time
  s.control({ clockAdvanceMs: 400 * 86_400_000 });
  s.submit(board, 200, "1.1.1.1").submit(board, 429, "1.1.1.1").submit(board, 200, "1.1.1.5", key);
  s.control({ flushStats: true });

  // overload: submissions are refused while the event loop is late by more than the limit; nothing else is
  s.add({ op: "restart", options: { limits: { perIp: 2 } } });
  s.control({ loopDelayMs: 251 });
  hit("1.1.1.1", 503);
  spaceHit("1.1.1.1", 503);
  hit("1.1.1.1", 503, key);
  hit("1.1.1.1", 503, { "x-submit-key": "wrong" });
  s.get("/api/health", 200).get("/api/leaderboard/4/4/11", 200);
  s.control({ loopDelayMs: 250 });
  hit("1.1.1.1", 400);
  // back to the measured delay (not followed by a submission: the measured delay is the machine's)
  s.control({ loopDelayMs: null }).control({ loopDelayMs: 0 });
  hit("1.1.1.1", 400);
  hit("1.1.1.1", 429);
  s.control({ loopDelayMs: 1e9 });
  hit("1.1.1.1", 503);
  s.control({ flushStats: true });
  s.add({ op: "restart", env: { OVERLOAD_DELAY_MS: "0" }, options: { loopDelayMs: 1e9 } });
  hit("1.1.1.1", 400);
  spaceHit("1.1.1.1", 400);
  s.add({ op: "restart", env: { OVERLOAD_DELAY_MS: "100" }, options: { loopDelayMs: 150 } });
  hit("1.1.1.1", 503);
  s.control({ loopDelayMs: 100 });
  hit("1.1.1.1", 400);
  s.add({ op: "restart", env: { OVERLOAD_DELAY_MS: "0" }, options: { loopDelayMs: 150, limits: { overloadDelayMs: 100 } } });
  hit("1.1.1.1", 503);

  // more than 10,000 addresses in one window: the server forgets the windows and budgets that are over, and no answer changes
  s.add({ op: "restart", options: { loopDelayMs: 0, limits: { perIp: 2 } } });
  const overlapping = { N: 5, M: 5, P: 2, pieces: row(2, 0.5), name: "crowd" };
  const crowd = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ method: "POST", path: "/api/submit", headers: { "x-test-client-ip": `11.${((from + i) >> 16) & 255}.${((from + i) >> 8) & 255}.${(from + i) & 255}` }, json: overlapping }));
  s.add({ op: "burst", requests: crowd(0, 10_050), concurrency: 24, summary: true });
  s.add({ op: "burst", requests: [...crowd(0, 40), ...crowd(0, 40)], concurrency: 1, summary: true });
  s.control({ clockAdvanceMs: 61_000 });
  s.add({ op: "burst", requests: [...crowd(20_000, 30), ...crowd(0, 30), ...crowd(0, 30), ...crowd(0, 30)], concurrency: 1, summary: true });
  s.control({ flushStats: true });
  return s;
}

/** The records snapshot: the manifest built on a schedule, the files generated on request. */
export function snapshotScenario(site: SiteEntry[]): Scenario {
  const s = new Scenario("snapshot", "snapshot", {
    about: "the manifest at startup and at the nightly hour, stored files deleted, each file generated from the leaders, HEAD, 404s, the limit per address",
    options: { limits: { ...NOLIMIT, snapshotFilesPerHour: 4 }, snapshotStartDelayMs: 1500 },
    env: { SNAPSHOT_DIR: "{tmp}/snap" },
    autostart: false,
  });
  const file = (name: string, expect?: number, ip = "10.0.0.1", headers: Record<string, string> = {}) =>
    s.get(`/api/snapshot/${name}`, expect, { "x-test-client-ip": ip, ...headers });
  // what an older server left: stored files, a manifest of format 2, the rest of an interrupted build
  s.add({ op: "file", path: "snap/4-4.json.gz", gzipText: '{"format":2,"N":4,"M":4,"records":[]}' });
  s.add({ op: "file", path: "snap/space-torus.json.gz", gzipText: "stale" }).add({ op: "file", path: "snap/.manifest.json.tmp", text: "{" });
  s.add({ op: "file", path: "snap/notes.txt", text: "kept: not a data file" }).add({ op: "file", path: "snap/dir.json.gz/inner", text: "a directory is left alone" });
  s.add({ op: "file", path: "snap/manifest.json", text: JSON.stringify({ format: 2, units: "diameter", generated_at: "2026-10-28T11:00:00.000Z", completed_at: "2026-10-28T11:00:00.000Z", records: 1, pieces: 4, files: [{ N: 4, M: 4, file: "4-4.json.gz", records: 1, pieces: 4, as_of: "2026-10-28T11:00:00.000Z", fingerprint: "x" }] }) });
  s.add({ op: "start" });
  s.get("/api/snapshot", 404);
  file("4-4.json.gz", 404);
  s.add({ op: "ls", dir: "snap" }).wait(2300).add({ op: "ls", dir: "snap" });
  s.get("/api/snapshot", 200);
  // entries: two pairs, a closed problem's neighbour, a claim, and two spaces
  for (const P of [11, 12, 30]) s.submit(squares(P, { name: `bot ${P}`, found_with: "external" }, grid(P, 6)), 200);
  s.submit(squares(3, { name: "modest" }, row(3, 2.5)), 200).submit(squares(3, { name: "claimant" }, row(3)), 200);
  s.submit({ N: 0, M: 4, P: 2, pieces: disks(2, 1.5), name: "disk", units: "diameter" }, 200);
  // an entry whose method_params nests 2,000 levels deep: stored, read back, and in the file of its pair
  // (the Rust server once answered 500 for an entry and a file with a row nested deeper than 512)
  let deep: unknown = [];
  for (let i = 1; i < 2000; i++) deep = [deep];
  s.submit(squares(13, { name: "deep", found_with: "optimizer", method: "polish", method_params: { a: deep } }, grid(13, 6)), 200).get("/api/submissions/7", 200);
  for (const e of site) s.spaceSubmit(spaceBody(e));
  // the manifest lists nothing of them until it is built again
  file("4-4.json.gz", 404);
  s.get("/api/snapshot", 200);
  // a day later, after a restart: the snapshot is old, so it is built soon after startup
  s.add({ op: "restart", clockAdvanceMs: 26 * 3_600_000 });
  s.wait(2300).get("/api/snapshot", 200).add({ op: "ls", dir: "snap" });
  file("4-4.json.gz", 200);
  file("0-4.json.gz", 200);
  s.req("HEAD", "/api/snapshot/4-4.json.gz", { headers: { "x-test-client-ip": "10.0.0.1" } }).req("HEAD", "/api/snapshot/9-9.json.gz").req("HEAD", "/api/snapshot");
  for (const name of ["4-5.json.gz", "x", "manifest.json", "4-4.json", "04-4.json.gz", "4-4.json.gz.tmp", "space-nospace.json.gz", "..%2Fmanifest.json", "4-4.JSON.GZ", "%34-4.json.gz"]) file(name);
  s.get("/api/snapshot/4-4.json.gz/x").get("/api/snapshot/").req("POST", "/api/snapshot/4-4.json.gz");
  for (const space of SPACE_NAMES) file(`space-${space}.json.gz`, undefined, "10.0.0.2");
  // four files an hour from one address (three were fetched above): the fifth is refused; HEAD and 404 are not counted; another address is not held
  file("4-4.json.gz", 200);
  file("4-4.json.gz", 429);
  file("4-4.json.gz", 429);
  file("9-9.json.gz", 404);
  s.req("HEAD", "/api/snapshot/4-4.json.gz", { headers: { "x-test-client-ip": "10.0.0.1" } });
  file("4-4.json.gz", 200, "10.0.0.3", { "accept-encoding": "gzip" });
  file("4-4.json.gz", 200, "2001:db8::1");
  for (let i = 0; i < 3; i++) file("0-4.json.gz", 200, "2001:db8::2");
  file("0-4.json.gz", 429, "2001:db8:0:0:1::");
  s.control({ clockAdvanceMs: 3_600_000 });
  file("4-4.json.gz", 200);
  // six files asked for at once: two are generated at a time, the others wait their turn
  s.add({ op: "burst", requests: Array.from({ length: 6 }, (_, i) => ({ path: `/api/snapshot/${i % 2 ? "0-4" : "4-4"}.json.gz`, headers: { "x-test-client-ip": `10.9.0.${i}` } })) });
  // a leader changes after the manifest was built: the file shows it, with its own fingerprint
  s.submit(squares(12, { name: "newcomer" }, grid(12, 4)), 200).admin("/api/admin/review", { id: 5, decision: "confirmed" }, 200);
  file("4-4.json.gz", 200, "10.0.0.4");
  s.get("/api/snapshot", 200);
  // the nightly build: ten seconds before the hour, a restart (a server may take some seconds to start); the snapshot is recent, so nothing is built at startup
  s.add({ op: "restart", clockAt: "2031-03-08T10:59:50.000Z" });
  s.get("/api/snapshot", 200).wait(12_500).get("/api/snapshot", 200).add({ op: "ls", dir: "snap" });
  // a pair that loses its entries is dropped by the next build, here at another hour
  s.admin("/api/admin/remove", { id: 6 }, 200);
  s.add({ op: "restart", clockAt: "2031-03-09T04:59:50.000Z", env: { SNAPSHOT_HOUR: "5" } });
  s.wait(12_500).get("/api/snapshot", 200);
  file("0-4.json.gz", 404);
  // a manifest that is not one, and one of a build that was cut short: neither stops the next build
  s.add({ op: "stop" }).add({ op: "file", path: "snap/manifest.json", text: JSON.stringify({ format: 3, units: "diameter", generated_at: "x", completed_at: "x", records: 0, pieces: 0, files: [], spaces: "none" }) });
  s.add({ op: "start" }).get("/api/snapshot", 404).wait(2300).get("/api/snapshot", 200);
  s.add({ op: "stop" }).add({ op: "file", path: "snap/manifest.json", text: JSON.stringify({ format: 3, units: "diameter", generated_at: "2031-03-09T05:00:01.000Z", completed_at: "2031-03-08T11:00:00.000Z", records: 0, pieces: 0, files: [{ N: 4, M: 4, file: "4-4.json.gz", records: 0, pieces: 0, as_of: "2031-03-08T11:00:00.000Z", fingerprint: "old" }, { N: 9, M: 9, file: "9-9.json.gz", records: 0, pieces: 0, as_of: "2031-03-08T11:00:00.000Z", fingerprint: "gone" }] }) });
  s.add({ op: "file", path: "snap/7-7.json.gz", gzipText: "stored" });
  s.add({ op: "start" }).get("/api/snapshot", 200);
  file("9-9.json.gz", 200, "10.0.0.5");
  file("4-4.json.gz", 200, "10.0.0.5");
  s.wait(2300).get("/api/snapshot", 200).add({ op: "ls", dir: "snap" });
  // SNAPSHOT_HOUR of 24 or more is 11
  s.add({ op: "restart", clockAt: "2031-03-10T10:59:50.000Z", env: { SNAPSHOT_HOUR: "24" } });
  s.wait(12_500).get("/api/snapshot", 200);
  return s;
}

/** The units gate and the volunteer clients that are too old. */
export function gateScenario(site: SiteEntry[]): Scenario {
  const s = new Scenario("units-gate", "units and old clients", {
    about: "the 426 of old volunteer clients on every route but the API page, the health check and the snapshot; the units gate switched off",
    options: { limits: NOLIMIT },
    env: { SNAPSHOT_DIR: "{tmp}/snap" },
  });
  const agents = ["polypack-volunteer/0.1.4", "polypack-volunteer/0.2.0", "polypack-volunteer/0.2.9 (node 22)", "POLYPACK-VOLUNTEER/0.2", "polypack-volunteer/0.3.0", "polypack-volunteer/0.10.0", "polypack-volunteer/1.0", "curl/8", "Mozilla/5.0 polypack-volunteer/0.1 like", "polypack-volunteer/abc", "polypack-volunteer/0.3", "polypack-volunteer/00.02.9", "polypack-volunteer/0.2.99999999999999999999", "polypack-volunteer/", ""];
  const routes: [string, string, unknown?][] = [
    ["GET", "/api"], ["GET", "/api/health"], ["GET", "/api/snapshot"], ["GET", "/api/snapshot/x.json.gz"], ["GET", "/api/problems/4/4/11"],
    ["GET", "/api/spaces"], ["POST", "/api/submit", {}], ["POST", "/api/spaces/submit", {}], ["GET", "/api/nothing"], ["HEAD", "/api/health"],
    ["HEAD", "/api/problems/4/4/11"], ["GET", "/api/events?keys=x"], ["GET", "/index.html"], ["POST", "/api/health"], ["GET", "/api/admin/pending"],
    ["GET", "/api/leaders?keys=4/4/1"], ["GET", "/api/snapshotx"], ["GET", "/api/"], ["POST", "/api/snapshot"], ["GET", "/api/holders"],
  ];
  for (const ua of agents)
    for (const [method, path, json] of routes)
      s.req(method, path, { headers: { "user-agent": ua }, ...(json === undefined ? {} : { json }) });
  s.get("/api/problems/0/0/3", 200).get("/api/problems/4/4/11", 200);
  // with the gate off, nothing asks for units
  const three: Pose[] = disks(3, 1.2);
  s.submit({ N: 0, M: 0, P: 3, pieces: three, name: "ann" }, 426);
  const affected = site.filter((e) => spaceAffected(e.space, e.problem)).slice(0, 3);
  for (const e of affected) s.spaceSubmit(spaceBody(e, { units: undefined }), 426);
  s.add({ op: "restart", options: { unitsGate: false } });
  s.submit({ N: 0, M: 0, P: 3, pieces: three, name: "ann" }, 200).submit({ N: 0, M: 0, P: 3, pieces: three, name: "ann", units: "radius" }, 200);
  for (const e of affected) s.spaceSubmit(spaceBody(e, { units: undefined })).spaceSubmit(spaceBody(e, { units: "radius" }));
  s.req("POST", "/api/submit", { json: {}, headers: { "user-agent": "polypack-volunteer/0.2.0" }, expect: 426 });
  return s;
}

/** The built website served by the same process. */
export function staticScenario(): Scenario {
  const s = new Scenario("static-files", "static files", {
    about: "files of the static directory with their types, lengths and isolation headers, HEAD, ranges, compression under /spaces, paths that leave the directory, and the API beside them",
    options: { limits: NOLIMIT, staticDir: "{fixtures}/static" },
  });
  const gz = { "accept-encoding": "gzip" };
  for (const path of ["/", "/index.html", "/tighter.html", "/assets/app.js", "/assets/big.css", "/assets/missing.js", "/assets/", "/spaces/viewer.html", "/spaces/small.txt", "/spaces/data.json", "/spaces/missing.html", "/spaces/", "/sub/", "/sub", "/sub/index.html", "/file%20with%20space.txt", "/data.bin", "/noext", "/image.svg", "/.hidden", "/empty.txt", "/unicode-%C3%A9.txt", "/missing", "/index.html?x=1", "/INDEX.HTML", "/index.html/", "/api/shadow.txt", "/tighter.html?x", "/tighter.html/"]) {
    s.get(path).get(path, undefined, gz);
  }
  for (const path of ["/../ref-server.mts", "/%2e%2e/records.json", "/..%2frecords.json", "/assets/..%2f..%2frecords.json", "/assets/../index.html", "//index.html", "/assets//app.js", "/assets\\app.js", "/%2e/index.html", "/./index.html", "/sub/../index.html", "/%zz", "/%E0%A4%A", "/index.html%00", "/assets/%2e%2e/%2e%2e/records.json"])
    s.get(path);
  for (const path of ["/index.html", "/assets/app.js", "/spaces/viewer.html", "/tighter.html", "/missing", "/sub/"])
    s.req("HEAD", path).req("HEAD", path, { headers: gz }).req("POST", path, { json: {} }).req("PUT", path, { text: "x" }).req("DELETE", path);
  // OPTIONS on a file announces the file's length and sends no body (README.md, "Defects"): once is enough
  s.req("OPTIONS", "/missing").req("OPTIONS", "/empty.txt").req("OPTIONS", "/index.html");
  for (const range of ["bytes=0-9", "bytes=5-", "bytes=-5", "bytes=10-5", "bytes=0-99999", "bytes=2990-", "bytes=x", "items=0-1", "bytes=0-0,5-9", ""])
    s.get("/data.bin", undefined, { range }).get("/spaces/viewer.html", undefined, { range, ...gz });
  // a range past the end of the file is answered 206 with a length that is not sent (README.md, "Defects")
  s.get("/data.bin", undefined, { range: "bytes=3000-3001" });
  for (const e of ["gzip", "deflate", "br", "gzip, deflate, br", "identity", "*", "gzip;q=0", "x-gzip", "GZIP"])
    s.get("/spaces/viewer.html", 200, { "accept-encoding": e }).get("/assets/big.css", 200, { "accept-encoding": e });
  // the API is unchanged beside the files
  s.get("/api/health", 200).get("/api", 200).get("/api/nothing", 404).get("/api/records/pairs", 200, gz).submit(squares(11, {}, grid(11, 4)), 200);
  s.get("/api/spaces/nospace/records", 404).req("POST", "/__test/control", { text: "x" });
  return s;
}

const hexOf = (pieces: Pose[]): string => {
  const b = Buffer.alloc(pieces.length * 24);
  pieces.forEach((p, i) => {
    b.writeDoubleLE(p.x, i * 24);
    b.writeDoubleLE(p.y, i * 24 + 8);
    b.writeDoubleLE(p.theta, i * 24 + 16);
  });
  return b.toString("hex");
};
const q = (text: string) => `'${text.replace(/'/g, "''")}'`;

/** Databases written by older versions of the server: what opening them does, and what is served from them. */
export function migrationScenarios(): Scenario[] {
  // the first schema: no found-with columns, no tallies, no meta, the narrow index, pieces as JSON text, the old units
  const a = new Scenario("migrate-first-schema", "databases of older versions", {
    about: "a database of the first schema: columns added, tallies started, problems pruned, the index replaced, units converted, pieces rewritten in the background",
    options: { limits: NOLIMIT },
    env: { PIECES_MIGRATION_BATCH: "4", PIECES_MIGRATION_PAUSE_MS: "1000" },
    autostart: false,
  });
  const rows: string[] = [];
  let at = 0;
  const ins = (n: number, m: number, p: number, score: number, name: string, pieces: string, verification = "none", lit: number | null = null, strict: string | null = null) =>
    rows.push(
      `INSERT INTO submissions (n, m, p, score, name, agent, agent_note, pieces, container_phi, created_at, verification, literature_value, strict_check) VALUES (${n}, ${m}, ${p}, ${score}, ${q(name)}, 'ai', 'note ${rows.length}', ${pieces}, 0, '2026-10-0${1 + (at++ % 9)}T10:00:00.000Z', ${q(verification)}, ${lit === null ? "NULL" : lit}, ${strict === null ? "NULL" : q(strict)})`,
    );
  const text = (pieces: Pose[]) => q(JSON.stringify(pieces));
  const blob = (pieces: Pose[]) => `X'${hexOf(pieces)}'`;
  // a crowded problem: three listed entries and a rejected one; only the leader stays
  ins(4, 4, 11, 4.5, "worse", text(grid(11, 4, 1.1)));
  ins(4, 4, 11, 4, "leader", text(grid(11, 4)));
  ins(4, 4, 11, 4.0000000001, "tie, later", text(grid(11, 4)));
  ins(4, 4, 11, 3, "rejected", text(grid(11, 4, 0.7)), "rejected");
  // a pending claim with the reviewed entry behind it, and a second pending one that goes
  ins(4, 4, 3, 6, "reviewed", text(row(3, 2.5)));
  ins(4, 4, 3, 3, "claim", text(row(3)), "pending", 5, JSON.stringify({ ok: true, certifiedSize: 3.00000003 }));
  ins(4, 4, 3, 3.5, "worse claim", text(row(3, 1.2)), "pending", 5, JSON.stringify({ ok: true, certifiedSize: 3.50000003 }));
  ins(4, 4, 7, 3, "confirmed", text(grid(7, 3)), "confirmed", 3.5, JSON.stringify({ ok: true, certifiedSize: 3.00000003 }));
  // the old units: disks of radius 1, circles scored by their radius
  ins(0, 0, 3, 4.3094010767585, "disks in a circle", text(disks(3, 2)));
  ins(0, 4, 2, 6, "disks in a square", text(disks(2, 4)), "none", 3.4142, "{not json");
  ins(5, 0, 2, 1.7, "pentagons in a circle", blob(row(2, 2)), "confirmed", 1.9, JSON.stringify({ ok: false, certifiedSize: 1.70000002, reason: "a reason" }));
  ins(0, 5, 1, 2.5, "a disk, as a BLOB", blob(disks(1)));
  // pieces that are not a list of poses stay as they are
  ins(0, 3, 4, 9, "unreadable disks", q("[1, 2"));
  ins(6, 6, 2, 3, "not poses", q('[{"x": 1}]'));
  ins(6, 6, 3, 3, "an extra field", q('[{"x":1,"y":2,"theta":0,"z":1},{"x":3,"y":2,"theta":0,"z":1},{"x":5,"y":2,"theta":0,"z":1}]'));
  ins(6, 6, 4, 3, "a malformed BLOB", "X'0102030405'");
  ins(7, 7, 1, 2.3, "exact doubles", text([{ x: 0.1, y: -1e-300, theta: 3.141592653589793 }]));
  ins(6, 6, 5, 3, "a number", q("5"));
  ins(6, 6, 6, 3, "triples", q("[[1,2,3]]"));
  ins(6, 6, 7, 3, "a null", q("[null]"));
  ins(6, 6, 8, 3, "a text", q('"text"'));
  ins(6, 6, 9, 3, "an infinite number", q('[{"x":1e999,"y":0,"theta":0}]'));
  ins(6, 6, 10, 3, "an empty list", q("[]"));
  for (let P = 20; P < 32; P++) ins(8, 8, P, P, `row ${P}`, text(row(P)));
  a.add({
    op: "sql",
    statements: [
      "CREATE TABLE submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL, m INTEGER NOT NULL, p INTEGER NOT NULL, score REAL NOT NULL, name TEXT NOT NULL, agent TEXT NOT NULL DEFAULT '', agent_note TEXT NOT NULL, pieces TEXT NOT NULL, container_phi REAL NOT NULL, created_at TEXT NOT NULL, verification TEXT NOT NULL DEFAULT 'none', literature_value REAL, strict_check TEXT)",
      "CREATE INDEX submissions_problem ON submissions (n, m, p, score, id)",
      "CREATE INDEX submissions_verification ON submissions (verification)",
      ...rows,
    ],
  });
  a.add({ op: "dump" }).add({ op: "start" });
  const reads = (s: Scenario) => {
    for (const p of ["4/4/11", "4/4/3", "4/4/7", "0/0/3", "0/4/2", "5/0/2", "0/5/1", "0/3/4", "6/6/2", "6/6/3", "7/7/1", "8/8/25"]) s.get(`/api/leaderboard/${p}`);
    for (let id = 1; id <= 23; id++) s.get(`/api/submissions/${id}`);
    s.get("/api/admin/pending", undefined, AUTH).get("/api/atlas?N=0&M=0").get("/api/atlas?N=6&M=6").get("/api/atlas?N=4&M=4").get("/api/atlas?N=8&M=8");
    s.get("/api/records?N=4&M=4").get("/api/records/pairs").get("/api/holders").get("/api/holder?name=leader");
  };
  reads(a);
  a.dump();
  // between the first step of the migration and the second: a minute passes, so the next step logs its progress
  a.wait(1400).control({ clockAdvanceMs: 61_000 }).wait(1000).dump();
  a.submit(squares(12, {}, grid(12, 4)), 200).admin("/api/admin/review", { id: 6, decision: "rejected" }, 200);
  a.wait(9000);
  reads(a);
  a.dump();
  // a second start does nothing more
  a.add({ op: "restart" });
  reads(a);

  // a database with the tables of 2026-10 (tallies, meta, space entries) and no units epoch: converted once, space entries included
  const b = new Scenario("migrate-units", "databases of older versions", {
    about: "a database in the old units, with space entries: each class of problem converted by its factors, curved disks at K != 0 archived, unreadable rows left",
    options: { limits: NOLIMIT, snapshotStartDelayMs: 300 },
    env: { PIECES_MIGRATION_BATCH: "0", SNAPSHOT_DIR: "{tmp}/snap" },
    autostart: false,
  });
  const entries: string[] = [];
  const entry = (space: string, problem: string, score: number, config: string) =>
    entries.push(`INSERT INTO space_entries (space, problem, score, name, agent_note, software, method, seed, created_at, config) VALUES (${q(space)}, ${q(problem)}, ${score}, 'ann', '', NULL, 'm', ${entries.length}, '2026-10-2${entries.length % 10}T09:00:00.000Z', ${q(config)})`);
  entry("surface", "surface/cube/fold/0/2", 3, JSON.stringify({ s: 3, pieces: [{ face: 0, x: 0.5, y: -0.25, theta: 1 }, { face: 1, x: 1, y: 2, theta: 0 }] }));
  entry("surface", "surface/cube/fold/4/2", 3, JSON.stringify({ s: 3, pieces: [{ face: 0, x: 0.5, y: -0.25, theta: 1 }] }));
  entry("sphere", "sphere/0/5", 1.5, JSON.stringify({ rho: 1.5, pieces: [{ q: [1, 0, 0, 0] }] }));
  entry("sphere", "sphere/3/5", 1.5, JSON.stringify({ rho: 1.5, pieces: [{ q: [1, 0, 0, 0] }] }));
  entry("torus", "torus/sq/0/4", 4, JSON.stringify({ lattice: { L: 4 }, poses: [[1, 2, 0.5], [3, 0.5, 0]] }));
  entry("torus", "torus/free/0/4", 4, JSON.stringify({ lattice: { b1: [4, 0], b2: [1, 4] }, poses: [[1, 2, 0.5], "odd", [3]] }));
  entry("torus", "torus/hex/5/4", 4, JSON.stringify({ lattice: { L: 4 }, poses: [[1, 2, 0.5]] }));
  entry("boundary", "boundary/tesseract/ball/3", 2.5, JSON.stringify({ s: 2.5, pieces: [{ cell: 0, u: [0.5, -1, "x"] }, { cell: 1, u: [1, 1, 1] }] }));
  entry("boundary", "boundary/tesseract/cube/3", 2.5, JSON.stringify({ s: 2.5, pieces: [{ cell: 0, u: [0.5, -1, 0] }] }));
  entry("balls", "balls/ballinball/3", 4.3, JSON.stringify({ s: 4.3, pieces: [[1, 0, 0], [-1, 0, 0.5]] }));
  entry("balls", "balls/ballincub/3", 4, JSON.stringify({ s: 4, pieces: [[1, 0, 0], [-1, 0, 0.5]] }));
  entry("balls", "balls/tetinball/3", 1.2, JSON.stringify({ s: 1.2, pieces: [[1, 0, 0, 1, 0, 0, 0]] }));
  entry("balls", "balls/cubincub/3", 2, JSON.stringify({ s: 2, pieces: [[1, 0, 0, 1, 0, 0, 0]] }));
  entry("curved", "curved/0/0/0/3", 4.3, JSON.stringify({ size: 4.3, pieces: [{ x: 1, y: 0.5, theta: 0 }] }));
  entry("curved", "curved/0/0/5/3", 5, JSON.stringify({ size: 5, pieces: [{ x: 1, y: 0.5, theta: 0 }, 7] }));
  entry("curved", "curved/-1/0/5/3", 5, JSON.stringify({ size: 5, pieces: [{ x: 1, y: 0.5, theta: 0 }] }));
  entry("curved", "curved/1/0/0/2", 1.1, JSON.stringify({ size: 1.1, pieces: [] }));
  entry("curved", "curved/-1/5/0/3", 2, JSON.stringify({ size: 2, pieces: [{ x: 1, y: 0.5, theta: 0 }] }));
  entry("curved", "curved/-1/5/7/3", 2, JSON.stringify({ size: 2, pieces: [{ x: 1, y: 0.5, theta: 0 }] }));
  entry("polyhedra", "polyhedra/cubincub/3", 2, JSON.stringify({ s: 2, pieces: [[0, 0, 0, 1, 0, 0, 0]] }));
  entry("ndim", "ndim/4/ball/cube/2", 2, JSON.stringify({ s: 2, pieces: [[0, 0, 0, 0]] }));
  entry("sphere", "sphere/0/6", 2, "{ not json");
  entry("sphere", "sphere/0/7", 2, "[1, 2]");
  entry("sphere", "not an id", 2, JSON.stringify({ rho: 2 }));
  entry("nospace", "nospace/1", 2, JSON.stringify({ s: 2 }));
  entry("surface", "surface/cube/fold/0/3", 3, JSON.stringify({ s: "3", pieces: "none", extra: { x: 1 } }));
  entry("polyhedra", "polyhedra/tetintet/7", 2.0000000001, JSON.stringify({ s: 2.0000000001, pieces: [] }));
  entry("polyhedra", "polyhedra/tetintet/7", 2, JSON.stringify({ s: 2, pieces: [] }));
  b.add({
    op: "sql",
    statements: [
      "CREATE TABLE submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL, m INTEGER NOT NULL, p INTEGER NOT NULL, score REAL NOT NULL, name TEXT NOT NULL, agent TEXT NOT NULL DEFAULT '', agent_note TEXT NOT NULL, pieces TEXT NOT NULL, container_phi REAL NOT NULL, created_at TEXT NOT NULL, verification TEXT NOT NULL DEFAULT 'none', literature_value REAL, strict_check TEXT, found_with TEXT, method TEXT, method_params TEXT, seed INTEGER, budget TEXT, software TEXT)",
      "CREATE INDEX submissions_verification ON submissions (verification)",
      "CREATE INDEX submissions_listing ON submissions (n, m, p, score, id, verification, name, found_with, agent_note, created_at)",
      "CREATE TABLE tallies (n INTEGER NOT NULL, m INTEGER NOT NULL, p INTEGER NOT NULL, accepted INTEGER NOT NULL, PRIMARY KEY (n, m, p))",
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
      "INSERT INTO meta VALUES ('pieces_migrated', 1)",
      "CREATE TABLE space_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, space TEXT NOT NULL, problem TEXT NOT NULL, score REAL NOT NULL, name TEXT NOT NULL, agent_note TEXT NOT NULL, software TEXT, method TEXT, seed INTEGER, created_at TEXT NOT NULL, config TEXT NOT NULL)",
      `INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at, found_with, method, method_params, seed, budget, software) VALUES (0, 0, 3, 4.3094010767585, 'disks', '', X'${hexOf(disks(3, 2))}', 0.25, '2026-10-20T10:00:00.000Z', 'optimizer', 'polish', '{"a":1}', 7, '{"evals":5}', 'tool')`,
      `INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at) VALUES (4, 4, 11, 4, 'squares', '', X'${hexOf(grid(11, 4))}', 0, '2026-10-20T10:00:01.000Z')`,
      "INSERT INTO tallies VALUES (0, 0, 3, 41), (4, 4, 11, 7)",
      // two listed entries of one problem within the tie tolerance, as a database from before the prune can hold them: the earlier one leads
      `INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at) VALUES (6, 6, 5, 3.0000000001, 'earlier, a hair worse', '', X'${hexOf(row(5, 2))}', 0, '2026-10-20T10:00:02.000Z')`,
      `INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at) VALUES (6, 6, 5, 3, 'later, a hair better', '', X'${hexOf(row(5, 2))}', 0, '2026-10-20T10:00:03.000Z')`,
      `INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at) VALUES (6, 6, 5, 2, 'rejected long ago', '', X'${hexOf(row(5, 2))}', 0, '2026-10-20T10:00:04.000Z')`,
      "UPDATE submissions SET verification = 'rejected' WHERE name = 'rejected long ago'",
      ...entries,
    ],
  });
  b.add({ op: "dump" }).add({ op: "start" }).wait(1500);
  // the snapshot of such a database: entries of closed problems, of ids that are no problem and of unknown spaces are left out
  b.get("/api/snapshot", 200);
  for (const space of SPACE_NAMES) b.get(`/api/snapshot/space-${space}.json.gz`);
  b.get("/api/snapshot/0-0.json.gz").get("/api/snapshot/6-6.json.gz");
  const spaceReads = () => {
    for (let id = 1; id <= entries.length; id++) b.get(`/api/spaces/entries/${id}`);
    for (const space of ["surface", "sphere", "torus", "boundary", "balls", "curved"]) b.get(`/api/spaces/${space}/site-only`);
    b.get("/api/submissions/1").get("/api/leaderboard/0/0/3").get("/api/leaderboard/4/4/11");
    b.get("/api/leaderboard/6/6/5").get("/api/holders").get("/api/leaders?keys=6/6/5,polyhedra/tetintet/7").get("/api/records?N=6&M=6").get("/api/holder?name=earlier%2C%20a%20hair%20worse");
    b.get("/api/spaces/polyhedra/site-only").get("/api/spaces/polyhedra/problems/polyhedra/tetintet/7").get("/api/atlas?N=6&M=6");
  };
  spaceReads();
  b.dump().add({ op: "restart" });
  spaceReads();
  // the opposite marker: a database already converted is left alone, also when its epoch is higher
  b.add({ op: "stop" }).add({ op: "sql", statements: ["UPDATE meta SET value = 3 WHERE key = 'units_epoch'"] }).add({ op: "start" });
  b.get("/api/submissions/1");
  b.add({ op: "stop" }).add({ op: "sql", statements: ["UPDATE meta SET value = 1 WHERE key = 'units_epoch'"] }).add({ op: "start" });
  b.get("/api/submissions/1").get("/api/spaces/entries/1");
  return [a, b];
}

/** A database whose conversion fails, and a snapshot directory that cannot be one. */
export function brokenScenarios(): Scenario[] {
  const a = new Scenario("migrate-fails", "databases of older versions", {
    about: "a database in the old units with disk pieces that cannot be decoded: the conversion is rolled back whole and the server does not start, each time",
    options: { limits: NOLIMIT },
    autostart: false,
  });
  a.add({
    op: "sql",
    statements: [
      "CREATE TABLE submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL, m INTEGER NOT NULL, p INTEGER NOT NULL, score REAL NOT NULL, name TEXT NOT NULL, agent TEXT NOT NULL DEFAULT '', agent_note TEXT NOT NULL, pieces TEXT NOT NULL, container_phi REAL NOT NULL, created_at TEXT NOT NULL, verification TEXT NOT NULL DEFAULT 'none', literature_value REAL, strict_check TEXT)",
      `INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at) VALUES (0, 4, 2, 6, 'good disks', '', X'${hexOf(disks(2, 4))}', 0, '2026-10-01T10:00:00.000Z')`,
      "INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at) VALUES (0, 4, 3, 6, 'disks that cannot be read', '', X'0102030405', 0, '2026-10-01T10:00:01.000Z')",
    ],
  });
  a.add({ op: "dump" }).add({ op: "start", expectFail: true }).add({ op: "dump" }).add({ op: "start", expectFail: true }).add({ op: "dump" });
  // with the row repaired by hand, the same database starts and is converted
  a.add({ op: "sql", statements: [`UPDATE submissions SET pieces = X'${hexOf(disks(3, 4))}' WHERE id = 2`] }).add({ op: "start" });
  a.get("/api/submissions/1", 200).get("/api/submissions/2", 200).get("/api/leaderboard/0/4/3", 200);

  const b = new Scenario("snapshot-broken-dir", "snapshot", {
    about: "SNAPSHOT_DIR names a file: the build fails, is logged with the system's own error text, and the server goes on without a snapshot",
    options: { limits: NOLIMIT, snapshotStartDelayMs: 300 },
    env: { SNAPSHOT_DIR: "{tmp}/snapfile" },
    autostart: false,
  });
  b.add({ op: "file", path: "snapfile", text: "not a directory" }).add({ op: "start" });
  b.wait(1500).get("/api/snapshot", 404).get("/api/snapshot/4-4.json.gz", 404).get("/api/health", 200);
  return [a, b];
}

/** The entry point's own settings, with no options file: the scenarios that also run against apps/server/src/node.ts. */
export function entryScenarios(): Scenario[] {
  const base = { ADMIN_TOKEN: "", CLIENT_IP_HEADER: "" };
  const a = new Scenario("entry-defaults", "entry point", {
    about: "no options file, the repository's own records: defaults of every limit, admin routes without a token, no snapshot",
    options: null,
    env: base,
    clockAt: undefined,
  });
  a.get("/api/health", 200).get("/api/problems/4/4/2").get("/api/problems/3/3/5").get("/api/records/pairs", 200).get("/api/spaces", 200);
  a.get("/api/admin/pending", 503).post("/api/admin/review", { id: 1, decision: "confirmed" }, 503, AUTH).post("/api/admin/spaces/remove", { id: 1 }, 503, AUTH);
  a.get("/api/snapshot", 404).get("/api/snapshot/4-4.json.gz", 404).req("HEAD", "/api/snapshot/4-4.json.gz").post("/__test/control", {});
  a.get("/", 404).get("/index.html", 404).get("/tighter.html").get("/assets/x.js").get("/spaces/x.html", undefined, { "accept-encoding": "gzip" });
  a.post("/api/submit", { N: 7, M: 9, P: 2, pieces: row(2, 3), name: "ann" }, 200).post("/api/submit", {}, 401, { "x-submit-key": "anything" });
  a.get("/api/leaderboard/7/9/2", 200).get("/api/holders", 200);
  const b = new Scenario("entry-settings", "entry point", {
    about: "no options file: the placeholder admin token, a short submit key, settings that are not whole numbers, the address from a proxy's header",
    options: null,
    env: { ...base, ADMIN_TOKEN: "change-me", SUBMIT_KEY: "too short", TRUST_PROXY: "1", OVERLOAD_DELAY_MS: "x1", PIECES_MIGRATION_BATCH: "1e3", PIECES_MIGRATION_PAUSE_MS: "", SNAPSHOT_HOUR: "99", SNAPSHOT_DIR: "{tmp}/snap" },
    clockAt: undefined,
    autostart: false,
  });
  b.add({ op: "file", path: "snap/old.json.gz", gzipText: "stored by an older server" }).add({ op: "start" });
  b.get("/api/admin/pending", 503, { authorization: "Bearer change-me" }).post("/api/submit", {}, 401, { "x-submit-key": "too short" });
  b.get("/api/snapshot", 404).wait(300).add({ op: "ls", dir: "snap" });
  for (let i = 0; i < 3; i++) b.req("POST", "/api/submit", { json: {}, headers: { "x-forwarded-for": `9.9.9.${i}, 1.1.1.1` }, expect: 400 });
  b.add({ op: "restart", env: { ADMIN_TOKEN: "a real token", SUBMIT_KEY: KEY, TRUST_PROXY: "", CLIENT_IP_HEADER: "Fly-Client-IP", OVERLOAD_DELAY_MS: "0", SNAPSHOT_HOUR: "", PIECES_MIGRATION_BATCH: "0" } });
  b.get("/api/admin/pending", 200, { authorization: "Bearer a real token" }).get("/api/admin/pending", 401, AUTH);
  b.req("POST", "/api/submit", { json: {}, headers: { "fly-client-ip": " 2001:db8::1 ", "x-submit-key": KEY }, expect: 400 });
  b.req("POST", "/api/submit", { json: {}, headers: { "fly-client-ip": "", "x-forwarded-for": "8.8.8.8" }, expect: 400 });
  return [a, b];
}

/** The load line that the server writes once a minute by itself. */
export function minuteScenario(): Scenario {
  const s = new Scenario("minute", "limits", {
    about: "the line the server writes after each minute with submissions or open streams, and none after an idle one (waits 125 s)",
    options: { limits: NOLIMIT, statsFlushMs: 60_000 },
  });
  s.slow = true;
  s.submit(squares(11, {}, grid(11, 4)), 200).submit(squares(11, {}, row(11, 0.5)), 422).submit({}, 400);
  s.add({ op: "sse_open", stream: "all", path: "/api/events" }).add({ op: "sse_open", stream: "one", path: "/api/events?keys=4/4/11,4/4/*" });
  s.wait(61_500).add({ op: "sse_close", stream: "all" }).add({ op: "sse_close", stream: "one" }).wait(63_000);
  return s;
}

