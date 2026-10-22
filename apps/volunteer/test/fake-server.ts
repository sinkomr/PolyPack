/**
 * An in-process stand-in for the PolyPack API, on 127.0.0.1 and a free port: GET /api/targets,
 * GET /api/problems/{N}/{M}/{P}, GET /api/submissions/{id} and POST /api/submit, which scores a
 * packing with @polypack/geometry and keeps one leader per problem like the real server. It
 * records every request, so that tests can check what the client sent.
 */
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type PackingConfig,
  type Pose,
  type ProblemInfo,
  type SubmitResponse,
  type Target,
  evaluate,
  improvesOn,
} from "@polypack/geometry";
import { SOFTWARE_REFUSAL } from "../src/submit";

export interface FakeProblem {
  N: number;
  M: number;
  P: number;
  /** The leader's packing, or null for a problem without one. */
  leader: { pieces: Pose[]; container_phi: number; name: string } | null;
  literature?: ProblemInfo["literature"];
  closed?: boolean;
  priority?: number;
}

export interface FakeServerOptions {
  problems: FakeProblem[];
  /** Answer GET /api/targets with 404, like a server older than the client. */
  noTargets?: boolean;
  /** Refuse `software` with optimizer entries, like the live server before its update. */
  refuseSoftware?: boolean;
}

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeServer {
  url: string;
  requests: Recorded[];
  /** The bodies of POST /api/submit, in order. */
  submissions: Record<string, unknown>[];
  /** The current leader of a problem. */
  leaderOf(N: number, M: number, P: number): { id: number; score: number; name: string } | null;
  close(): Promise<void>;
}

interface Entry {
  id: number;
  N: number;
  M: number;
  P: number;
  name: string;
  score: number;
  pieces: Pose[];
  container_phi: number;
}

const key = (N: number, M: number, P: number) => `${N}/${M}/${P}`;

/** The server's score of a packing: the auto-oriented container size, or null when invalid. */
export function scoreOf(config: PackingConfig): number | null {
  const e = evaluate(config, { autoOrient: true });
  return e.valid && e.container ? e.container.size : null;
}

