import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluate, findOverlaps } from "@polypack/geometry";
import type { PackingConfig } from "@polypack/geometry";
import { registry, run, strictTolerance } from "@polypack/solver";
import type { ProgressFrame, Result } from "@polypack/solver";
import { createSolveRuntime } from "../src/solve-runtime";
import type { SolveRequest, SolveResponse } from "../src/solve-protocol";

vi.mock("@polypack/solver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@polypack/solver")>();
  return { ...actual, run: vi.fn(actual.run) };
});
const actualSolver = await vi.importActual<typeof import("@polypack/solver")>("@polypack/solver");
afterEach(() => {
  vi.mocked(run).mockReset().mockImplementation(actualSolver.run);
});

type RunRequest = Extract<SolveRequest, { type: "run" }>;
type ProgressResponse = Extract<SolveResponse, { type: "progress" }>;
const config: PackingConfig = {
  N: 0,
  M: 0,
  P: 2,
  container_phi: 0,
  pieces: [
    { x: -2, y: 0, theta: 0 },
    { x: 2, y: 0, theta: 0 },
  ],
};
function request(id = 1, overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    type: "run",
    id,
    problem: { N: 0, M: 0, P: 2 },
    method: "seed",
    params: {},
    budget: { evals: 100 },
    seed: 19,
    ...overrides,
  };
}
function harness() {
  const messages: SolveResponse[] = [];
  const runtime = createSolveRuntime((message) => messages.push(message));
  const terminal = async (id: number) => {
    await vi.waitFor(() =>
      expect(messages.some((m) => "id" in m && m.id === id && (m.type === "result" || m.type === "error"))).toBe(true),
    );
    return messages.find((m) => "id" in m && m.id === id && (m.type === "result" || m.type === "error"))!;
  };
  return { runtime, messages, terminal };
}
function frame(candidate: PackingConfig, overrides: Partial<ProgressFrame> = {}): ProgressFrame {
  const evaluation = evaluate(candidate);
  return {
    config: structuredClone(candidate),
    ...evaluation,
    bestScore: evaluation.score,
    stage: { index: 0, method: "seed" },
    elapsed: 0,
    evaluations: 1,
    final: false,
    ...overrides,
  };
}
function emptyResult(): Result {
  return {
    score: null,
    valid: false,
    strict: false,
    container: null,
    method: "seed",
    params: {},
    seed: 19,
    wallTime: 0,
    evaluations: 0,
    trace: [],
    stages: [],
    termination: "completed",
    reasons: [],
  };
}

