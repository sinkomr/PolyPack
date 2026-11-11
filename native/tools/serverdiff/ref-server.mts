// The TypeScript server, started from an options file: the reference side of the differential
// harness (README.md). It does what apps/server/src/node.ts does, statement for statement and with
// the same environment variables, and adds what the test contract asks of a server under test:
//   - the options of POLYPACK_TEST_OPTIONS (a JSON file; README.md, "The options file");
//   - the test clock (lib/test-clock.mts);
//   - POST /__test/control.
// Nothing under apps/ or packages/ is changed: the app is wrapped from outside.
//   PORT=24001 DATABASE_PATH=/tmp/x.sqlite POLYPACK_TEST_OPTIONS=/tmp/options.json \
//     node --import tsx native/tools/serverdiff/ref-server.mts
import { setClockOffset } from "./lib/test-clock.mts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { compress } from "hono/compress";
import { LiteratureRecord, closedToSubmissions } from "@polypack/geometry";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { createApp } from "../../../apps/server/src/app.ts";
import { MIN_SUBMIT_KEY_LENGTH, OVERLOAD_DELAY_MS } from "../../../apps/server/src/limits.ts";
import { LoadStats, LoopDelay } from "../../../apps/server/src/load.ts";
import { scheduleSnapshots, snapshotSource, snapshotSpaces } from "../../../apps/server/src/snapshot.ts";
import { SqliteStore } from "../../../apps/server/src/sqlite-store.ts";
import { mutant } from "./lib/mutants.mts";

/** The options file (README.md); every field is optional. */
interface TestOptions {
  recordsFile?: string;
  spacesRoot?: string;
  staticDir?: string | null;
  limits?: {
    perIp?: number;
    windowMs?: number;
    verifyMsPerMinute?: number;
    perKey?: number;
    keyVerifyMsPerMinute?: number;
    overloadDelayMs?: number;
    snapshotFilesPerHour?: number;
  };
  holdersChunk?: number;
  holderChunk?: number;
  unitsGate?: boolean;
  snapshotStartDelayMs?: number;
  clockOffsetMs?: number;
  loopDelayMs?: number | null;
  statsFlushMs?: number;
}

const optionsPath = process.env.POLYPACK_TEST_OPTIONS || undefined;
const test: TestOptions = optionsPath ? JSON.parse(readFileSync(optionsPath, "utf8")) : {};
// before anything reads the time
if (typeof test.clockOffsetMs === "number") setClockOffset(test.clockOffsetMs);
/** The event-loop delay the overload check reads instead of the measured one; null: the measured one. */
let loopDelayOverride: number | null = typeof test.loopDelayMs === "number" ? test.loopDelayMs : null;

const out = mutant.log((msg: string) => console.log(msg));

// ---- from here on: apps/server/src/node.ts, with the options where it has constants ----
const root = resolve(import.meta.dirname, "../../..");
const port = Number(process.env.PORT ?? 8787);
const databasePath = process.env.DATABASE_PATH ?? resolve(root, "polypack.sqlite");
const hostname = process.env.HOST || undefined;
const trustProxy = process.env.TRUST_PROXY === "1";
const clientIpHeader = process.env.CLIENT_IP_HEADER?.toLowerCase() || undefined;
const adminToken = process.env.ADMIN_TOKEN === "change-me" ? undefined : process.env.ADMIN_TOKEN || undefined;
if (process.env.ADMIN_TOKEN === "change-me")
  console.warn("ADMIN_TOKEN is still the placeholder; admin access is disabled");
const submitKeyText = process.env.SUBMIT_KEY?.trim() || undefined;
const submitKey = submitKeyText && submitKeyText.length >= MIN_SUBMIT_KEY_LENGTH ? submitKeyText : undefined;
if (submitKeyText && !submitKey)
  console.warn(`SUBMIT_KEY has fewer than ${MIN_SUBMIT_KEY_LENGTH} characters; submissions with a key are refused`);

const records: LiteratureRecord[] = JSON.parse(
  readFileSync(test.recordsFile ?? resolve(root, "data/records.json"), "utf8"),
).records;
const spaces = loadSpacesIndex(test.spacesRoot ?? root, out);

function wholeNumber(name: string, fallback: number): number {
  const text = process.env[name];
  if (text === undefined || text === "") return fallback;
  if (/^\d{1,9}$/.test(text)) return Number(text);
  console.warn(`${name}=${text} is not a whole number; using ${fallback}`);
  return fallback;
}

