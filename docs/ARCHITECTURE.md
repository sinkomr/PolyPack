# PolyPack architecture

Labels used throughout the documentation: **[EST]** established with a source, **[CALC]** computed or derived here, **[SPEC]** speculation.

"Phase 1" in these documents means the board, records, server and shared geometry, including the configuration format they exchange; "Phase 2" means the automated search in `packages/solver`.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One geometry implementation shared by browser and server, so client and server scores cannot drift. |
| Shared geometry | `packages/geometry`, pure TypeScript, no DOM or Node APIs | Runs unchanged in the browser, in Node and in a Cloudflare Worker. Pure functions, ready for the optimizers in `packages/solver`. |
| Frontend | Vite + plain TypeScript + Canvas 2D (`apps/web`) | No UI framework to learn or upgrade. Canvas keeps dragging smooth at P = 100. |
| Backend | Hono (`apps/server`) | The same route code runs on Node, Cloudflare Workers and other runtimes, so the hosting choice stays open. |
| Database | SQLite behind a small `Store` interface | Locally: Node's built-in `node:sqlite`, no native build. Hosted: the same SQL runs on Cloudflare D1, or on a disk volume at Fly.io. |
| Live updates | Server-sent events, with 10 s polling as fallback | SSE needs no extra library. Polling covers hosts where a long-lived connection is not available. |
| Tests | Vitest + fast-check (unit, property), Playwright (end to end) | |
| CI | GitHub Actions, typecheck and tests on every push | |

Repo layout: npm workspaces. `packages/geometry` is consumed as TypeScript source by both apps; there is no build step for it.

## Hosting

Fly.io is set up: see [DEPLOY_FLY.md](DEPLOY_FLY.md). An always-on Mac behind a tunnel is the alternative: see [HOSTING.md](HOSTING.md). The comparison below was read from the providers' documentation on 2026-10-07.

| Option | Monthly cost | What it needs | Fit |
|---|---|---|---|
| Fly.io: one small machine with a 1 GB volume | [EST] $2.19 (shared-cpu-1x, 256 MB, running all month) + $0.15 per GB of volume, so about $2.34. No free tier; card required. Source: https://docs.fly.io/about/pricing | Fly.io account with a card, the repository's `Dockerfile` and `fly.toml`. | Runs the tested Node server unchanged: SQLite on the volume, server-sent events, no CPU limit. |
| Cloudflare Workers + D1 | [EST] $0 on the free plan: 100,000 requests per day, 10 ms CPU per request, D1 with 5 GB and 100,000 rows written per day. Paid plan from $5. Sources: https://developers.cloudflare.com/workers/platform/pricing/ and https://developers.cloudflare.com/workers/platform/limits/ | Cloudflare account (no card), plus new code: a D1 store, a Worker entry and a wrangler config. | Live updates fall back to 10 s polling unless a Durable Object is added. [CALC] Scoring a submission takes 0.1 to 2 ms on an Apple Silicon Mac for M up to 20, but about 120 ms for M = 100, which is over the free CPU limit; large M would need a faster solver or a cap. |
| Render free web service | [EST] $0, but it spins down after 15 minutes without traffic and has no persistent disk. Source: https://render.com/docs/free . Paid prices were not checked. | Render account, plus a hosted Postgres and a Postgres store to keep the leaderboard. | Poor: the leaderboard would not persist without extra services. |
| GitHub Pages | $0 | [EST] On GitHub Free the repository must be public. Source: https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site | Static files only, so no submissions, leaderboard or live updates. Not enough by itself. |

## Conventions

These are fixed. Every computation, stored record and API payload uses them. They are implemented in `packages/geometry/src/shapes.ts`.

**Problem.** A problem is (N, M, P): P congruent pieces with N sides in a container with M sides. N = 0 denotes circle pieces and M = 0 a circle container; otherwise N and M are at least 3. P is a positive integer.

**Units.** Polygon pieces have side length 1. Circle pieces have radius 1. Angles are radians internally, in storage and in the API; the UI shows degrees.

**Piece pose** (x, y, θ). For an N-gon the circumradius is R = 1 / (2 sin(π/N)), and vertex k = 0..N−1 is at

    (x, y) + R·(cos(θ + π/2 + 2πk/N), sin(θ + π/2 + 2πk/N))

