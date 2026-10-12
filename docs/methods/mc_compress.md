# Monte Carlo compression (`mc_compress`)

[CALC] Hard particles settle inside an explicit container with centre `(cx, cy)`,
size and orientation `phi`. Polygon pieces have side one; circles have radius
one. The score is container side length for polygons and radius for circles.
The implementation is registered in `packages/solver/src/index.ts`; its schema
and defaults are exported as `mcCompressMethod` in
`packages/solver/src/methods/mc_compress.ts`.

```ts
const result = await run(
  { N: 0, M: 0, P: 19 },
  {
    method: "mc_compress",
    budget: { evals: 3000 },
    seed: 1,
    // Omit params for greedy compression; these enable annealing.
    params: { initialTemperature: 0.02, coolingRate: 0.9995 },
  },
);
```

## Moves and validity

[CALC] One sweep attempts exactly P single-piece moves, selecting indices
uniformly with replacement. Circles translate. Polygon proposals choose
translation or rotation with probability one half each, permitting independent
acceptance measurements. Translation draws each displacement coordinate
uniformly in `[-translationStep, translationStep]`; rotation draws an angle in
`[-rotationStep, rotationStep]`. Every valid piece proposal is accepted, because
the explicit container does not change and its energy change is zero.

[EST] Shared `pieceSeparation` supplies circle distances and polygon SAT;
the server's overlap tolerance is `TOL=1e-9` in piece units.
`visitContainerProtrusions` supplies containment, using support constraints for
polygon walls and every polygon vertex for circular walls. Sources: geometry
`overlap.ts` and `penalty.ts`.

[CALC] This method requires pair separation >=0 and protrusion <=0, at every
temperature. Every `findOverlaps` call passes an explicit zero tolerance.
Initial bisection retains the strictly non-overlapping side. Tiny negative seed
contacts from arithmetic are expanded before entering the chain. Shared tight
enclosures receive outward room of `2e-13*max(1,size)` in wall distance; the
explicit container, rather than the containment predicate, accounts for it.
Caller-supplied collective containers rounding inward by at most 1e-12 are
enlarged explicitly before feasibility and energy checks. Single-piece moves
never get that correction. No negative separation or positive protrusion is
accepted as free space; returned configurations are checked to -1e-12 slack.

[CALC] The live grid uses cells of width `2*boundingRadius(N)`. A piece can
overlap only a centre within that distance, so only the destination's 3-by-3
cell neighbourhood needs shared separation tests. Accepted moves immediately
remove the old cell membership and insert the new one; rejected moves leave
the grid untouched. Long proposals query their destination, with no displacement
assumption. Collective replacements rebuild the grid. For fixed N, the positive
piece inradius bounds cell population in a valid packing, giving O(1) neighbours
per single-piece move rather than scanning all P pieces. Collective compression,
enclosure and framework assessments still scan the configuration.

[CALC] Compression attempts uniformly contract piece centres toward the explicit
container centre by `1-shrinkFraction`, then compute their smallest enclosure
at the current phi. Separate attempts shrink the fixed container and re-centre
it to the exact shared enclosure with pieces held fixed. Only geometrically
feasible replacements are considered. Polygon orientation trials re-enclose
fixed pieces at a random phi: 90% are local uniform perturbations; 10% sample
the complete symmetry period `[0,2*pi/M)`. Pieces do not rotate with the container.

[CALC] A complete, non-overlapping supplied start is used directly. Without one,
`ctx.run("seed", {kind:"auto"}, {evals:slice})` gets a small shared-budget slice.
Use its `found` configuration, falling back to its shared `best` only when
`found` is absent. Incomplete/overlapping supplied starts are replaced through
seeding, rather than treated as hard-particle states. No custom scatter or
optimizer is substituted when seeding is unavailable.

[CALC] A seed sub-run inherits and reassesses a supplied start. Such starts now
receive a slice of at least three child assessments, clipped by the remaining
budget, rather than spending a one-assessment slice on the invalid start alone.
With only two assessments remaining, the first candidate can still be scored.
The independent review's overlapping-start budgets of 3, 6 and 12 all return valid results
with `finalPolish:false`; automatic polish still reserves part of tiny budgets.