export async function startFakeServer(o: FakeServerOptions): Promise<FakeServer> {
  let nextId = 100;
  const entries = new Map<number, Entry>();
  const leaders = new Map<string, number>();
  const problems = new Map<string, FakeProblem>();
  for (const p of o.problems) {
    problems.set(key(p.N, p.M, p.P), p);
    if (!p.leader) continue;
    const score = scoreOf({ N: p.N, M: p.M, P: p.P, ...p.leader });
    if (score === null) throw new Error(`fixture leader of ${key(p.N, p.M, p.P)} is not valid`);
    const id = nextId++;
    entries.set(id, { id, N: p.N, M: p.M, P: p.P, score, ...p.leader });
    leaders.set(key(p.N, p.M, p.P), id);
  }
  const leaderOf = (N: number, M: number, P: number) => {
    const id = leaders.get(key(N, M, P));
    const e = id === undefined ? undefined : entries.get(id);
    return e ? { id: e.id, score: e.score, name: e.name } : null;
  };
  const areaBound = (p: FakeProblem) => Math.sqrt(p.P); // any positive number serves the client
  const requests: Recorded[] = [];
  const submissions: Record<string, unknown>[] = [];

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      let body: unknown = undefined;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      requests.push({ method: req.method ?? "", path: url.pathname + url.search, body });
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const parts = url.pathname.split("/").filter(Boolean);

      if (req.method === "GET" && url.pathname === "/api/targets") {
        if (o.noTargets) return send(404, { error: "not found" });
        const targets: Target[] = [...problems.values()]
          .filter((p) => !p.closed)
          .map((p) => {
            const l = leaderOf(p.N, p.M, p.P);
            return {
              N: p.N,
              M: p.M,
              P: p.P,
              reason: l ? "slack" : "unsolved",
              priority: p.priority ?? 1,
              leader: l?.score ?? null,
              leader_id: l?.id ?? null,
              published: p.literature?.value ?? null,
              published_coordinates: !!p.literature?.pieces,
              area_bound: areaBound(p),
            };
          });
        return send(200, { generated_at: new Date().toISOString(), targets });
      }

      if (req.method === "GET" && parts[0] === "api" && parts[1] === "problems" && parts.length === 5) {
        const [N, M, P] = parts.slice(2).map(Number);
        const p = problems.get(key(N, M, P));
        if (!p) return send(404, { error: "no such problem" });
        const l = p.closed ? null : leaderOf(N, M, P);
        const info: ProblemInfo = {
          N,
          M,
          P,
          conventions: {},
          area_bound: areaBound(p),
          literature: p.literature ?? null,
          site_best: l
            ? {
                id: l.id,
                name: l.name,
                found_with: "hand",
                agent_note: "",
                score: l.score,
                created_at: "2026-10-01T00:00:00.000Z",
                verification: "none",
              }
            : null,
          accepts_submissions: !p.closed,
        };
        return send(200, info);
      }

      if (req.method === "GET" && parts[0] === "api" && parts[1] === "submissions" && parts.length === 3) {
        const e = entries.get(Number(parts[2]));
        if (!e) return send(404, { error: "no such submission" });
        return send(200, { ...e, agent_note: "", found_with: "hand" });
      }

      if (req.method === "POST" && url.pathname === "/api/submit") {
        const b = body as Record<string, unknown>;
        submissions.push(b);
        const refuse = (status: number, reasons: string[]) =>
          send(status, {
            valid: false,
            reasons,
            score: null,
            rank: null,
            leader: false,
            leader_score: null,
            id: null,
            container: null,
            pending_verification: false,
            strict_check: null,
          } satisfies SubmitResponse);
        if (typeof b !== "object" || b === null) return refuse(400, ["body is not valid JSON"]);
        if (o.refuseSoftware && b.software !== undefined && b.found_with !== "external")
          return refuse(400, [SOFTWARE_REFUSAL]);
        const N = b.N as number;
        const M = b.M as number;
        const P = b.P as number;
        const p = problems.get(key(N, M, P));
        if (!p) return refuse(400, ["no such problem"]);
        if (p.closed) return refuse(409, ["this problem is closed"]);
        if (typeof b.name !== "string" || !b.name) return refuse(400, ["name is required"]);
        const pieces = b.pieces as Pose[];
        const container_phi = (b.container_phi as number) ?? 0;
        const score = scoreOf({ N, M, P, pieces, container_phi });
        if (score === null) return refuse(422, ["pieces overlap"]);
        const before = leaderOf(N, M, P);
        const leads = !before || improvesOn(score, before.score);
        const id = leads ? nextId++ : null;
        if (leads) {
          entries.set(id!, { id: id!, N, M, P, name: b.name, score, pieces, container_phi });
          leaders.set(key(N, M, P), id!);
        }
        return send(200, {
          valid: true,
          reasons: [],
          score,
          rank: leads ? 1 : 2,
          leader: leads,
          leader_score: leads ? score : before!.score,
          id,
          container: null,
          pending_verification: false,
          strict_check: null,
        } satisfies SubmitResponse);
      }

      send(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    submissions,
    leaderOf,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Three unit squares in a square of side 2.5: valid, and easy to beat (side 2). */
export const LOOSE_SQUARES: FakeProblem = {
  N: 4,
  M: 4,
  P: 3,
  leader: {
    name: "Someone",
    container_phi: 0,
    // at theta = pi/4 a square piece has horizontal and vertical sides
    pieces: [
      { x: 0, y: 0, theta: Math.PI / 4 },
      { x: 1.5, y: 0, theta: Math.PI / 4 },
      { x: 0, y: 1.5, theta: Math.PI / 4 },
    ],
  },
};