So at θ = 0 the piece has a vertex pointing straight up (+y). A circle piece ignores θ.

**Container.** A regular M-gon with centre (cx, cy), orientation φ and side length s. Vertex k = 0..M−1 is at

    (cx, cy) + (s / (2 sin(π/M)))·(cos(φ − π/2 + π/M + 2πk/M), sin(φ − π/2 + π/M + 2πk/M))

So at φ = 0 the container has a horizontal bottom edge. A circle container is given by its centre and radius r.

**Score.** The container side length s for a polygon container; the radius r for a circle container. Smaller is better. Scores are stored at full double precision and displayed with six decimals.

**Validity.** Pieces may touch, but their interiors must not overlap. Every piece lies inside the closed container. The server's validation is authoritative.

**Literature values.** Published sources differ (radius or diameter, side or circumradius). Every imported value is converted to these conventions and the conversion note is stored with the record; see [RECORDS.md](RECORDS.md).

## Geometry model

- **Pieces are fixed in world coordinates; the container rotates.** The container orientation φ is part of the configuration. Rotating the whole arrangement by −φ is equivalent, but storing φ keeps piece coordinates stable while the user searches over orientations.
- **Tolerance.** `TOL = 1e-9` in piece units (side or radius 1). Two pieces overlap when their separation is below −TOL. Separation in [−TOL, TOL] counts as touching and is valid.
- **Overlap test.** Separating-axis theorem. For regular polygons the support function is known in closed form, so a pair costs O(N), not O(N²). A vertex-array SAT is kept as the reference and cross-tested.
- **Broad phase.** Uniform grid with cell size 2R (R = circumradius, or 1 for circles); only neighbouring cells are tested.
- **Enclosing M-gon at fixed φ [CALC].** Minimise the apothem a over (cx, cy, a) subject to hⱼ ≤ a + c·uⱼ. Solved exactly through the dual: a* is the maximum of Σλⱼhⱼ over antipodal pairs of normals and over triples of normals that positively span the plane, with λ fixed by the normals alone. No feasibility checks are needed, and for equally spaced normals the weights are a sine table. Then s = 2a·tan(π/M).
- **Enclosing circle.** Welzl's algorithm on the convex hull of the piece vertices. Circle pieces are congruent, so the answer is the enclosing circle of the centres plus 1.
- **Auto-orient.** s(φ) has period 2π/M. Dense uniform sample over one period, then golden-section refinement around the best local minima. The current φ and φ = 0 are always candidates, so the result is never worse than either. This is a search, not a proof of the global minimum over φ.
- **Strict verification.** Shrink every piece by (1 − ε) about its centre, require strictly positive separation and strict containment, and report s / (1 − ε).

## Scoring rule

The server recomputes everything from the submitted poses. It scores at the submitted `container_phi` and at its own auto-oriented φ and keeps the smaller size (decided 2026-10-07).

## Leaderboard rule

Each (N, M, P) keeps one entry, its leader (`KEEP_PER_PROBLEM`, 1 since 2026-10-18, before that 3; a running tally keeps the number received). Every other entry is deleted when it is overtaken or does not lead. The exception is a leader pending review: the best entry that is not pending is kept behind it, so that rejecting the claim restores the previous record. A rejected or removed entry is deleted, so removing a leader that is not pending leaves the problem without a site entry. Pieces are stored as little-endian Float64 triples, 24 bytes per piece, in the `pieces` column. Rows from before 2026-10-18 hold JSON text there, are still read, and are converted and pruned by a background migration in the server (see `docs/DEPLOY_FLY.md`). The leader is the earliest listed entry whose score is within a relative 1e-9 (`SCORE_TIE`) of the smallest listed score. The tolerance has the magnitude of `TOL`, because a smaller difference cannot be told apart from the slack that validity allows; an entry of equal quality therefore never displaces an earlier one, and the response to a submission says whether it leads (`leader`, `leader_score`). Live events are sent only when the leader changes. Entries that beat the literature are shown with a "pending verification" highlight until reviewed on the admin page.

A problem whose published record has status `proven` or `trivial_tiling` is closed (`closedToSubmissions`): the server refuses submissions with HTTP 409 before examining them, and entries stored earlier are no longer listed, so the published packing stands alone. `proven_unrefereed` and `best_known` problems stay open, the first so that a counterexample to an unrefereed proof can still be entered. Rows of closed problems are kept in the database, and their share links keep working.