[CALC] Subtracting the bounding-box midpoint preserves translation invariance
and keeps even highly skewed coordinate-limit starts within the parser bounds.
The initial container has fractional free room, without altering the scored
fallback. Before diffusion, a valid supplied start gets one aggressive uniform
centre contraction: 40 bisections retain the non-overlapping side, then shared
enclosure and containment validate acceptance. For fixed centre rays and fixed
orientations, pair overlap is monotone in the scale because the convex
Minkowski difference contains the origin. This preserves a loose start's contact
topology, retaining the requested fractional container room after contraction.
Both supplied and generated starts get `warmupSweeps` without any container
compression or orientation changes, so `initialExpansion` lasts beyond sweep 2.
The default is five sweeps: enough for diffusion before compression without a
long initialization delay. A regression test holds room for 30 sweeps.
Initialization slack is not an accepted MC step.

## Energy, acceptance and adaptation

[CALC] The energy is precisely

```text
E(config, container) = container.size   if feasible
                    = +infinity       otherwise
```

[CALC] Size uses PolyPack's score units, without area, density, overlap penalty
or temperature-dependent scaling. Feasibility is a hard constraint at every
temperature. A feasible container proposal with energy difference `delta`
is accepted when `delta <= 0`; if `delta > 0` and `T > 0`, it is accepted with
probability `exp(-delta/T)`. At T=0, every accepted step keeps or decreases the
explicit container size. A positive-temperature run additionally proposes a
container-only expansion by `1+shrinkFraction` with probability 0.1 at each
compression interval. Expansions and uphill orientation moves use this rule.
Contractions remain downhill proposals. The best valid assessment is retained
separately, so annealing cannot worsen the returned best.

[CALC] Sweep k within a chain uses `T(k)=initialTemperature*coolingRate^k`, starting at k=0;
cooling occurs after each sweep. These adaptive, directed shrink and tight-enclosure
proposals form an optimization heuristic. The method does not claim canonical
NPT sampling, detailed balance, or the equilibrium guarantees of a symmetric
Metropolis chain; it includes no proposal/Jacobian correction for box moves.

[CALC] Translation, rotation and centre-contraction acceptance rates are measured
independently over `adaptationSweeps`. Each corresponding step is multiplied by
`exp(adaptationGain*(rate-targetAcceptance))`. A rate above target increases
step size; a rate below target decreases it. Adapted steps are bounded below
by `1e-7` and above by `2R`, `pi/N` and `0.05` respectively. Parameter minima
also enforce the floor when adaptation is disabled. Rotation adaptation
is skipped for circles. The contraction rate excludes guaranteed feasible
tight-enclosure/recentering attempts and thermal expansions. Zero gain preserves
the supplied step sizes exactly, including values above those adaptive caps.
These are empirical controllers, not guarantees that a changing jammed packing
can attain the target.

## Stagnation and optional restarts

[CALC] Count consecutive method assessments without either a best improvement
or an accepted container decrease of more than `1e-9*max(1,previous size)`.
This comparison keeps a few rounding ulps from resetting progress. After
`stagnationEvals` (default 500), return early when no restarts remain. Zero
disables detection. Heartbeat assessments still occur at the fixed sweep
interval; stopping depends on counts, not clock readings.

[CALC] `maxRestarts` defaults to zero. When positive, stagnation starts a new
chain by expanding all centres and the container about the container centre by
`restartExpansion` (default 1.15). Validate the new state strictly, rebuild the
grid, reset proposal sizes and acceptance counters, preserve free room for
`warmupSweeps`, and reheat to `initialTemperature` if positive. The expansion is
a restart initialization, not an uphill MC acceptance; accepted steps within
each zero-temperature chain remain nonincreasing. The separately scored best
never worsens. No seed sub-runs or polish calls occur at restarts.

## Parameters and defaults

[CALC] The registered JSON Schema is an object with `additionalProperties:false`;
all entries below have `title`, `description` and `default`. Types and inclusive
ranges are listed. No parameter is required because the framework fills defaults.

