/**
 * An in-process stand-in for the PolyPack API, on 127.0.0.1 and a free port: GET /api/targets,
 * GET /api/problems/{N}/{M}/{P}, GET /api/submissions/{id} and POST /api/submit, which scores a
 * packing with @polypack/geometry and keeps one leader per problem like the real server. It
 * records every request, so that tests can check what the client sent.
 *
 * The new spaces' endpoints are served too (packages/spaces/src/types.ts): GET
 * /api/spaces/targets, GET /api/spaces/:space/problems/<id> and POST /api/spaces/submit, which
 * checks a configuration with the client's own wrapper of the spaces' validators (as the server
 * checks it with the same validators) and keeps one site leader per problem.
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
import type { SpaceConfig, SpaceProblemResponse, SpaceSubmitResponse, SpaceTarget } from "@polypack/spaces";
import { checkSpaceConfig, parseSpaceId } from "../src/spaces/model";
import { SOFTWARE_REFUSAL } from "../src/submit";

/** A problem of the new spaces. */
export interface FakeSpaceProblem {
  id: string;
  /**
   * The research record; its configuration must be valid at `score`. Null for a problem without one (the
   * server's status no_record: open, its entries strictly checked).
   */
  certified: { score: number; config: SpaceConfig; status?: "best_known" | "proven" | "infeasible" } | null;
  /** A site entry that leads from the start. */
  site?: { config: SpaceConfig; name: string } | null;
  bound?: number | null;
  priority?: number;
}

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
  /** Rewrites the body of a GET answer before it is sent, to serve malformed answers. */
  mangle?: (path: string, body: unknown) => unknown;
  /**
   * Replaces the answer to the `n`-th POST /api/submit (from 0) after it was processed and stored:
   * "drop" closes the connection without an answer, as when an answer is lost on the way.
   */
  afterSubmit?: (n: number, answer: SubmitResponse) => { status: number; body: unknown } | "drop" | undefined;
  spaces?: FakeSpaceProblem[];
  /** Answer the spaces' endpoints with 404, like a server without them. */
  noSpaces?: boolean;
  /** Answer GET /api/spaces/targets with 400 when it has `spaces` or `max_P`. */
  refuseSpaceFilters?: boolean;
  /** The largest limit of GET /api/spaces/targets (20000; 10000 or 2000 on older servers). */
  spaceTargetsMaxLimit?: number;
  /** As afterSubmit, for the `n`-th POST /api/spaces/submit. */
  afterSpaceSubmit?: (n: number, answer: SpaceSubmitResponse) => { status: number; body: unknown } | "drop" | undefined;
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
  /** The bodies of POST /api/spaces/submit, in order. */
  spaceSubmissions: Record<string, unknown>[];
  /** The best of a space problem: the site leader when it leads, else the research record. */
  spaceBest(id: string): { score: number; site: { id: number; name: string } | null } | null;
  /** The current leader of a problem. */
  leaderOf(N: number, M: number, P: number): { id: number; score: number; name: string } | null;
  /** Valid submissions the server processed (each one an entry stored, if only for a moment). */
  stored(): number;
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
  let stored = 0;

  // ---------- the new spaces ----------
  const spaceProblems = new Map<string, FakeSpaceProblem>();
  const spaceLeaders = new Map<
    string,
    { id: number; score: number; name: string; config: SpaceConfig; created_at: string }
  >();
  const spaceSubmissions: Record<string, unknown>[] = [];
  for (const sp of o.spaces ?? []) {
    const p = parseSpaceId(sp.id);
    if (!p) throw new Error(`fixture id ${sp.id} is not a space problem id`);
    if (
      sp.certified &&
      sp.certified.status !== "infeasible" &&
      !checkSpaceConfig(p.space, p.id, sp.certified.config).valid
    )
      throw new Error(`fixture record of ${sp.id} is not valid`);
    spaceProblems.set(sp.id, sp);
    if (sp.site) {
      const c = checkSpaceConfig(p.space, p.id, sp.site.config);
      if (!c.valid) throw new Error(`fixture site entry of ${sp.id} is not valid`);
      spaceLeaders.set(sp.id, {
        id: nextId++,
        score: c.score!,
        name: sp.site.name,
        config: sp.site.config,
        created_at: "2026-10-01T00:00:00.000Z",
      });
    }
  }
  const spaceOpen = (sp: FakeSpaceProblem) => !sp.certified || (sp.certified.status ?? "best_known") === "best_known";
  const spaceBest = (id: string) => {
    const sp = spaceProblems.get(id);
    if (!sp) return null;
    const l = spaceLeaders.get(id);
    const cert = sp.certified && sp.certified.status !== "infeasible" ? sp.certified.score : null;
    if (l && (cert === null || l.score < cert)) return { score: l.score, site: { id: l.id, name: l.name } };
    return cert === null ? null : { score: cert, site: null };
  };
  const spaceSummary = (sp: FakeSpaceProblem) => {
    const p = parseSpaceId(sp.id)!;
    const l = spaceLeaders.get(sp.id) ?? null;
    return {
      space: p.space,
      id: sp.id,
      fields: {},
      P: p.P,
      status: sp.certified ? (sp.certified.status ?? "best_known") : "no_record",
      certified: sp.certified
        ? {
            score: sp.certified.score,
            display: sp.certified.score.toFixed(6),
            status: sp.certified.status ?? "best_known",
          }
        : null,
      bound: sp.bound === undefined || sp.bound === null ? null : { value: sp.bound, label: "test bound" },
      site_best: l ? { id: l.id, score: l.score, name: l.name, created_at: l.created_at } : null,
      best_score: spaceBest(sp.id)?.score ?? null,
      accepts_submissions: spaceOpen(sp),
    };
  };

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
      // a GET answer may be rewritten by the test
      const answer = (value: unknown) => send(200, o.mangle ? o.mangle(url.pathname, value) : value);
      const parts = url.pathname.split("/").filter(Boolean);

      if (url.pathname.startsWith("/api/spaces")) {
        if (o.noSpaces) return send(404, { error: "not found" });
        if (req.method === "GET" && url.pathname === "/api/spaces/targets") {
          if (o.refuseSpaceFilters && (url.searchParams.has("spaces") || url.searchParams.has("max_P")))
            return send(400, { error: "unknown parameter" });
          // as the server: 500 targets without a limit, at most its largest limit
          const maxLimit = o.spaceTargetsMaxLimit ?? 20000;
          const limit = Number(url.searchParams.get("limit") ?? 500);
          if (!(limit >= 1 && limit <= maxLimit))
            return send(400, { error: `limit must be an integer from 1 to ${maxLimit}` });
          const only = url.searchParams.get("spaces")?.split(",");
          const maxP = url.searchParams.has("max_P") ? Number(url.searchParams.get("max_P")) : Infinity;
          const targets: SpaceTarget[] = [...spaceProblems.values()]
            .filter((sp) => spaceOpen(sp))
            .map((sp) => {
              const p = parseSpaceId(sp.id)!;
              // a problem without a record or an entry has no best yet
              const best = spaceBest(sp.id);
              return {
                space: p.space,
                id: sp.id,
                P: p.P,
                priority: sp.priority ?? 1,
                best_score: best?.score ?? null,
                bound: sp.bound ?? null,
                leader: !best ? ("none" as const) : best.site ? ("site" as const) : ("certified" as const),
                leader_id: best?.site?.id ?? null,
              };
            })
            .filter((t) => (!only || only.includes(t.space)) && t.P <= maxP)
            .slice(0, limit);
          return answer({ generated_at: new Date().toISOString(), targets });
        }
        const m = /^\/api\/spaces\/([a-z]+)\/problems\/(.+)$/.exec(url.pathname);
        if (req.method === "GET" && m) {
          const sp = spaceProblems.get(m[2]);
          if (!sp || !m[2].startsWith(`${m[1]}/`)) return send(404, { error: "no such problem" });
          const l = spaceLeaders.get(sp.id);
          const body: SpaceProblemResponse = {
            ...(spaceSummary(sp) as SpaceProblemResponse),
            conventions: {},
            certified_config: sp.certified && sp.certified.status !== "infeasible" ? sp.certified.config : null,
            site_config: l?.config ?? null,
          };
          return answer(body);
        }
        if (req.method === "POST" && url.pathname === "/api/spaces/submit") {
          const b = body as Record<string, unknown>;
          spaceSubmissions.push(b);
          const refuse = (status: number, reasons: string[]) =>
            send(status, {
              valid: false,
              reasons,
              score: null,
              leader: false,
              best_score: null,
              id: null,
              beats_certified: false,
            });
          if (typeof b !== "object" || b === null) return refuse(400, ["body is not valid JSON"]);
          const sp = spaceProblems.get(String(b.id));
          const p = parseSpaceId(b.id);
          if (!sp || !p || p.space !== b.space) return refuse(400, ["no such problem"]);
          if (!spaceOpen(sp)) return refuse(409, ["this problem is closed"]);
          if (typeof b.name !== "string" || !b.name) return refuse(400, ["name is required"]);
          // the server's rule: below the research record, also valid at the strict tolerance
          const c = checkSpaceConfig(p.space, p.id, b.config, {
            bound: sp.bound ?? null,
            certified: sp.certified && sp.certified.status !== "infeasible" ? sp.certified.score : null,
            ...(sp.certified ? {} : { noRecord: true }),
          });
          if (!c.valid) return refuse(422, c.reasons.length ? c.reasons : ["invalid configuration"]);
          const siteBefore = spaceLeaders.get(sp.id);
          const leads = !siteBefore || improvesOn(c.score!, siteBefore.score);
          const id = leads ? nextId++ : null;
          if (leads)
            spaceLeaders.set(sp.id, {
              id: id!,
              score: c.score!,
              name: b.name,
              config: b.config as SpaceConfig,
              created_at: new Date().toISOString(),
            });
          const result: SpaceSubmitResponse = {
            valid: true,
            reasons: [],
            score: c.score,
            leader: leads,
            best_score: spaceBest(sp.id)?.score ?? null,
            id,
            beats_certified: sp.certified !== null && c.score! < sp.certified.score,
          };
          const replaced = o.afterSpaceSubmit?.(spaceSubmissions.length - 1, result);
          if (replaced === "drop") return res.destroy();
          if (replaced) return send(replaced.status, replaced.body);
          return send(200, result);
        }
        return send(404, { error: "not found" });
      }

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
        return answer({ generated_at: new Date().toISOString(), targets });
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
        return answer(info);
      }

      if (req.method === "GET" && parts[0] === "api" && parts[1] === "submissions" && parts.length === 3) {
        const e = entries.get(Number(parts[2]));
        if (!e) return send(404, { error: "no such submission" });
        return answer({ ...e, agent_note: "", found_with: "hand" });
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
        stored++;
        if (leads) {
          entries.set(id!, { id: id!, N, M, P, name: b.name, score, pieces, container_phi });
          leaders.set(key(N, M, P), id!);
        }
        const result: SubmitResponse = {
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
        };
        const replaced = o.afterSubmit?.(submissions.length - 1, result);
        if (replaced === "drop") return res.destroy();
        if (replaced) return send(replaced.status, replaced.body);
        return send(200, result);
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
    spaceSubmissions,
    spaceBest,
    leaderOf,
    stored: () => stored,
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