## How an entry was found

A submission says how its packing was found (`found_with`: `hand`, `optimizer`, `optimizer_edited` or `external`; decided 2026-10-13, replacing the self-declared Human/AI `agent`). Optimizer entries also carry the registered `method`, its resolved `method_params` (at most 4 KB of JSON), `seed` and `budget`, and `external` ones an optional `software` name, so that a result can be reproduced. Only the short `found_with` label is shown and listed; the full record is returned by `GET /api/submissions/{id}`. The free-text `agent_note` is the submitter's own and is never filled in automatically. `parseProvenance` (geometry package) validates the fields; the store adds their columns to an older database when it opens it, and rows stored before have `found_with` null ("not recorded"). The legacy `agent` field is accepted and ignored, except that `agent: "ai"` without `found_with` is stored as not recorded rather than as by hand; the column stays in old databases and new rows store an empty string in it.

On the board the attribution is a function of the board and its lineage (`apps/web/src/found-with.ts`): a board that is exactly an accepted optimizer result is `optimizer`; an edit of such a board, or of an edited one, is `optimizer_edited` with the same run; a load from elsewhere or an empty board is `hand`; undo, redo and a reload return a board to what it was when made. Accepted results and edited boards are kept in local storage (`polypack.solve.accepted`, `polypack.solve.lineage`).

## Limits

N and M: 0 (circle) or 3 to 100. P: 1 to 500. Coordinates: |x|, |y| ≤ 1e6.

## Solver foundation

**[EST]** `packages/solver` (`@polypack/solver`) is consumed as TypeScript source and typechecks without DOM or Node ambient types. All scoring and validity use shared geometry; trials may request fixed orientation, while the final result receives server-equivalent auto-orientation. Source: `packages/solver/src/`, `tsconfig.core.json`.

**[CALC]** Orchestration and float64 contact SQP/Newton stay in TypeScript so they can run unchanged in browser Workers, Node and Cloudflare Workers. A structural runtime adapter supplies performance measurements, MessageChannel yields and fallback timers. Framework methods share budgets, seeded randomness, pause/stop controls and progress; a synchronous geometry operation remains an atomic boundary that cannot be preempted. See [the solver README](../packages/solver/README.md) and [SOLVER_FRAMEWORK.md](SOLVER_FRAMEWORK.md).

**[CALC]** Python is limited to optional mpmath refinement at 50 working digits and an independent standard-library validity/enclosure/orientation reference. Keeping arbitrary precision outside the browser avoids a browser runtime dependency; Python refinements require shared TypeScript acceptance. The independent corpus test includes tight contacts and tolerance-boundary valid/invalid cases nested to preserve the existing server test. Local-venv high-precision measurements succeeded on five squares and seven circles; the actual ten-hexagon corpus run retained its valid input after rejecting refinement. Source: `python/README.md`, `python/measurements.json`.

## Browser solver integration (2026-10-11)

**[EST]** The website consumes `@polypack/solver` in a Vite module Web Worker. Registry metadata supplies the method selector, defaults and settings schemas; type-only imports keep the search implementations out of the main browser bundle. The existing algorithms and final float64 polish run unchanged. Source: `apps/web/src/solve-worker.ts`, `solve-runtime.ts`, `solve-protocol.ts` and `solve-panel.ts`.

**[CALC]** Job IDs and per-worker identity reject stale messages. The worker owns cooperative pause/abort flags and retains the best complete strict progress candidate, with its evaluated container orientation. The main thread renders a read-only preview separately from Board state/history/storage. Acceptance loads a final strict result in one undoable change; changing board configuration cancels outstanding jobs. Stop requests terminate an unresponsive worker after one second, retaining only its last received strict preview and labeling that fallback separately from a completed Result.

**[EST]** Scalar and nested method settings come from schemas, with numeric angular settings converted to degrees for display and back to radians when changed. Untouched fields remain omitted to preserve exact library defaults. Optional configuration JSON keeps storage radians. Run downloads contain the original request/start, seed, budget, resolved Result parameters, best configuration and trace. Source: `solve-params.ts` and `solve-panel.ts`.

The seven optimizers, the seed generators and contact polish are available on the website. Population/LLM search, CLI and HTTP solver jobs remain later build work. Python arbitrary-precision polish is still optional and is not invoked by the browser.
