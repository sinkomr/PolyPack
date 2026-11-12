// A small vocabulary for writing scenarios: each builder call appends one step (lib/runner.mts, Step).
import type { RequestSpec } from "../lib/http.mts";
import type { ScenarioHeader, Step } from "../lib/runner.mts";

export const ADMIN = "serverdiff-admin-token";
export const AUTH = { authorization: `Bearer ${ADMIN}` };
/** The server's clock at the start of a scenario, unless it says otherwise. */
export const CLOCK = "2031-03-05T07:08:09.000Z";
export const SQ = Math.PI / 4;

export class Scenario {
  steps: Step[] = [];
  header: ScenarioHeader;
  /** The area of the inventory the scenario counts under. */
  area: string;
  /** True when the scenario is long (a minute's wait) and left out of quick runs. */
  slow = false;

  constructor(name: string, area: string, header: Omit<ScenarioHeader, "scenario"> = {}) {
    this.area = area;
    this.header = {
      scenario: name,
      clockAt: CLOCK,
      ...header,
      env: { ADMIN_TOKEN: ADMIN, CLIENT_IP_HEADER: "x-test-client-ip", ...(header.env ?? {}) },
      options:
        header.options === null
          ? null
          : // loopDelayMs 0: a busy machine must not make the server refuse submissions as overload (503)
            // statsFlushMs 0: the load line is written when a step asks for it, not when a minute happens to end
            { recordsFile: "{fixtures}/records.json", staticDir: null, loopDelayMs: 0, statsFlushMs: 0, ...(header.options ?? {}) },
    };
  }

  add(step: Step): this {
    this.steps.push(step);
    return this;
  }
  req(method: string, path: string, more: Partial<RequestSpec> & { expect?: number; note?: string } = {}): this {
    return this.add({ op: "req", method, path, ...more });
  }
  get(path: string, expect?: number, headers?: Record<string, string>): this {
    return this.req("GET", path, { ...(expect === undefined ? {} : { expect }), ...(headers ? { headers } : {}) });
  }
  post(path: string, json: unknown, expect?: number, headers?: Record<string, string>): this {
    return this.req("POST", path, { json, ...(expect === undefined ? {} : { expect }), ...(headers ? { headers } : {}) });
  }
  /** POST /api/submit from the address `ip`. */
  submit(body: unknown, expect?: number, ip = "10.0.0.1", headers: Record<string, string> = {}): this {
    return this.post("/api/submit", body, expect, { "x-test-client-ip": ip, ...headers });
  }
  spaceSubmit(body: unknown, expect?: number, ip = "10.0.0.1", headers: Record<string, string> = {}): this {
    return this.post("/api/spaces/submit", body, expect, { "x-test-client-ip": ip, ...headers });
  }
  admin(path: string, json: unknown, expect?: number): this {
    return this.post(path, json, expect, AUTH);
  }
  wait(ms: number): this {
    return this.add({ op: "wait", ms });
  }
  control(c: { clockAdvanceMs?: number; loopDelayMs?: number | null; flushStats?: boolean }): this {
    return this.add({ op: "control", ...c });
  }
  dump(): this {
    return this.add({ op: "dump" });
  }
  toJsonl(): string {
    return [JSON.stringify(this.header), ...this.steps.map((s) => JSON.stringify(s))].join("\n") + "\n";
  }
}

/** A deterministic generator of numbers in [0, 1) (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- polygon packings that are valid by construction ----
export type Pose = { x: number; y: number; theta: number };
/** `n` unit squares in a row, `gap` apart (1: touching). */
export const row = (n: number, gap = 1): Pose[] => Array.from({ length: n }, (_, i) => ({ x: i * gap, y: 0, theta: SQ }));
/** `n` unit squares on a grid `cols` wide, `gap` apart. */
export const grid = (n: number, cols: number, gap = 1): Pose[] =>
  Array.from({ length: n }, (_, i) => ({ x: (i % cols) * gap, y: Math.floor(i / cols) * gap, theta: SQ }));
/** A submission of squares in a square. */
export const squares = (P: number, extra: Record<string, unknown> = {}, pieces: Pose[] = row(P)) => ({
  N: 4,
  M: 4,
  P,
  pieces,
  container_phi: 0,
  name: "ann",
  ...extra,
});
/** `n` disks of diameter 1 in a row, `gap` apart. */
export const disks = (n: number, gap = 1): Pose[] => Array.from({ length: n }, (_, i) => ({ x: i * gap, y: 0, theta: 0 }));
