import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { LiteratureRecord } from "@polypack/geometry";
import { createApp } from "./app";
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

const app = createApp({
  store: new SqliteStore(databasePath),
  records,
  adminToken,
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
