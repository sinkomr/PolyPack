# @polypack/solver

**[EST]** Source-consumed TypeScript workspace; no build step, DOM or Node imports, or additional runtime library beyond `@polypack/geometry`. The core typechecks with ES2022 and no ambient environment declarations. Source: `package.json`, `tsconfig.core.json`, `src/`.

```ts
import { run, runPipeline } from "@polypack/solver";

const control = { aborted: false, paused: false };
const result = await run(problem, {
  method: "identity",
  start: config,
  budget: { evals: 1000, time_s: 2 },
  seed: 1,
  control,
  onProgress: (frame) => console.log(frame.bestScore),
});

const chained = await runPipeline(
  problem,
  { stages: [{ method: "identity", budget: { evals: 10 } }, { method: "polish" }] },
  { start: config, budget: { evals: 1000 }, seed: 1 },
);
```

## Public API

**[EST]** Signatures and full exported types: `src/framework.ts`, `src/schema.ts`, `src/polish.ts`, `src/index.ts`.

```ts
run(problem: Problem, options: RunOptions): Promise<Result>;
runPipeline(problem: Problem, pipeline: Pipeline,
  options: Omit<RunOptions, "method" | "params">): Promise<Result>;
seededRandom(seed: number): () => number;
polish(config: PackingConfig, options?: PolishOptions): Promise<PackingConfig | undefined>;

class MethodRegistry {
  register(method: MethodDefinition): void;
  list(): Omit<MethodDefinition, "execute">[];
  run(problem: Problem, options: RunOptions): Promise<Result>;
  runPipeline(problem: Problem, pipeline: Pipeline,
    options: Omit<RunOptions, "method" | "params">): Promise<Result>;
}

interface MethodContext {
  readonly problem: Problem;
  readonly start?: PackingConfig;
  readonly starts: readonly PackingConfig[];
  readonly initialEvaluation?: Evaluation;
  readonly params: Record<string, unknown>;
  readonly random: () => number;
  shouldStop(): boolean;
  remaining(): { evals: number; time_s: number };
  checkpoint(): Promise<boolean>;
  evaluate(config: PackingConfig, options?: { autoOrient?: boolean }): Promise<Evaluation | undefined>;
  emit(config: PackingConfig): Promise<Evaluation | undefined>;
  run(method: string, params?: Record<string, unknown>,
    options?: { start?: PackingConfig; evals?: number; time_s?: number }): Promise<SubRunResult>;
}
```

`Problem = {N, M, P}`. `RunOptions` has `method?` (default identity), `start?`, `params?`, `budget`, `seed`, `onProgress?`, `signal?`, `control?`, `finalPolish?`. Both control and signal accept structural `{readonly aborted: boolean; readonly paused?: boolean}`; `AbortSignal` remains compatible. `Pipeline` is a JSON document with `stages: {method, params?, budget?}[]`. YAML is not supported.

`Result` contains `best?`, `score`, `valid`, `container`, `method`, resolved `params`, `seed`, `wallTime`, `evaluations`, `trace`, `stages`, `termination`, `reasons`. Termination is `completed | time | evals | aborted | error`. Stage records contain method, resolved params, inclusive evaluation count, wall time, termination and best score after that stage. Sub-run records contain best, score, valid, container, evaluations, termination and reasons. Times are seconds.

## Assessment, errors and frames

**[EST]** Source: `src/framework.ts`, `test/decisions.test.ts`, `test/adversarial.test.ts`.

Every validity and score assessment uses shared geometry. `evaluate` defaults to auto-orientation; `{autoOrient:false}` evaluates only `config.container_phi`. Either costs one evaluation. Candidates are snapshotted before an asynchronous wait. Unparseable candidates and mismatched N/M/P consume one evaluation and return an invalid Evaluation with reasons. Input errors in run options, starts, problems, parameters and pipelines reject the returned promise before method execution.

Best configurations are valid snapshots with `container_phi = evaluation.container.phi`. At termination, one uncounted auto-oriented assessment of best supplies its orientation and score. Therefore `evaluate(result.best)` at its stored phi reproduces `result.score`, and so does the server, which scores a submission at the `container_phi` sent and does not search for a better one. If no valid candidate exists, best is absent, score/container are null, validity is false, and reasons explain the failure. Method exceptions become error Results retaining the best found; progress callback exceptions are swallowed.

Progress frames contain `config?`, current `score`, `bestScore`, `valid`, `container`, `stage: {index, method}`, `elapsed`, `evaluations`, and `final`. Ordinary frames are throttled to one per 50 ms; a final frame is always delivered when a callback exists. Improvement traces are thinned when exceeding 2000 points, preserving their first and latest entries. The framework makes no changes to the returned Result after resolution.

## Method and schema contract

**[EST]** Register `{name, schema, defaults, doc: "docs/methods/<name>.md", execute}`. `registry` lists identity and polish; a new registry initially lists only its own registrations, with builtin polish available as the final-stage fallback. Registry metadata is copied. Parameters fill defaults recursively; entries valued `undefined` are ignored, and arrays replace defaults. Every explicit pipeline stage is resolved before any stage executes. Source: `src/framework.ts`, `src/schema.ts`, `src/methods.ts`.