| Parameter             | Type / range       | Default | Meaning                                                                                                                                       |
| --------------------- | ------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `translationStep`     | number, 1e-7–100   | 0.15    | Translation proposal half-width per coordinate.                                                                                               |
| `rotationStep`        | number, 1e-7–pi    | 0.15    | Polygon rotation half-width in radians.                                                                                                       |
| `shrinkFraction`      | number, 1e-7–0.5   | 0.01    | Fractional centre contraction and wall shrink.                                                                                                |
| `targetAcceptance`    | number, 0.01–0.99  | 0.3     | Separate target for translations, rotations and contractions.                                                                                 |
| `adaptationGain`      | number, 0–10       | 1       | Multiplicative controller gain; zero disables it.                                                                                             |
| `adaptationSweeps`    | integer, 1–10000   | 20      | Acceptance measurement and adaptation interval.                                                                                               |
| `sweepsPerEvaluation` | integer, 1–1000    | 10      | Fixed scoring interval, in addition to best-improving shrink assessments.                                                                     |
| `shrinkEvery`         | integer, 1–1000    | 2       | Compression interval in sweeps.                                                                                                               |
| `orientEvery`         | integer, 1–1000    | 10      | Polygon-container phi proposal interval.                                                                                                      |
| `containerRotation`   | number, 0–pi       | 0.1     | Local phi proposal half-width; 10% of trials remain global.                                                                                   |
| `initialExpansion`    | number, 0–1        | 0.05    | Initial explicit-container free room fraction.                                                                                                |
| `warmupSweeps`        | integer, 0–1000    | 5       | Sweeps without container changes initially and after a restart.                                                                               |
| `stagnationEvals`     | integer, 0–1000000 | 500     | Assessments without progress before stopping or restarting; zero disables.                                                                    |
| `maxRestarts`         | integer, 0–100     | 0       | Maximum expansion restarts; zero returns early.                                                                                               |
| `restartExpansion`    | number, 1–2        | 1.15    | Centre and container expansion factor at a restart.                                                                                           |
| `seedEvals`           | integer, 1–256     | 24      | Seed cap clipped to 10% of remaining assessments; supplied invalid starts get at least three child assessments, subject to the parent budget. |
| `initialTemperature`  | number, 0–100      | 0       | Temperature in size units; zero selects greedy compression.                                                                                   |
| `coolingRate`         | number, 0–1        | 0.9995  | Geometric multiplier per sweep.                                                                                                               |

## Budgets, determinism and polish

[CALC] Monte Carlo proposals and geometry feasibility checks do not consume
evaluation units; counted scoring goes only through `ctx.evaluate`. Assessments
use `{autoOrient:false}` at the explicit phi every fixed number of sweeps and
immediately after each accepted container change whose size beats the best
score observed. A last improvement can consume the final evaluation before a
sweep completes. Thus a seed and an evals-only budget determine a fixed,
reproducible sequence of work, although different seeds need different numbers
of sweeps. Wall-time metadata is not deterministic.

[CALC] Each sweep and assessment awaits a checkpoint, and every attempted move
checks `shouldStop`. This lets timer aborts and pause/resume reach the hot loop
even with a large scoring interval. Shared geometry calls are synchronous atomic
operations. Tests establish the requested time and abort response at P<=30;
there is no unconditional preemption guarantee for arbitrary large shapes or
slow callbacks.

[EST] The framework appends its registered contact polish automatically, reserves
10% of the overall budget, and performs a final uncounted auto-orientation
assessment. Polish can converge before spending its reserve, so a 3000-evaluation
limit need not yield 3000 evaluations used. With `finalPolish:false`, search
spends the available assessments unless stagnation stops it first. To spend an
evals budget exactly regardless of stagnation, set `stagnationEvals:0`.
Sources: solver `framework.ts`, `methods.ts`.
This method does not call polish itself.

[EST] The current automatically appended polish is float64 SQP/Newton, not the
optional 50-digit mpmath stage. Adding automatic high-precision polish would
require changes to the framework/runtime. The Python facilities under
`python/` are separate; this method
makes no high-precision certification claim.

## Measured results (Node, local Mac)

[CALC] Re-measured after the strict-feasibility and stagnation fixes on 2026-10-09,
Node v26.5.0, seeds 1–5, no supplied start, evals-only limits of 3000,
all defaults and automatic final polish. Each row aggregates five runs.
All 60 default/thermal results were valid and had nonnegative minimum pair
separation. Sizes are rounded to nine decimals; the per-seed tables place
separation next to each score. These measurements supersede the earlier tables.

