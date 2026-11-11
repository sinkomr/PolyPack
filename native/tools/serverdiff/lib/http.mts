// A plain HTTP/1.1 client on node:http: nothing is added to a request but Host (and Content-Length
// for a body that is not sent chunked), and nothing is done to an answer: no redirect, no
// decompression, every header as the server sent it.
import http from "node:http";
import net from "node:net";

export interface RequestSpec {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  /** A JSON body (sent as JSON.stringify writes it). */
  json?: unknown;
  /** A body given as text. */
  text?: string;
  /** A body of `count` repetitions of `text`, after `prefix` and before `suffix`. */
  repeat?: { prefix?: string; text: string; count: number; suffix?: string };
  /** Sent with Transfer-Encoding: chunked, in pieces of this many bytes (no Content-Length). */
  chunked?: number;
}

export interface RawResponse {
  status: number;
  /** Header names in lower case; a header sent more than once has its values joined with ", ". */
  headers: Record<string, string>;
  body: Buffer;
  /** Set when the connection failed before a complete answer: what happened. */
  error?: string;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

export function bodyOf(spec: RequestSpec): Buffer | null {
  if (spec.json !== undefined) return Buffer.from(JSON.stringify(spec.json));
  if (spec.text !== undefined) return Buffer.from(spec.text);
  if (spec.repeat)
    return Buffer.from((spec.repeat.prefix ?? "") + spec.repeat.text.repeat(spec.repeat.count) + (spec.repeat.suffix ?? ""));
  return null;
}

export async function send(port: number, spec: RequestSpec, timeoutMs = 300_000): Promise<RawResponse> {
  const first = await sendOnce(port, spec, timeoutMs, false);
  // a kept connection that the server had closed meanwhile: nothing was sent, so send again on a new one
  if (first.error === "request: ECONNRESET (kept connection)") return sendOnce(port, spec, timeoutMs, true);
  return first;
}

function sendOnce(port: number, spec: RequestSpec, timeoutMs: number, fresh: boolean): Promise<RawResponse> {
  return new Promise((resolve) => {
    const body = bodyOf(spec);
    const headers: Record<string, string> = { ...(spec.headers ?? {}) };
    const has = (name: string) => Object.keys(headers).some((k) => k.toLowerCase() === name);
    if (body && spec.json !== undefined && !has("content-type")) headers["content-type"] = "application/json";
    if (body && !spec.chunked && !has("content-length")) headers["content-length"] = String(body.length);
    if (body && spec.chunked) headers["transfer-encoding"] = "chunked";
    let settled = false;
    const done = (r: RawResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let req: http.ClientRequest;
    try {
      req = http.request({ host: "127.0.0.1", port, method: spec.method ?? "GET", path: spec.path, headers, agent: fresh ? false : agent }, onResponse);
    } catch (e) {
      // a path or header that HTTP cannot carry: a mistake of the scenario
      return resolve({ status: 0, headers: {}, body: Buffer.alloc(0), error: `not sent: ${e instanceof Error ? e.message : String(e)}` });
    }
    function onResponse(res: http.IncomingMessage): void {
      {
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        const finish = (error?: string) => {
          // answered before the body was all sent (413): the rest of the body must not meet the next request
          if (!req.writableFinished) res.socket?.destroy();
          const h: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) h[k] = Array.isArray(v) ? v.join(", ") : String(v);
          done({ status: res.statusCode ?? 0, headers: h, body: Buffer.concat(parts), ...(error ? { error } : {}) });
        };
        res.on("end", () => finish());
        res.on("error", (e) => finish(`response: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
      }
    }
    const timer = setTimeout(() => {
      req.destroy();
      done({ status: 0, headers: {}, body: Buffer.alloc(0), error: "timeout" });
    }, timeoutMs);
    // a server may answer (413) and close before the whole body is written: the answer still counts
    req.on("error", (e) => {
      const code = (e as NodeJS.ErrnoException).code ?? e.message;
      const kept = req.reusedSocket && code === "ECONNRESET" && !fresh ? " (kept connection)" : "";
      setTimeout(() => done({ status: 0, headers: {}, body: Buffer.alloc(0), error: `request: ${code}${kept}` }), kept ? 0 : 200);
    });
    if (body && spec.chunked) {
      let at = 0;
      const step = spec.chunked;
      const more = () => {
        while (at < body.length) {
          const ok = req.write(body.subarray(at, at + step));
          at += step;
          if (!ok) return void req.once("drain", more);
        }
        req.end();
      };
      more();
    } else req.end(body ?? undefined);
  });
}

/** One block of a text/event-stream: its lines as sent. */
export interface SseBlock {
  lines: string[];
}

export interface SseStream {
  status: number;
  headers: Record<string, string>;
  /** The blocks received so far that `take` has not handed over yet. */
  take(): SseBlock[];
  /** When the last block arrived (performance.now()). */
  lastAt(): number;
  /** For an answer that is not a stream: its whole body, once it ended. */
  body(): Promise<Buffer>;
  close(): void;
  ended(): boolean;
}

/** Opens a stream and returns once the status line and headers are in. */
export function openSse(port: number, path: string, headers: Record<string, string> = {}): Promise<SseStream> {
  return new Promise((resolve, reject) => {
    // its own connection: a stream never goes back to the pool
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path, headers, agent: false }, (res) => {
      const blocks: SseBlock[] = [];
      let pending = "";
      let last = performance.now();
      let ended = false;
      const all: Buffer[] = [];
      let finish!: (b: Buffer) => void;
      const whole = new Promise<Buffer>((r) => (finish = r));
      res.on("data", (c: Buffer) => {
        all.push(c);
        pending += c.toString("utf8");
        for (;;) {
          const cut = pending.indexOf("\n\n");
          if (cut < 0) break;
          blocks.push({ lines: pending.slice(0, cut).split("\n") });
          pending = pending.slice(cut + 2);
          last = performance.now();
        }
      });
      const end = () => {
        ended = true;
        finish(Buffer.concat(all));
      };
      res.on("end", end);
      res.on("error", end);
      res.on("close", end);
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) h[k] = Array.isArray(v) ? v.join(", ") : String(v);
      resolve({
        status: res.statusCode ?? 0,
        headers: h,
        take: () => blocks.splice(0),
        lastAt: () => last,
        body: () => whole,
        close: () => req.destroy(),
        ended: () => ended,
      });
    });
    req.on("error", (e) => reject(e));
    req.end();
  });
}

/** Whether nothing listens on the port (a listener can be started there). */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/** Ports the harness never uses: other sessions on this machine listen there. */
const RESERVED = new Set([8787, 8788, 5174]);
let nextPort = 0;

/** A free port above 20000, from a range that depends on the process so that parallel runs do not meet. */
export async function freePort(base?: number): Promise<number> {
  if (!nextPort) nextPort = base ?? 21000 + (process.pid % 400) * 100;
  for (let tries = 0; tries < 2000; tries++) {
    const port = nextPort++;
    if (nextPort > 64000) nextPort = 21000;
    if (port <= 20000 || RESERVED.has(port)) continue;
    if (await portFree(port)) return port;
  }
  throw new Error("no free port found");
}
