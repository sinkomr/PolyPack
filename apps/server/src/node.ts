import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { LiteratureRecord, closedToSubmissions } from "@polypack/geometry";
import { HOLDERS_REFRESH_MS, createApp } from "./app";
import { OVERLOAD_DELAY_MS } from "./limits";
import { LoadStats, LoopDelay } from "./load";
import { scheduleSnapshots, snapshotSource } from "./snapshot";
import { SqliteStore } from "./sqlite-store";

// Node entry point: local development and any always-on host.
const root = resolve(import.meta.dirname, "../../..");
const port = Number(process.env.PORT ?? 8787);
const databasePath = process.env.DATABASE_PATH ?? resolve(root, "polypack.sqlite");
// HOST=127.0.0.1 keeps the server off the network when a tunnel or proxy on the same machine fronts it.
const hostname = process.env.HOST || undefined;
const trustProxy = process.env.TRUST_PROXY === "1";
// A header that the proxy in front sets itself to the visitor's address and that a visitor cannot
// forge: "fly-client-ip" on Fly.io, "cf-connecting-ip" behind Cloudflare. Preferred over TRUST_PROXY,
// because proxies append to x-forwarded-for and so leave its first entry in the visitor's hands.
const clientIpHeader = process.env.CLIENT_IP_HEADER?.toLowerCase() || undefined;
// The placeholder from .env.example must never work as a real token: without one, admin routes answer 503.
const adminToken = process.env.ADMIN_TOKEN === "change-me" ? undefined : process.env.ADMIN_TOKEN || undefined;
if (process.env.ADMIN_TOKEN === "change-me")
  console.warn("ADMIN_TOKEN is still the placeholder; admin access is disabled");

const records: LiteratureRecord[] = JSON.parse(readFileSync(resolve(root, "data/records.json"), "utf8")).records;

/** A non-negative integer setting; the default when it is unset or not such a number. */
function wholeNumber(name: string, fallback: number): number {
  const text = process.env[name];
  if (text === undefined || text === "") return fallback;
  if (/^\d{1,9}$/.test(text)) return Number(text);
  console.warn(`${name}=${text} is not a whole number; using ${fallback}`);
  return fallback;
}

const store = new SqliteStore(databasePath);
// Rewrites the pieces of older rows in small steps while the site runs (see docs/DEPLOY_FLY.md).
// Each step is one short transaction, so requests wait at most for one step.
// PIECES_MIGRATION_BATCH=0 switches it off.
store.startPiecesMigration({
  batch: wholeNumber("PIECES_MIGRATION_BATCH", 100),
  pauseMs: wholeNumber("PIECES_MIGRATION_PAUSE_MS", 1000),
  log: (msg) => console.log(msg),
});

// The nightly records snapshot (snapshot.ts), built into SNAPSHOT_DIR at SNAPSHOT_HOUR (UTC, 11 by
// default: after the nightly trim-down job) and served at /api/snapshot. Off without SNAPSHOT_DIR.
const snapshotDir = process.env.SNAPSHOT_DIR || undefined;
if (snapshotDir) {
  const literature = new Map(records.map((r) => [`${r.N}/${r.M}/${r.P}`, r]));
  const hourUtc = wholeNumber("SNAPSHOT_HOUR", 11);
  scheduleSnapshots({
    store,
    dir: snapshotDir,
    closed: (N, M, P) => closedToSubmissions(literature.get(`${N}/${M}/${P}`)),
    hourUtc: hourUtc < 24 ? hourUtc : 11,
    log: (msg) => console.log(msg),
  });
}

// One log line per submission and one a minute with the counts and verification times, so that
// the load in production can be read from the log.
const delay = new LoopDelay();
const stats = new LoadStats((line) => console.log(line));
setInterval(() => stats.flush(delay.takePeak()), 60_000).unref();

const app = createApp({
  store,
  records,
  adminToken,
  // the end-to-end tests set 0, so that the record holders page shows each entry at once
  holdersRefreshMs: wholeNumber("HOLDERS_REFRESH_MS", HOLDERS_REFRESH_MS),
  // 0 never refuses submissions as overload; the end-to-end tests set it, since a test machine
  // under load delays the event loop without the server being overloaded
  limits: { overloadDelayMs: wholeNumber("OVERLOAD_DELAY_MS", OVERLOAD_DELAY_MS) },
  loopDelay: () => delay.ms(),
  stats,
  snapshots: snapshotDir ? snapshotSource(snapshotDir) : undefined,
  // Behind a proxy the socket address is the proxy's, so a header set by the proxy is used instead.
  // Only set CLIENT_IP_HEADER or TRUST_PROXY when a proxy that sets the header is really in front.
  clientIp: (c) =>
    (clientIpHeader && c.req.header(clientIpHeader)?.trim()) ||
    (trustProxy && c.req.header("x-forwarded-for")?.split(",")[0].trim()) ||
    getConnInfo(c).remote.address ||
    "unknown",
});

// In production the built web app is served by the same process.
const dist = resolve(root, "apps/web/dist");
if (existsSync(dist)) {
  app.use("/*", serveStatic({ root: dist }));
}

const server = serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(
    `PolyPack server on http://localhost:${port} (database ${databasePath}, ${records.length} literature records)`,
  );
});

// A host stops the process with a signal at every deploy and restart. Open live-update streams
// would keep it alive until the host kills it, so exit at once; SQLite has committed every write.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