Schemas are ordinary JSON Schema documents. Supported keywords are `type` (object, array, number, integer, string, boolean), `properties`, `required`, `additionalProperties:false`, `items`, `enum`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minItems`, `maxItems`, `title`, `description`, and `default`. Unsupported keywords are rejected. Identity and polish include descriptions for form tooltips. There is no `$ref`, union, null, conditional or pattern support.

**[EST]** Framework calls must be sequential. Await each evaluate, emit, checkpoint or run before the next framework call. A pending call makes another call reject and ends the method with an error Result, even if the method catches that rejection. Population methods evaluate members one after another. `shouldStop` is synchronous and may be called inside hot numerical loops. Await checkpoint at outer phase boundaries; return when it is false. Submit scoring through context.evaluate. Never use Math.random or clocks for optimization decisions, and await all method work. Methods are cooperative code rather than a sandbox.

## Budgets, pause and composition

**[EST]** At least one overall limit is required: finite nonnegative `time_s`, or safe integer `evals >= 1`. Seeds must be integers in `[0, 2^32 - 1]`. A supplied start is always evaluated first and counts as evaluation 1, even when already aborted or time_s is zero. Normal method return remains completed when it uses its last evaluation; evals/time termination indicates a limit cut execution short. Source: framework and decision tests.

Framework calls check limits and yield on elapsed time, approximately every 12 ms, using MessageChannel when available and a timer otherwise. No checkpoint-count scheduling is used. While paused, checkpoint/evaluation waits, polling every 12 ms for resume or abort; observed paused time is excluded from time budgets. Wall-time/frame/trace metadata includes pauses.

Pipelines share one evaluation counter, random stream, best tracker and overall limits. Stage budgets cap that stage within remaining limits. `ctx.run(name, params, {start, evals?, time_s?})` runs a child method with shared tracking, randomness and counters. If start is omitted, it uses best or the parent's start. Child starts consume an evaluation when execution remains available. A sub-run returns both the shared best (`best`, `score`) and what the sub-run itself found (`found`, `foundScore`), which may be worse than the shared best; iterated methods use the latter for their acceptance rule. Its count includes its own descendants; top-level stage records include all child work. A sub-run that throws reports termination `error` with the message in `reasons` to its caller and does not end the parent. `ctx.remaining()` gives the evaluations and active seconds still available to the method (Infinity when unlimited), so a method can size its sub-run slices.

`emit` evaluates a candidate and retains at most the first 64 valid emitted snapshots for the next stage's starts. Additional emissions are still evaluated. A stage without emissions preserves the incoming pool. `start` is the current shared best; when no best exists, an invalid but parseable start passes on for later repair.

Automatic final polish is appended unless `finalPolish:false` or the last explicit stage is polish. Before appended polish, earlier stages can consume at most 90% of overall time and all but `ceil(evals/10)` evaluations, capped by the count remaining after mandatory start assessment. This reserve is not spent when polish converges early. Sub-runs do not append their own polish. A stage-cap termination is retained in the overall Result even if later stages complete.

**[CALC]** Same inputs, resolved parameters, accepted seed and evals-only budget yield bit-identical optimization output for deterministic sequential methods in the same JavaScript runtime. Wall times and trace timestamps are actual measurements and cannot reproduce bits. Time budgets cannot reproduce bits because machine load and scheduling change how many decisions finish before a deadline. All timing belongs to the runtime adapter and budget plumbing.

**[CALC]** Limits apply between atomic operations. A synchronous geometry call, user callback or noncooperative method cannot be preempted in this same-thread core. Hence absolute wall-time limits and unconditional one-second abort response for arbitrary inputs are not established; cooperative cancellation and pause-abort tests do establish sub-second response on their workloads. A final uncounted orientation scan also takes wall time.

## Numerical tools and measurements

See [contact polish](../../docs/methods/polish.md), [Python tools](../../python/README.md) and [solver framework design and measurements](../../docs/SOLVER_FRAMEWORK.md). Each search method has its own page under [docs/methods](../../docs/methods/); geometric conventions are in [ARCHITECTURE.md](../../docs/ARCHITECTURE.md#conventions). Measured Node framework overhead and known-answer scores are recorded in [solver-measurements.json](../../docs/solver-measurements.json); optional high-precision runs are recorded in [python/measurements.json](../../python/measurements.json). These are local measurements, not browser or universal performance guarantees.

**[EST]** Strict results. The server accepts pair penetration up to 1e-9. A search result must not lean on that allowance, so the framework calls a configuration strict when no pair penetrates by more than `STRICT_TOLERANCE` (1e-12), widened by four units in the last place of the largest coordinate for configurations far from the origin (`strictTolerance`). A strict configuration always replaces a non-strict best and is never replaced by one, whatever the scores. `Result.strict` says which kind the best is; when it is false, `reasons` says so. A start that is valid only within the tolerance is therefore still returned if nothing better is found, and the final polish normally replaces it with a strict one.