describe("browser solve runtime", () => {
  it("publishes structured-cloneable registry metadata without identity or execute", () => {
    const { messages } = harness();
    const ready = messages[0];
    expect(ready).toEqual({ type: "ready", methods: registry.list().filter((m) => m.name !== "identity") });
    expect(structuredClone(ready)).toEqual(ready);
    if (ready.type !== "ready") throw new Error("missing ready");
    expect(ready.methods.some((m) => m.name === "polish")).toBe(true);
    expect(ready.methods.every((m) => !("execute" in m))).toBe(true);
  });

  it("runs the registered solver with default final polish, exact shared score and evaluation cap", async () => {
    const { runtime, terminal, messages } = harness();
    runtime.handle(request());
    const message = await terminal(1);
    expect(message.type).toBe("result");
    if (message.type !== "result" || !message.result.best) throw new Error("missing packing");
    const result = message.result;
    expect(result.valid && result.strict).toBe(true);
    expect(result.evaluations).toBeLessThanOrEqual(100);
    expect(result.stages.map((stage) => stage.method)).toEqual(["seed", "polish"]);
    expect(evaluate(result.best!, { autoOrient: true }).score).toBe(result.score);
    expect(findOverlaps(result.best!.N, result.best!.pieces, strictTolerance(result.best!))).toEqual([]);
    expect(messages.some((m) => m.type === "progress" && m.preview?.pieces.length === 2)).toBe(true);
  });

  it("sends harden's working shapes as sketches, separate from its strict previews and result", async () => {
    const { runtime, terminal, messages } = harness();
    const problem = { N: 7, M: 7, P: 7 };
    runtime.handle(request(1, { problem, method: "harden", params: { restarts: 1 }, budget: { evals: 400 } }));
    const message = await terminal(1);
    if (message.type !== "result") throw new Error("missing result");
    expect(message.result.valid && message.result.strict).toBe(true);
    const sketches = messages.filter((m) => m.type === "sketch");
    expect(sketches.length).toBeGreaterThan(0);
    // Every sketch precedes the result, belongs to the job and draws the method's soft shape:
    // a disk or rounded polygon no larger than the true piece, with softness in [0, 1].
    expect(messages.indexOf(sketches.at(-1)!)).toBeLessThan(messages.indexOf(message));
    for (const m of sketches) {
      if (m.type !== "sketch") continue;
      expect(m.id).toBe(1);
      expect(m.frame.stage.method).toBe("harden");
      expect(m.frame.sketch.pieces).toHaveLength(7);
      expect(m.frame.sketch.scale).toBeLessThanOrEqual(1);
      expect(m.frame.sketch.values!.tau).toBeGreaterThanOrEqual(0);
      expect(m.frame.sketch.values!.tau).toBeLessThanOrEqual(1);
      expect(structuredClone(m)).toEqual(m);
    }
    // Strict previews stay true, non-overlapping pieces.
    for (const m of messages)
      if (m.type === "progress" && m.preview)
        expect(findOverlaps(m.preview.N, m.preview.pieces, strictTolerance(m.preview))).toEqual([]);
  });

  it("snapshots all caller inputs before asynchronous execution and preserves budget/start semantics", async () => {
    const { runtime, terminal } = harness();
    const input = request(1, {
      method: "polish",
      start: structuredClone(config),
      params: { maxIterations: 0 },
      budget: { evals: 1 },
    });
    const original = structuredClone(input);
    runtime.handle(input);
    input.problem.P = 9;
    input.start!.pieces[0].x = 400;
    input.params.maxIterations = 300;
    input.budget.evals = 900;
    input.seed = 35;
    const message = await terminal(1);
    expect(vi.mocked(run).mock.calls[0][0]).toEqual(original.problem);
    const options = vi.mocked(run).mock.calls[0][1];
    expect(options.start).toEqual(original.start);
    expect(options.params).toEqual(original.params);
    expect(options.budget).toEqual(original.budget);
    expect(options.seed).toBe(original.seed);
    expect(message.type).toBe("result");
    if (message.type === "result") {
      expect(message.result.evaluations).toBe(1);
      expect(message.result.best!.pieces[0].x).toBe(-2);
    }
  });

  it("rejects busy runs and stale controls without stopping the active job", async () => {
    const { runtime, terminal, messages } = harness();
    runtime.handle(request(1, { method: "mc_compress", start: structuredClone(config), budget: { evals: 100000 } }));
    runtime.handle({ type: "pause", id: 1 });
    runtime.handle(request(2));
    runtime.handle({ type: "stop", id: 2 });
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(messages.filter((m) => m.type === "error" && m.id === 2)).toHaveLength(2);
    expect(messages.some((m) => m.type === "result")).toBe(false);
    runtime.handle({ type: "stop", id: 1 });
    const message = await terminal(1);
    expect(message.type).toBe("result");
    if (message.type === "result") expect(message.result.termination).toBe("aborted");
  });

  it("pauses, resumes and stops a real run while paused, retaining its strict best", async () => {
    const { runtime, terminal, messages } = harness();
    runtime.handle(
      request(1, {
        method: "mc_compress",
        params: { stagnationEvals: 0 },
        start: structuredClone(config),
        budget: { evals: 1000000, time_s: 5 },
      }),
    );
    runtime.handle({ type: "pause", id: 1 });
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(messages.filter((m) => m.type === "progress").at(-1)?.frame.evaluations).toBe(1);
    runtime.handle({ type: "resume", id: 1 });
    await vi.waitFor(() => expect(messages.some((m) => m.type === "progress" && m.frame.evaluations > 1)).toBe(true));
    runtime.handle({ type: "pause", id: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const beforeStop = messages.filter((m): m is ProgressResponse => m.type === "progress").at(-1)!;
    const stoppedAt = performance.now();
    runtime.handle({ type: "stop", id: 1 });
    runtime.handle({ type: "resume", id: 1 });
    expect(messages.some((m) => m.type === "error" && m.id === 1 && m.message.includes("stopping"))).toBe(true);
    // The rejected resume is an error for this id; wait specifically for the authoritative result.
    await vi.waitFor(() => expect(messages.some((m) => m.type === "result" && m.id === 1)).toBe(true));
    expect(performance.now() - stoppedAt).toBeLessThan(1000);
    const result = messages.find((m) => m.type === "result" && m.id === 1);
    if (result?.type !== "result") throw new Error("missing result");
    expect(result.result.termination).toBe("aborted");
    expect(result.result.strict).toBe(true);
    expect(result.result.score!).toBeLessThanOrEqual(beforeStop.previewContainer!.size);
    expect(result.result.best!.pieces.length).toBe(2);
  });

  it("keeps the best strict complete preview through invalid, incomplete and worse progress", async () => {
    const { runtime, messages, terminal } = harness();
    const best = structuredClone(config);
    best.pieces[0].x = -1;
    best.pieces[1].x = 1;
    const initial = frame(config, { container: { ...evaluate(config).container!, phi: 0.2 } });
    const improved = frame(best);
    const toleranceOnly = structuredClone(best);
    toleranceOnly.pieces[1].x -= 5e-10;
    expect(evaluate(toleranceOnly).valid).toBe(true);
    const incomplete = { ...best, pieces: [best.pieces[0]] };
    const mismatch = { ...best, N: 3 };
    vi.mocked(run).mockImplementationOnce(async (_problem, options) => {
      options.onProgress!(initial);
      expect(initial.config!.container_phi).toBe(0);
      options.onProgress!(improved);
      for (const bad of [
        frame(toleranceOnly),
        frame(incomplete, { valid: true, score: 1 }),
        frame(mismatch, { valid: true, score: 1 }),
        frame(best, { score: NaN }),
        frame(best, { valid: false, score: 1 }),
        frame(best, { container: null }),
        frame(config),
      ])
        options.onProgress!({ ...bad, evaluations: 8 });
      return emptyResult();
    });
    runtime.handle(request());
    await terminal(1);
    const progress = messages.filter((m): m is ProgressResponse => m.type === "progress");
    expect(progress).toHaveLength(9);
    expect(progress[0].preview!.container_phi).toBe(0.2);
    expect(progress[0].frame.config!.container_phi).toBe(0);
    for (const message of progress.slice(1)) {
      expect(message.preview).toEqual(best);
      expect(message.previewContainer!.size).toBe(2);
    }
    expect(progress.at(-1)!.frame.evaluations).toBe(8);
  });

  it("does not let observer mutations corrupt retained preview or solver frames", async () => {
    const previews: PackingConfig[] = [];
    const runtime = createSolveRuntime((message) => {
      if (message.type !== "progress") return;
      previews.push(structuredClone(message.preview!));
      message.preview!.pieces[0].x = 999;
      message.frame.config!.pieces[0].x = 555;
      message.previewContainer!.phi = 999;
    });
    const source = frame(config);
    vi.mocked(run).mockImplementationOnce(async (_problem, options) => {
      options.onProgress!(source);
      options.onProgress!({ ...source, valid: false });
      return emptyResult();
    });
    runtime.handle(request());
    await vi.waitFor(() => expect(previews).toHaveLength(2));
    expect(previews[0]).toEqual(config);
    expect(previews[1]).toEqual(config);
    expect(source.config).toEqual(config);
  });

  it("clears failures and clone errors so a following job can run", async () => {
    const { runtime, terminal } = harness();
    runtime.handle(request(1, { method: "missing_method" }));
    expect(await terminal(1)).toMatchObject({ type: "error", id: 1 });
    runtime.handle(request(2, { params: { uncloneable: () => 1 } }));
    expect(await terminal(2)).toMatchObject({ type: "error", id: 2 });
    runtime.handle(request(3));
    expect(await terminal(3)).toMatchObject({ type: "result", id: 3, result: { valid: true, strict: true } });
  });

  it("allows immediate rerun inside a final observer and independent repeat seeded jobs", async () => {
    const results: Result[] = [];
    const runtime = createSolveRuntime((message) => {
      if (message.type !== "result") return;
      results.push(message.result);
      if (message.id === 1) runtime.handle(request(2, { method: "mc_compress", start: structuredClone(config) }));
    });
    runtime.handle(request(1, { method: "mc_compress", start: structuredClone(config) }));
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(results[0].best).toEqual(results[1].best);
    expect(results[0].score).toBe(results[1].score);
    expect(results[0].evaluations).toBe(results[1].evaluations);
  });

  it("transport exceptions do not leave a completed runtime busy", async () => {
    const observed: SolveResponse[] = [];
    const runtime = createSolveRuntime((message) => {
      observed.push(message);
      throw new Error("closed port");
    });
    runtime.handle(request(1));
    await vi.waitFor(() => expect(observed.some((m) => m.type === "result" && m.id === 1)).toBe(true));
    runtime.handle(request(2));
    await vi.waitFor(() => expect(observed.some((m) => m.type === "result" && m.id === 2)).toBe(true));
    expect(observed.some((m) => m.type === "error")).toBe(false);
  });

  it("reports a result that cannot be posted as a plain error for that run and stays usable", async () => {
    const delivered: SolveResponse[] = [];
    const runtime = createSolveRuntime((message) => {
      // Worker postMessage clones synchronously and throws DataCloneError before anything is sent.
      delivered.push(structuredClone(message));
    });
    vi.mocked(run).mockImplementationOnce(async () => ({ ...emptyResult(), params: { observer: () => 1 } }));
    runtime.handle(request(1));
    await vi.waitFor(() => expect(delivered.some((m) => "id" in m && m.id === 1)).toBe(true));
    const terminal = delivered.filter((m) => "id" in m && m.id === 1);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: "error", id: 1 });
    if (terminal[0].type !== "error") throw new Error("missing error");
    expect(terminal[0].message).toContain("could not be sent");
    expect(Object.keys(terminal[0]).sort()).toEqual(["id", "message", "type"]);
    runtime.handle(request(2));
    await vi.waitFor(() => expect(delivered.some((m) => m.type === "result" && m.id === 2)).toBe(true));
  });

  it("reports an uncloneable result even when the transport throws a differently named error", async () => {
    const delivered: SolveResponse[] = [];
    const runtime = createSolveRuntime((message) => {
      try {
        structuredClone(message);
      } catch {
        throw new Error("could not serialize");
      }
      delivered.push(message);
    });
    vi.mocked(run).mockImplementationOnce(async () => ({ ...emptyResult(), params: { observer: () => 1 } }));
    runtime.handle(request(1));
    await vi.waitFor(() => expect(delivered.some((m) => m.type === "error" && m.id === 1)).toBe(true));
    expect(delivered.some((m) => m.type === "result")).toBe(false);
  });
});
