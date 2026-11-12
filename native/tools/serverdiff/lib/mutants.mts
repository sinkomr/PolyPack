// Deliberate defects of the reference server, for the proof that the comparator sees a difference
// (prove.mts, README.md "Soundness"). SERVERDIFF_MUTANT names one; without it nothing is changed.
// Each changes exactly one thing, once per process, at the first request that matches:
//   answer   the body of the first 200 of GET /api/leaderboard/...: `total` is one more
//   status   the first 404 of GET /api/submissions/<id> is 410
//   header   the first answer that has one and is not a wait of the verification budget (whose
//            seconds are not compared): `retry-after` is one more
//   db       after the first stored entry of POST /api/submit: its legacy column `agent` holds "x"
//            (no route reads that column, so only the dump of the database can show it)
//   log      the first "[submit] 200" line of the log says 201
//   float    the first 200 of POST /api/submit: `score` is multiplied by 1 + 1e-10
//   ulp      the same with 1 + 4e-16, one unit in the last place: a difference the comparator must
//            count as "numbers equal to their last digits", not as a defect
// Not part of the contract of a server under test.
import type { SqliteStore } from "../../../../apps/server/src/sqlite-store.ts";

const name = process.env.SERVERDIFF_MUTANT || "";
let done = false;
const once = (hit: boolean): boolean => {
  if (done || !hit) return false;
  done = true;
  return true;
};

type Fetch = (request: Request, ...rest: unknown[]) => Response | Promise<Response>;

async function rewriteJson(r: Response, change: (body: Record<string, unknown>) => void): Promise<Response> {
  const body = (await r.json()) as Record<string, unknown>;
  change(body);
  const headers = new Headers(r.headers);
  const text = JSON.stringify(body);
  headers.set("content-length", String(Buffer.byteLength(text)));
  return new Response(text, { status: r.status, headers });
}

export const mutant = {
  active: name !== "",

  log(write: (msg: string) => void): (msg: string) => void {
    if (name !== "log") return write;
    return (msg) => write(once(msg.startsWith("[submit] 200 ")) ? msg.replace("[submit] 200 ", "[submit] 201 ") : msg);
  },

  store<T>(store: T): T {
    return store;
  },

  fetch(inner: Fetch, store: SqliteStore): Fetch {
    if (!name || name === "log") return inner;
    return async (request, ...rest) => {
      const url = new URL(request.url);
      const r = await inner(request, ...rest);
      const path = url.pathname;
      const json = (r.headers.get("content-type") ?? "").startsWith("application/json");
      if (name === "answer" && request.method === "GET" && path.startsWith("/api/leaderboard/") && r.status === 200) {
        if (once(true)) return rewriteJson(r, (b) => void (b.total = (b.total as number) + 1));
      } else if (name === "status" && request.method === "GET" && /^\/api\/submissions\/\d+$/.test(path)) {
        if (once(r.status === 404)) return new Response(r.body, { status: 410, headers: r.headers });
      } else if (name === "header" && r.headers.has("retry-after") && !(r.status === 429 && Number(r.headers.get("retry-after")) > 60)) {
        if (once(true)) {
          const headers = new Headers(r.headers);
          headers.set("retry-after", String(Number(r.headers.get("retry-after")) + 1));
          const bytes = await r.arrayBuffer();
          headers.set("content-length", String(bytes.byteLength));
          return new Response(bytes, { status: r.status, headers });
        }
      } else if (name === "db" && request.method === "POST" && path === "/api/submit" && r.status === 200 && json) {
        const body = (await r.clone().json()) as { id: number | null };
        if (body.id !== null && once(true))
          (store as unknown as { db: { exec(sql: string): void } }).db.exec(
            `UPDATE submissions SET agent = 'x' WHERE id = ${Number(body.id)}`,
          );
      } else if (
        (name === "float" || name === "ulp") &&
        request.method === "POST" &&
        path === "/api/submit" &&
        r.status === 200 &&
        json
      ) {
        if (once(true))
          return rewriteJson(r, (b) => void (b.score = (b.score as number) * (1 + (name === "float" ? 1e-10 : 4e-16))));
      }
      return r;
    };
  },
};