[EST] Published values are copied from `data/records.json`, including truncated
pentagon and hexagon displays. Sources: [squares](https://kingbird.myphotos.cc/packing/squares_in_squares.html),
[circles](https://erich-friedman.github.io/packing/cirincir/),
[pentagons](https://erich-friedman.github.io/packing/peninpen/), and
[hexagons](https://erich-friedman.github.io/packing/hexinhex/).

| Problem                 |         Published |        Best |      Median |       Worst | Smallest pair separation | Evals used, range | Mean time, s |
| ----------------------- | ----------------: | ----------: | ----------: | ----------: | -----------------------: | ----------------- | -----------: |
| Squares/square, P=5     |  2.70710678118654 | 2.828427125 | 2.828427125 | 2.828427125 |                1.776e-15 | 613–2658          |        0.267 |
| Squares/square, P=10    |  3.70710678118654 | 4.000000000 | 4.000000000 | 4.000000000 |                1.712e-13 | 820–2789          |        0.621 |
| Circles/circle, P=7     |                 3 | 3.000000000 | 3.000000000 | 3.000000000 |                1.985e-13 | 744–826           |        0.068 |
| Circles/circle, P=19    | 4.863703305156274 | 4.863703305 | 4.863703305 | 4.863703305 |                1.816e-13 | 835–910           |        0.204 |
| Pentagons/pentagon, P=6 |          2.61803+ | 2.618033991 | 2.618033994 | 2.618034179 |                2.000e-13 | 3000–3000         |        0.551 |
| Hexagons/hexagon, P=7   |            2.886+ | 2.886751346 | 2.886751346 | 2.886751346 |                1.990e-13 | 614–2790          |        0.492 |

| Problem                 | Seed |       Score | Minimum pair separation | Evals used | Wall time, s |
| ----------------------- | ---: | ----------: | ----------------------: | ---------: | -----------: |
| Squares/square, P=5     |    1 | 2.828427125 |               1.916e-13 |        613 |        0.132 |
| Squares/square, P=5     |    2 | 2.828427125 |               1.776e-15 |       2658 |        0.480 |
| Squares/square, P=5     |    3 | 2.828427125 |               1.776e-15 |       1659 |        0.284 |
| Squares/square, P=5     |    4 | 2.828427125 |               1.776e-15 |       1969 |        0.341 |
| Squares/square, P=5     |    5 | 2.828427125 |               1.910e-13 |        613 |        0.096 |
| Squares/square, P=10    |    1 | 4.000000000 |               1.712e-13 |        820 |        0.309 |
| Squares/square, P=10    |    2 | 4.000000000 |               1.712e-13 |       2789 |        1.093 |
| Squares/square, P=10    |    3 | 4.000000000 |               1.712e-13 |       1658 |        0.670 |
| Squares/square, P=10    |    4 | 4.000000000 |               1.712e-13 |        855 |        0.310 |
| Squares/square, P=10    |    5 | 4.000000000 |               1.712e-13 |       1869 |        0.725 |
| Circles/circle, P=7     |    1 | 3.000000000 |               1.985e-13 |        785 |        0.073 |
| Circles/circle, P=7     |    2 | 3.000000000 |               1.985e-13 |        783 |        0.069 |
| Circles/circle, P=7     |    3 | 3.000000000 |               1.985e-13 |        826 |        0.073 |
| Circles/circle, P=7     |    4 | 3.000000000 |               1.985e-13 |        744 |        0.064 |
| Circles/circle, P=7     |    5 | 3.000000000 |               1.985e-13 |        749 |        0.063 |
| Circles/circle, P=19    |    1 | 4.863703305 |               1.816e-13 |        910 |        0.213 |
| Circles/circle, P=19    |    2 | 4.863703305 |               1.816e-13 |        835 |        0.192 |
| Circles/circle, P=19    |    3 | 4.863703305 |               1.816e-13 |        894 |        0.202 |
| Circles/circle, P=19    |    4 | 4.863703305 |               1.816e-13 |        910 |        0.212 |
| Circles/circle, P=19    |    5 | 4.863703305 |               1.816e-13 |        903 |        0.200 |
| Pentagons/pentagon, P=6 |    1 | 2.618033991 |               2.329e-10 |       3000 |        0.630 |
| Pentagons/pentagon, P=6 |    2 | 2.618033996 |                1.066e-9 |       3000 |        0.476 |
| Pentagons/pentagon, P=6 |    3 | 2.618034179 |               2.000e-13 |       3000 |        0.685 |
| Pentagons/pentagon, P=6 |    4 | 2.618033994 |               2.162e-10 |       3000 |        0.479 |
| Pentagons/pentagon, P=6 |    5 | 2.618033994 |               6.119e-10 |       3000 |        0.487 |
| Hexagons/hexagon, P=7   |    1 | 2.886751346 |               1.990e-13 |        857 |        0.296 |
| Hexagons/hexagon, P=7   |    2 | 2.886751346 |               1.990e-13 |       1263 |        0.438 |
| Hexagons/hexagon, P=7   |    3 | 2.886751346 |               1.990e-13 |        614 |        0.184 |
| Hexagons/hexagon, P=7   |    4 | 2.886751346 |               1.990e-13 |       1395 |        0.501 |
| Hexagons/hexagon, P=7   |    5 | 2.886751346 |               1.990e-13 |       2790 |        1.039 |

[CALC] Same protocol with `initialTemperature=0.02` and
`coolingRate=0.9995`; all other parameters remain defaults.

| Problem                 |         Published |        Best |      Median |       Worst | Smallest pair separation | Evals used, range | Mean time, s |
| ----------------------- | ----------------: | ----------: | ----------: | ----------: | -----------------------: | ----------------- | -----------: |
| Squares/square, P=5     |  2.70710678118654 | 2.828427125 | 2.828427125 | 2.828427125 |                1.776e-15 | 2789–2838         |        0.498 |
| Squares/square, P=10    |  3.70710678118654 | 4.000000000 | 4.000000000 | 4.000000000 |                1.712e-13 | 2789–2789         |        1.112 |
| Circles/circle, P=7     |                 3 | 3.000000000 | 3.000000000 | 3.000000000 |                1.985e-13 | 2789–2789         |        0.294 |
| Circles/circle, P=19    | 4.863703305156274 | 4.863703305 | 4.863703305 | 4.863703305 |                1.816e-13 | 2794–2794         |        0.766 |
| Pentagons/pentagon, P=6 |          2.61803+ | 2.618034014 | 2.618034047 | 2.618034638 |                1.997e-13 | 3000–3000         |        0.625 |
| Hexagons/hexagon, P=7   |            2.886+ | 2.886751346 | 2.886751346 | 2.886751346 |                1.990e-13 | 2790–2790         |        1.048 |

| Problem                 | Seed |       Score | Minimum pair separation | Evals used | Wall time, s |
| ----------------------- | ---: | ----------: | ----------------------: | ---------: | -----------: |
| Squares/square, P=5     |    1 | 2.828427125 |               1.916e-13 |       2789 |        0.509 |
| Squares/square, P=5     |    2 | 2.828427125 |               1.776e-15 |       2838 |        0.503 |
| Squares/square, P=5     |    3 | 2.828427125 |               1.776e-15 |       2838 |        0.493 |
| Squares/square, P=5     |    4 | 2.828427125 |               1.776e-15 |       2838 |        0.485 |
| Squares/square, P=5     |    5 | 2.828427125 |               1.910e-13 |       2789 |        0.500 |
| Squares/square, P=10    |    1 | 4.000000000 |               1.712e-13 |       2789 |        1.100 |
| Squares/square, P=10    |    2 | 4.000000000 |               1.712e-13 |       2789 |        1.123 |
| Squares/square, P=10    |    3 | 4.000000000 |               1.712e-13 |       2789 |        1.125 |
| Squares/square, P=10    |    4 | 4.000000000 |               1.712e-13 |       2789 |        1.107 |
| Squares/square, P=10    |    5 | 4.000000000 |               1.712e-13 |       2789 |        1.106 |
| Circles/circle, P=7     |    1 | 3.000000000 |               1.985e-13 |       2789 |        0.296 |
| Circles/circle, P=7     |    2 | 3.000000000 |               1.985e-13 |       2789 |        0.298 |
| Circles/circle, P=7     |    3 | 3.000000000 |               1.985e-13 |       2789 |        0.292 |
| Circles/circle, P=7     |    4 | 3.000000000 |               1.985e-13 |       2789 |        0.290 |
| Circles/circle, P=7     |    5 | 3.000000000 |               1.985e-13 |       2789 |        0.292 |
| Circles/circle, P=19    |    1 | 4.863703305 |               1.816e-13 |       2794 |        0.762 |
| Circles/circle, P=19    |    2 | 4.863703305 |               1.816e-13 |       2794 |        0.765 |
| Circles/circle, P=19    |    3 | 4.863703305 |               1.816e-13 |       2794 |        0.766 |
| Circles/circle, P=19    |    4 | 4.863703305 |               1.816e-13 |       2794 |        0.774 |
| Circles/circle, P=19    |    5 | 4.863703305 |               1.816e-13 |       2794 |        0.761 |
| Pentagons/pentagon, P=6 |    1 | 2.618034026 |                5.528e-9 |       3000 |        0.633 |
| Pentagons/pentagon, P=6 |    2 | 2.618034313 |               1.997e-13 |       3000 |        0.561 |
| Pentagons/pentagon, P=6 |    3 | 2.618034047 |               1.998e-13 |       3000 |        0.424 |
| Pentagons/pentagon, P=6 |    4 | 2.618034638 |                5.199e-8 |       3000 |        0.795 |
| Pentagons/pentagon, P=6 |    5 | 2.618034014 |                2.088e-9 |       3000 |        0.714 |
| Hexagons/hexagon, P=7   |    1 | 2.886751346 |               1.990e-13 |       2790 |        1.041 |
| Hexagons/hexagon, P=7   |    2 | 2.886751346 |               1.990e-13 |       2790 |        1.051 |
| Hexagons/hexagon, P=7   |    3 | 2.886751346 |               1.990e-13 |       2790 |        1.061 |
| Hexagons/hexagon, P=7   |    4 | 2.886751346 |               1.990e-13 |       2790 |        1.046 |
| Hexagons/hexagon, P=7   |    5 | 2.886751346 |               1.990e-13 |       2790 |        1.042 |

[CALC] The seven-circle raw score was 3.0000000000002016, with minimum
pair separation 1.98507876802978e-13 in every default run. The earlier
2.999999999 result was a defect caused by using validity tolerance as free
space. It is corrected; tolerance gains are not acceptable scores. No record
is claimed or submitted, and no interval/high-precision certification was run.

## Scattered starts, stagnation and restarts

[CALC] Construct one fixed scattered start for each problem by dropping pieces
uniformly into a box with half-width 2.5 for five squares, 2.62 for six
pentagons, and 5 for twelve circles. Polygon angles are uniform over a full
turn. A drop is accepted only when shared `findOverlaps(...,-1e-3)` finds no
pair closer than 0.001. Start-generation seeds are 1000+P; MC seeds are 1–5.
Initial scores are 5.0553843130450575, 5.269452296040248 and 6.948315431495213.
The comparison changes only `maxRestarts` from 0 to 5; both use defaults
including `stagnationEvals=500`, `restartExpansion=1.15`, `warmupSweeps=5`,
zero temperature and final polish. Budgets are 3000 and 30000 evaluations.

| Problem                 | Eval limit | Max restarts |        Best |      Median |       Worst | Evals used, range | Mean time, s |
| ----------------------- | ---------: | -----------: | ----------: | ----------: | ----------: | ----------------- | -----------: |
| Squares/square, P=5     |       3000 |            0 | 3.000000000 | 3.000196511 | 3.004426735 | 2594–3000         |        0.410 |
| Squares/square, P=5     |       3000 |            5 | 3.000000000 | 3.000004426 | 3.004426735 | 2810–3000         |        0.411 |
| Squares/square, P=5     |      30000 |            0 | 3.000000000 | 3.000122683 | 3.004421016 | 2594–7305         |        0.690 |
| Squares/square, P=5     |      30000 |            5 | 2.942809236 | 3.000000000 | 3.000122683 | 21646–27513       |        4.161 |
| Pentagons/pentagon, P=6 |       3000 |            0 | 2.618033993 | 2.618033997 | 3.427051063 | 3000–3000         |        0.468 |
| Pentagons/pentagon, P=6 |       3000 |            5 | 2.618033993 | 2.618033998 | 3.427054377 | 3000–3000         |        0.618 |
| Pentagons/pentagon, P=6 |      30000 |            0 | 2.618033989 | 2.618033989 | 3.427051063 | 3092–29864        |        1.689 |
| Pentagons/pentagon, P=6 |      30000 |            5 | 2.618033989 | 2.618033993 | 3.427051063 | 17758–30000       |        5.958 |
| Circles/circle, P=12    |       3000 |            0 | 4.029601937 | 4.029608181 | 4.113622360 | 1541–3000         |        0.336 |
| Circles/circle, P=12    |       3000 |            5 | 4.029601937 | 4.029604657 | 4.029611257 | 3000–3000         |        0.356 |
| Circles/circle, P=12    |      30000 |            0 | 4.029601930 | 4.029601930 | 4.113622360 | 1541–28504        |        2.644 |
| Circles/circle, P=12    |      30000 |            5 | 4.029601930 | 4.029601930 | 4.029601930 | 27589–28504       |        3.249 |

[CALC] At 30000 evaluations, restarts improve two square seeds to about
2.942809 and another to 3.000000, but do not discover the published 2.707107
packing. The square median improves from 3.000123 to 3.000000 at greater cost.
Six pentagons show no median or worst-case benefit; restarts cost more and can
delay polishing of an already good state. For twelve circles, restarts remove
the poor 4.113622 outcome: the worst is 4.029611 at 3000 and 4.029602 at 30000.
These are paired five-seed measurements on one start per problem, not a general
success-rate claim. Every scattered result had pair separation >=-1e-12;
the smallest was -1.388e-14 after shared final polish.

[CALC] Stagnation ends many runs before the cap rather than multiplying runtime
by ten: without restarts, for example, square seed 3 stops at 2594 evaluations
for both budgets, and twelve-circle seed 2 at 1541. Some runs still use most
of the cap while making measurable progress; this rule is not an absolute
runtime reduction guarantee. A unit test pins early exit and two strict,
deterministic restarts from a jammed chain.

## Throughput and adaptation

[CALC] Kernel measurements use P=30, M=N, a loose 6-by-5 centre grid spaced at
2.5R, seed 118, a fixed enclosing container and proposal widths 0.15. After
10000 warm-up attempts, five consecutive batches of 100000 attempts measure
proposal generation, strict containment, grid/SAT checks and membership updates.

[CALC] End-to-end rates count actual single-piece attempts via the method observer
and divide by the returned total wall time. These are five complete no-start
runs per N, seeds 1–5, default parameters, a 3000-evaluation limit and final
polish. They include seed generation, collective container proposals, checkpoints,
assessments and polish. They are different, denser workloads than the loose
kernel grid, so the ratio is not solely framework overhead. Node only; browser
throughput remains unmeasured.

|   N | Median kernel attempts/s | Kernel range    | Median end-to-end attempts/s | End-to-end range |
| --: | -----------------------: | --------------- | ---------------------------: | ---------------- |
|   0 |                1,035,816 | 1021741–1038738 |                      131,319 | 83059–492656     |
|   4 |                  637,946 | 627760–645330   |                      217,634 | 208185–219536    |
|   8 |                  527,428 | 522388–542067   |                       15,063 | 9418–55398       |

[CALC] End-to-end wall times for N=8 were 6.677, 35.830, 12.678, 24.856
and 38.415 seconds. These complete runs include final contact polish; the
combined solver cost was hidden by reporting only a move-kernel rate previously.

[CALC] The fixed-container adaptation experiment remains: P=30 circles, seed 33,
initial translation width 0.0001, target 0.3, gain 1, and 55 batches of 900 moves.
With strict checks, measured acceptance is 0.983333 initially and 0.293444 over
the final ten batches; final width is 1.37818958. The test verifies approach to
target and the new 1e-7 adaptation floor.

[CALC] Loose known-start tests expand centre positions by 30% without altering
pieces' sizes or angles. With a 600-evaluation limit and final polish, seeds
1–5 meet the seven-circle r<=3.0001, five-square s<=2.72, and two-circle
|r−2|<=1e-11 targets. The two-circle test separately forbids scores below
2−1e-12 and checks returned pair separations to -1e-12; it no longer hides the
tolerance defect behind a 1e-8-only comparison.

## Applicability and limitations

[CALC] The measured circle, pentagon and hexagon results benefit from their
strong automatic seeds. Loose, already well-structured starts compress well.
Hard rejection makes every accepted state feasible and is cheap for small
regular pieces. Greedy compression jams and does not reliably discover the
five- or ten-square optimum from the automatic seeds. The tested thermal
schedule does not resolve those square traps. Other schedules may behave
differently, but improvement is unmeasured [SPEC]. Restarts are optional;
there are no cluster moves, topology swaps or penalty-optimizer sub-runs.

[EST] With no valid start, an already-aborted run, zero time, or an evals=1 run
with automatic polish can skip method execution before any seed is assessed.
The framework then returns no best and `valid:false`. An invalid supplied start
can also exhaust a tiny budget before a seed is scored. Guaranteeing a valid
configuration before any runnable budget requires a framework bootstrap change;
the method never fabricates one outside the counted evaluator. Source:
`framework.ts` reserve and pre-execution stop checks. This is an explicit unmet
unconditional validity requirement; ordinary runnable budgets return valid bests.

[CALC] One additional framework limit prevents an unconditional strict-result
guarantee for tolerance-band supplied starts. For two circles at x=-1 and
x=1−5e-10, the mandatory start assessment credits score 1.99999999975 and
separation -5.000000413701855e-10. With `evals:6`, `finalPolish:false`, seed 1,
the framework still returns that start as its shared best (four assessments).
An honest non-overlapping pair cannot beat its credited score, and MethodContext
has no operation to discard a best. The method does not admit it into the MC
chain. A fix would be for framework start/best storage to
reject pair separation below -1e-12 (and apply that policy to child seed
assessments), rather than retaining every shared-TOL-valid assessment.

[CALC] An earlier check exercised 36000 dynamic-grid comparisons against
all-pairs shared separation, with 33677 accepted membership updates and no
mismatches. The test file also checks all pairs and the explicit container at
every evaluation across all six tested piece shapes, long destination jumps,
negative coordinates, collective grid rebuilding, deterministic eval budgets,
zero-temperature monotonicity, time, pause/resume and timer aborts. An
independent review found, and fixes now cover, asymmetric starts at coordinate limits and gain-zero adaptation.

[EST] An independent review supplied a separate 16-test acceptance suite. Its
seven defect tests now pass along with its safety, bookkeeping,
deterministic-budget and P=300 stop tests. Source:
`packages/solver/test/mc_compress.review.test.ts`. The 36000-comparison
check above is not part of that review.

[CALC] Extremely large finite input angles expose inconsistencies between the
shared support, vertex and separation arithmetic because additions smaller
than an angle's floating-point spacing disappear. The parser currently accepts
arbitrary finite angles; a consistent angle-reduction policy would need shared
geometry changes. Tests and measurements here use ordinary radian angles.
Browser throughput and automatic 50-digit polish are not supplied.

## Verification

[CALC] The method's own tests (`packages/solver/test/mc_compress.test.ts`, 14
tests, measured at 6.548 seconds) and the independent acceptance suite (16
tests, 11.800 seconds) run with:

```sh
npx vitest run packages/solver/test/mc_compress.test.ts packages/solver/test/mc_compress.review.test.ts
```

[CALC] Remaining limits, as described above: the already-credited
tolerance-band supplied start, framework bootstrap limits, no automatic
high-precision polish, huge-angle shared arithmetic and no browser
measurements.

## Verified references

- [EST] Nicholas Metropolis, Arianna W. Rosenbluth, Marshall N. Rosenbluth,
  Augusta H. Teller and Edward Teller, **Equation of State Calculations by
  Fast Computing Machines**, _The Journal of Chemical Physics_ **21**,
  1087–1092 (1953), DOI
  [10.1063/1.1699114](https://doi.org/10.1063/1.1699114).
  Verified authors, title, journal, year and pages in the
  [publisher-formatted article PDF](https://bayes.wustl.edu/Manual/Metropolis.pdf)
  on 2026-10-09; its rigid-disk specialization rejects overlapping proposals.
- [EST] S. Kirkpatrick, C. D. Gelatt, Jr. and M. P. Vecchi,
  **Optimization by Simulated Annealing**, _Science_ **220**(4598),
  671–680 (1983), DOI
  [10.1126/science.220.4598.671](https://doi.org/10.1126/science.220.4598.671).
  Verified authors, title, venue, date and pages on the Science publisher page
  on 2026-10-09. This supplies annealing background, not the implementation's
  particular cooling-rate choice.
- [EST] Joshua A. Anderson, M. Eric Irrgang and Sharon C. Glotzer,
  **Scalable Metropolis Monte Carlo for simulation of hard shapes**,
  _Computer Physics Communications_ **204**, 21–30 (2016), DOI
  [10.1016/j.cpc.2016.02.024](https://doi.org/10.1016/j.cpc.2016.02.024).
  Verified author/title metadata on the authors'
  [arXiv page](https://arxiv.org/abs/1509.04692), venue/year/pages on the
  publisher page, and the
  [published PDF archived by NSF](https://par.nsf.gov/servlets/purl/10078946)
  on 2026-10-09. It covers hard disks/polygons and NVT/NPT box moves; it is not
  attributed as a source for this finite regular-container contraction rule.

[CALC] No unverified literature reference is included. These sources establish
the MC/annealing background; the finite-container proposal mixture, initial
bisection and controller are the implementation's own choices.