const store = new SqliteStore(databasePath, { log: out });
store.startPiecesMigration({
  batch: wholeNumber("PIECES_MIGRATION_BATCH", 100),
  pauseMs: wholeNumber("PIECES_MIGRATION_PAUSE_MS", 1000),
  log: out,
});

const snapshotDir = process.env.SNAPSHOT_DIR || undefined;
const literature = new Map(records.map((r) => [`${r.N}/${r.M}/${r.P}`, r]));
const snapshotClosed = (N: number, M: number, P: number) => closedToSubmissions(literature.get(`${N}/${M}/${P}`));
const snapshotSpaceEntries = snapshotSpaces(spaces, store);
const snapshotHour = wholeNumber("SNAPSHOT_HOUR", 11);
if (snapshotDir)
  scheduleSnapshots({
    store,
    dir: snapshotDir,
    closed: snapshotClosed,
    spaces: snapshotSpaceEntries,
    hourUtc: snapshotHour < 24 ? snapshotHour : 11,
    log: out,
    // test option; node.ts leaves the default of 5 minutes
    ...(test.snapshotStartDelayMs === undefined ? {} : { startDelayMs: test.snapshotStartDelayMs }),
  });

const delay = new LoopDelay();
const stats = new LoadStats(out);
// test option: how often the load line is written (node.ts: every minute); 0 writes it on request only
const statsFlushMs = test.statsFlushMs ?? 60_000;
if (statsFlushMs > 0) setInterval(() => stats.flush(delay.takePeak()), statsFlushMs).unref();

const app = createApp({
  store: mutant.store(store),
  records,
  adminToken,
  submitKey,
  // the options file's limits; overloadDelayMs from OVERLOAD_DELAY_MS when the file does not give it
  limits: { overloadDelayMs: wholeNumber("OVERLOAD_DELAY_MS", OVERLOAD_DELAY_MS), ...(test.limits ?? {}) },
  loopDelay: () => loopDelayOverride ?? delay.ms(),
  stats,
  // node.ts leaves `log` to createApp's default, console.log; it is given only to change a line (lib/mutants.mts)
  ...(mutant.active ? { log: out } : {}),
  snapshots: snapshotDir
    ? snapshotSource({ dir: snapshotDir, store, closed: snapshotClosed, spaces: snapshotSpaceEntries })
    : undefined,
  spaces: { index: spaces, store },
  clientIp: (c) =>
    (clientIpHeader && c.req.header(clientIpHeader)?.trim()) ||
    (trustProxy && c.req.header("x-forwarded-for")?.split(",")[0].trim()) ||
    getConnInfo(c).remote.address ||
    "unknown",
  ...(test.holdersChunk === undefined ? {} : { holdersChunk: test.holdersChunk }),
  ...(test.holderChunk === undefined ? {} : { holderChunk: test.holderChunk }),
  ...(test.unitsGate === undefined ? {} : { unitsGate: test.unitsGate }),
});

// The one test-only route (README.md, "POST /__test/control"); it exists only with an options file.
if (optionsPath)
  app.post("/__test/control", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "body must be a JSON object" }, 400);
    if (typeof body.clockOffsetMs === "number") setClockOffset(body.clockOffsetMs);
    if (body.loopDelayMs === null || typeof body.loopDelayMs === "number") loopDelayOverride = body.loopDelayMs;
    if (body.flushStats === true) stats.flush(delay.takePeak());
    return c.json({ ok: true });
  });

const dist = test.staticDir === undefined ? resolve(root, "apps/web/dist") : test.staticDir;
if (dist !== null && existsSync(dist)) {
  app.use("/spaces/*", compress());
  app.use("/tighter.html", async (c, next) => {
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    c.header("Cross-Origin-Embedder-Policy", "require-corp");
    await next();
  });
  app.use("/assets/*", async (c, next) => {
    c.header("Cross-Origin-Embedder-Policy", "require-corp");
    await next();
  });
  app.use("/*", serveStatic({ root: dist }));
}

const server = serve({ fetch: mutant.fetch(app.fetch as never, store) as typeof app.fetch, port, hostname }, () => {
  out(`PolyPack server on http://localhost:${port} (database ${databasePath}, ${records.length} literature records)`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
