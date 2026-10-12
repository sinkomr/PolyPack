# Solver framework: design and measurements

Labels: **[EST]** established with a source, **[CALC]** computed here, **[SPEC]** speculation.

This page records the design decisions behind `packages/solver` and the measurements taken on the framework, the float64 contact polish and the optional high-precision Python tool. The full API contract is in the [solver README](../packages/solver/README.md); the geometric conventions are in [ARCHITECTURE.md](ARCHITECTURE.md#conventions).

## Design decisions

| Topic | Decision |
|---|---|
| Failures | **[EST]** Candidate parse failures and problem mismatches return invalid Evaluations and consume one evaluation. Method failures return termination `error` with reasons and the valid best found so far. Progress callback exceptions are swallowed. Sources: `src/framework.ts`, framework/adversarial/decision tests. |
| Yielding, stop and pause | **[EST]** Yields are driven by elapsed time only (12 ms), using MessageChannel with a timer fallback and structural types. `shouldStop` is synchronous; polish awaits only outer phases. Pause polling excludes observed paused intervals from active budgets and responds to abort. Sources: `src/runtime.ts`, `src/framework.ts`, `src/polish.ts`. |
| Results and frames | **[EST]** The saved best carries the scored container phi. A Result includes container, stage records and error termination; frames include validity, container, stage and a final flag. Final frames bypass throttling. The trace thins at 2000 points, preserving endpoints; run resolution closes the context and returns independent snapshots. |
| Counting | **[EST]** Fixed-phi and auto-oriented context assessments both count once. A free final auto-oriented assessment supplies the server-equivalent score. The mandatory start assessment counts first, even when the run is already aborted or has zero time. Evaluation limits are positive integers and seeds are uint32; input failures reject the promise. Undefined parameter entries use defaults. Normal completion exactly at its budget stays `completed` unless a subsequent stop check cuts it short. |
| Sequential calls | **[EST]** A pending evaluate/checkpoint/run/emit call makes an overlapping framework call reject, ending with an error Result and the best preserved. Population members must be assessed sequentially. |
| Composition | **[EST]** Child runs share best, random stream and counters, and accept a caller start and optional caps. Pipeline stages accept budget caps. Emission evaluates candidates and retains a 64-entry valid pool for next-stage starts; repairable invalid starts survive stages without a best. An automatic last polish reserves one tenth of the overall budgets unless disabled or already last. |
| Schemas | **[EST]** Schema metadata supports title/description/default and numeric exclusive bounds. Builtin parameters have tooltip descriptions. The registry list returns copied schema/default/doc metadata. |
| Polish | **[EST]** Default `maxIterations` is 300 with early stall/trust termination. Scaled trust bounds contract loose starts. A final active-set Newton refinement fixes jittered starts; strict pair/protrusion acceptance prevents tolerance-derived score gains. Tests cover the jittered five squares, loose seven circles, two circles ten apart and three triangles. |
| Python reference | **[EST]** The independent Python auto-orientation checks scores without the TypeScript phi. The exporter regenerates contact, tight and tolerance-boundary corpus cases. mpmath uses exact binary inputs, conservative near-pair checks and measured residual digits. See [python/README.md](../python/README.md). |

**[EST]** Further details. The caller-supplied child start is the third argument's `start`, alongside optional eval/time caps; a child uses the shared best when it is omitted. Child runs do not append polish; their evaluations and descendants are included in the parent stage record. Custom registries expose only registered metadata but can resolve builtin polish as a final-stage fallback. The evaluation reserve rounds up to `ceil(evals/10)`, capped after the mandatory start assessment. The pool retains the first 64 valid emissions and still evaluates later emissions; absent emissions preserve the incoming pool. Overall termination retains any stage budget interruption unless error/abort supersedes it. Paused time is excluded when observed by framework calls; wall metadata includes it. The deprecated polish `iterations` alias remains for compatibility, with `maxIterations` taking precedence. Source: `packages/solver/src/framework.ts`, `methods.ts`, `polish.ts`.

## Budgets, stop and determinism

**[EST]** Counts, deadlines and abort state are checked by framework calls and by synchronous `shouldStop`. Candidate failure still counts. Stage and child limits cannot increase overall limits. Ordinary progress has 50 ms spacing, followed by an unconditional final frame. Sources: framework/runtime and tests.

**[CALC]** Deterministic sequential methods with identical inputs, params, uint32 seed and evals-only budget reproduce optimization outputs in the same runtime. Actual wall time and trace timestamps do not reproduce bits. Time budgets cannot reproduce bits because machine load and scheduling affect completed work. A synchronous geometry call and the free final orientation scan can overrun a deadline; no portable same-thread mechanism can preempt them, so universal one-second cancellation is not claimed. Tested cooperative P=30 abort and paused-abort response is below one second; a 150 ms time budget finished at approximately 151 ms.

## Float64 polish measurements

**[CALC]** Float64 polish uses contact residuals, sparse finite-difference derivatives, a nonnegative dual SQP projection, scaled trust bounds, backtracking and penetration restoration. An active-equality Newton finish corrects final residuals. Intermediate assessments use fixed phi; the final score uses auto-orientation. Strict pair separation and scored-container protrusion limits are `-1e-12`/`1e-12`, with positive restoration margins. It makes no global-optimum guarantee. Sources: [polish method](methods/polish.md), implementation and numerical tests.

**[CALC]** Local Node v26.5.0 run, `node --import tsx scripts/measure-solver.ts > docs/solver-measurements.json`:

| Start | Final score | Error from known target | Count | First measured run, ms |
|---|---:|---:|---:|---:|
| Five squares, expanded 1.02 | 2.707106781186926 | +3.784e-13 | 361 | 45.204 |
| Five squares, expanded 1.03 and seed-2 jitter | 2.7071067811891862 | +2.639e-12 | 492 | 98.569 |
| Seven circles, expanded 1.02 | 3.000000000000302 | +3.020e-13 | 97 | 10.716 |
| Seven circles, expanded 1.5 | 3.0000000000002305 | +2.305e-13 | 145 | 11.735 |
| Two circles, centres ten apart | 2.0000000000001 | +9.992e-14 | 122 | 1.459 |

All returned configurations validate. The five-square target is `2 + 1/sqrt(2)`; the circle targets are 3 and 2. Three-triangle tests also pass the floor `2 - 1e-11` and strict pair/protrusion checks.

## Framework overhead

| Overhead workload | Direct median ms | Framework median ms | Framework overhead |
|---|---:|---:|---:|
| Five-square polish, expansion 1.03 | 12.902833 | 13.473458 | 4.422% |
| Identity, N4/M4/P30, 1000 evaluations | 73.662292 | 74.686625 | 1.391% |

**[CALC]** These medians use 11 samples in alternating order after four paired warmups. Identity's direct baseline performs the same shared start/final orientation scoring and elapsed-time yields, without candidate parsing/tracking/progress. Framework identity sets `finalPolish:false` to isolate plumbing; polish uses the normal registered path. Both measured overheads are below 25%. They establish these local workloads, not arbitrary shapes or browser performance. One atomic N0/M100/P30 assessment measured 123.794 ms. Source: [solver-measurements.json](solver-measurements.json), `scripts/measure-solver.ts`.

## High-precision measurements

**[CALC]** Python 3.14.6, mpmath 1.3.0, 50 working digits; runtime includes process startup and independent Python float64 validation. Source: [python/measurements.json](../python/measurements.json), `python/.venv/bin/python scripts/measure-python.py`:

| Case | Seconds | TypeScript accepted refinement | Server score | Achieved contact-residual digits |
|---|---:|---|---:|---:|
| Five squares, expanded 1.03 | 2.478 | Yes | 2.7071067811865475 | 43 |
| Seven circles, expanded 1.03 | 0.479 | Yes | 3 | 41 |
| `data/corpus/N6-M0-P10.json` | 98.443 | No: valid-input fallback | 3.8255588437382846 | Not achieved/reported |

Square/circle maximum active residuals were `1.0000022551442983e-44` and `1.0726152134101705e-42`. Residual digits are not certified score digits. The ten-hexagon refinement failed its float64 validity/score acceptance; its high-precision size and residual fields are null. No refinement or precision certificate is claimed for that case.

## Limitations

**[CALC]** Universal hard wall-time limits and cancellation cannot be fully implemented with synchronous geometry and cooperative same-thread methods. Final scoring is uncounted but still costs time. Whole-Result bit reproducibility is impossible for measured timestamps.

**[EST]** Polish caps numerical work at P = 100, 2048 selected contacts, and `contacts × max(N, 1) ≤ 50000`. It retains an already strict valid fallback rather than exceeding these limits. A tolerance-valid start with separation below -1e-12 may have no strict no-worse repair: direct polish then returns undefined, while the framework preserves the tolerance-valid start. No invalid configuration is returned as best. Sources: [polish method](methods/polish.md) and tests.

**[EST]** The ten-hexagon corpus case did not produce an accepted high-precision refinement. Arbitrary-precision working digits are not certified answer digits. Not provided: Cloudflare measurements, a global-optimality proof, universal repair guarantees, YAML pipelines and unsupported JSON Schema features.

## Dependencies

**[EST]** The solver's sole runtime dependency is the local `@polypack/geometry`. Prettier (`printWidth` 120) is a development-only formatter; Vitest and fast-check are the test tools. Optional Python **mpmath>=1.3,<2** is the single high-precision dependency and belongs in a local `python/.venv`; the standard corpus tests need only Python's standard library. Sources: manifests, `python/requirements.txt`.
