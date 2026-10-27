# Lubachevsky–Stillinger style growth (`ls_growth`)

[CALC] Registered portable TypeScript dynamics grow congruent pieces inside a
fixed container. A simulation scale `q` means disc diameter `q` (radius `q/2`), or polygon side
`q`. Assessments divide all centre coordinates and container size by `q`, leaving
unit pieces. Scores are the diameter for circle containers and side for polygon
containers. The shared framework appends its contact polish; this method never
calls polish itself.

```ts
const result = await run({ N: 0, M: 0, P: 19 }, { method: "ls_growth", budget: { evals: 3000 }, seed: 1 });
```

## Disc dynamics

[CALC] Centres move ballistically between exact collision events. The pair
equation is `|d+vt|² = (2q+2gt)²`; the first entering quadratic root is selected
using cancellation-resistant roots. Polygon wall events solve the linear
equation `p(t)·n+q(t)=apothem`. Circular walls use the first exiting root of
`|p+vt|²=(R-q-gt)²`. Touching inward-moving particles select a later contact;
curved-wall tangency is an immediate event with a microscopic piece shrink,
because a zero normal impulse cannot resolve outward second-order motion.

[CALC] For equal masses, let `u=(va-vb)·n`, with `n` from b to a. The impulse
adds `(2g-u)n` to a and subtracts it from b. Hence `u_after=4g-u`, so surface
relative velocity `u-2g` reverses. Momentum is conserved; translational energy is
conserved when `g=0`. An outward wall normal reflects `v·n+g`. Growth injects
energy, so the thermostat restores initial translational kinetic energy when
its configured factor is exceeded, leaving growth constant.

[CALC] A binary heap orders events, breaking ties by piece and wall index. The
queue is rebuilt after each impulse and each event-free horizon. For horizon
`h=0.2q/(vmax+g)`, a collision partner must initially be within
`2q+2(vmax+g)h`; a cell grid of that width gives a rigorous local candidate list.
Rebuilding avoids stale events and invalid neighbour bounds after growth-driven
velocity changes. This is genuine event-driven dynamics, but it updates every
centre and rebuilds the queue rather than using the more efficient asynchronous
partial updates of the literature. There is therefore O(P) maintenance per
operation even with bounded-density local searches.

## Polygon approximation

[CALC] Polygon steps advance centres, angles and size together. The maximum
step is reduced so the largest translational-plus-angular-plus-growth surface
speed advances at most `0.025qR`, where R is the unit circumradius (1/2 for disks). Four samples
within a step detect overlap with the shared zero-tolerance SAT function and
containment constraints. On detecting a contact, 40 bisections keep the feasible
side, then the constraints at the final infeasible endpoint identify the
collision. A pair receives an equal-mass central impulse along the shared SAT
normal; a wall reflects its outward normal speed. The growth correction uses
the bounding radius, a conservative overestimate of the polygon support speed.

[CALC] Angular velocities reverse for the involved pieces. There is no
contact-point torque, moment-of-inertia model, angular-momentum conservation,
or energy exchange between rotation and translation. Without growth, central
pair impulses conserve translational energy and momentum; angular reflection
also preserves each angular speed magnitude. Four temporal samples are **not
continuous collision detection**: a sufficiently brief grazing rotational
overlap between samples can be missed. Evaluated endpoints remain strictly
non-overlapping. This implementation is a packing heuristic, not a physically
faithful nonspherical molecular-dynamics implementation.

## Starts, acceptance, stopping and limitations

[CALC] A complete supplied start takes precedence. Invalid starts receive shared
pair restoration, falling back to bounded random sequential placement. Random
placement rejects overlapping or protruding unit pieces inside a roomy fixed
enclosure, with at most 256 trials per piece; failure falls back to the existing
loose jittered-grid generator. `initialization:"seed"` instead calls
`ctx.run("seed", {kind:"auto"})` with at least three evaluations when the parent
budget permits. The method uses the child's `found`, then its shared `best`.
When no start is supplied, or the supplied start is invalid even within the
validity tolerance, a jitter-free grid (`scatter` with every draw 0.5; no seeded
draw) insures the run: under a time-only budget it is assessed first; under a
combined evaluation and time budget only if repair or placement is still
running in the last 25 ms of the method's time allowance (half of an allowance
under 50 ms), after which growth continues from the grid. That branch reads the
clock; a combined run that never enters the reserve equals the evaluation-only
run. A supplied start that is valid within tolerance but has a zero-tolerance
overlap skips the grid under every budget: its mandatory framework assessment
already guarantees a returned configuration, so its repair keeps the whole time
allowance and a tighter start is never exchanged for the looser grid. Under an
evaluation-only budget the grid is never assessed, so a stop during start
preparation returns no configuration.

[CALC] The first simulation uniformly shrinks piece sizes by `initialShrink`.
Restarts shrink the current best by `restartShrink` and draw fresh velocities.
All random choices use `ctx.random`. All score assessments use `ctx.evaluate`
with `{autoOrient:false}`. Exact pose signatures suppress duplicate counted
method assessments; a supplied start's mandatory framework assessment is reused.
Under any evaluation budget the signature set is exact; with unlimited
evaluations only the most recently added max(256, ceil(2^18/P)) signatures are
kept (about 20 MB), and an evicted state that recurs is assessed again.
No local numerical solve is run on an already evaluated state. Bests are
retained separately from simulation states, so valid starts cannot worsen.

[CALC] Every submitted state has nonnegative pair separation, with explicit
`findOverlaps(..., 0)` checks. Both scaled and unit-coordinate contacts are
checked because rescaling itself can round a contact inward. Positive wall
depth is rejected. Roundoff violations trigger uniform piece shrink in fractions
from 2e-14 through 2e-9; larger violations end the run and retain the valid best.
Jamming counts fractional growth since the previous collision, including
event-free horizons. A run ends after a full jamming window, a stagnation window,
its evaluation slice or cancellation. Remaining runs perturb velocities and
decompress. Early convergence does not deliberately exhaust an evaluation cap.
Checkpoints follow counted work, not the clock: one is taken once at least 2048
weighted piece visits have accumulated, tested between placement trials, before
each disc event and after each feasibility probe inside a polygon step, plus one
at entry and before each run. Pair restoration of an invalid supplied start
polls stop but has no checkpoint: at P=500 a coincident supplied start spends
about 185 ms (discs) to 499 ms (squares) inside that restoration without a
checkpoint (independently measured on Apple Silicon under load).
Hot-loop stop checks allow cooperative timer cancellation. The framework's final uncounted enclosure scan remains an
atomic synchronous operation.

[CALC] Tiny or already-aborted budgets can prevent any method execution without
a valid supplied start; the framework can then return no configuration. A
tolerance-only start with only its mandatory evaluation cannot be repaired.
These are framework behaviours, not part of this method.
The common final polish is float64 here; the separate Python high-precision
stage described by the repository is not automatically invoked by this method.

[SPEC] Disc growth is useful for rearranging loose random configurations and
generating dense candidate contact graphs. Slow growth permits more collisions
before compression and tends toward ordered dense structures; fast growth can
freeze disordered structures sooner. A finite evaluation cap also limits how
much growth a slow run completes, so slower is not necessarily better at equal
budget. Polygon angular reflection can jam prematurely, particularly when
simultaneous contacts require torque-mediated rearrangement. The measurements
below test these choices over twenty seeds rather than choosing defaults from
a few favourable trials. Defaults are an initial general-purpose setting, not
a demonstrated globally optimal schedule.

## Parameters and JSON Schema

[CALC] Defaults: `initialization="random"`, `growthRate=0.01`, `initialSpeed=1`,
`angularSpeed=0.3`, `initialShrink=0.2`, `restartShrink=0.05`, `runs=4`,
`jamThreshold=1e-8`, `jamWindow=32`, `energyFactor=4`, `evaluationInterval=16`,
`stagnationEvaluations=128`, `maxStep=0.02`, `seedEvals=8`. The registered schema
below gives bounds and a title and description on every node.

```json
{
  "type": "object",
  "title": "Lubachevsky–Stillinger style growth",
  "description": "Ballistic growing discs with exact collision events, or approximate rotating polygon dynamics, in a fixed container.",
  "additionalProperties": false,
  "properties": {
    "initialization": {
      "type": "string",
      "title": "Initial arrangement",
      "description": "Random sequential loose placement is classical; seed requests a small automatic generator slice. Supplied starts take precedence.",
      "enum": ["random", "seed"],
      "default": "random"
    },
    "growthRate": {
      "type": "number",
      "title": "Growth rate",
      "description": "Constant side/diameter increase per simulation time. Slow growth permits more rearrangement; fast growth generally jams sooner.",
      "default": 0.01,
      "minimum": 0.000001,
      "maximum": 1
    },
    "initialSpeed": {
      "type": "number",
      "title": "Initial speed",
      "description": "Each fresh velocity has this translational magnitude in simulation length/time units.",
      "default": 1,
      "minimum": 0.0001,
      "maximum": 100
    },
    "angularSpeed": {
      "type": "number",
      "title": "Angular speed",
      "description": "Uniform angular velocity half-width in radians/time for polygons; discs ignore it.",
      "default": 0.3,
      "minimum": 0,
      "maximum": 10
    },
    "initialShrink": {
      "type": "number",
      "title": "Initial piece shrink",
      "description": "Fraction of unit piece size removed initially, with centres and container fixed, to create free room.",
      "default": 0.2,
      "minimum": 0.001,
      "maximum": 0.9
    },
    "restartShrink": {
      "type": "number",
      "title": "Restart decompression",
      "description": "Fraction removed from piece sizes when restarting the current best with fresh velocities.",
      "default": 0.05,
      "minimum": 0.001,
      "maximum": 0.5
    },
    "runs": {
      "type": "integer",
      "title": "Independent velocity runs",
      "description": "Maximum growth runs; each restart uses the current best and independent seeded velocities.",
      "default": 4,
      "minimum": 1,
      "maximum": 100
    },
    "jamThreshold": {
      "type": "number",
      "title": "Jamming threshold",
      "description": "Fractional growth per collision below this for jamWindow successive collisions ends a run.",
      "default": 1e-8,
      "minimum": 1e-14,
      "maximum": 0.01
    },
    "jamWindow": {
      "type": "integer",
      "title": "Jamming collision count",
      "description": "Consecutive tiny-growth collisions required before declaring jam; prevents one simultaneous contact from ending a run.",
      "default": 32,
      "minimum": 2,
      "maximum": 10000
    },
    "energyFactor": {
      "type": "number",
      "title": "Kinetic energy reset factor",
      "description": "When translational energy exceeds this multiple of its initial value, scale velocities back to initial energy.",
      "default": 4,
      "minimum": 1.01,
      "maximum": 100
    },
    "evaluationInterval": {
      "type": "integer",
      "title": "Events/steps per assessment",
      "description": "Rescale to unit pieces and assess every this many queue operations or polygon steps, and at jamming.",
      "default": 16,
      "minimum": 1,
      "maximum": 10000
    },
    "stagnationEvaluations": {
      "type": "integer",
      "title": "Stagnation assessments",
      "description": "End a run after this many assessments without a meaningful improvement in its best score.",
      "default": 128,
      "minimum": 2,
      "maximum": 10000
    },
    "maxStep": {
      "type": "number",
      "title": "Maximum polygon time step",
      "description": "Upper time-step bound; reduced with translational, angular and growth speeds, then backed up by bisection at contacts.",
      "default": 0.02,
      "minimum": 0.00001,
      "maximum": 0.1
    },
    "seedEvals": {
      "type": "integer",
      "title": "Seed evaluation slice",
      "description": "Maximum automatic-generator slice, at least three evaluations when available; ignored for random placement.",
      "default": 8,
      "minimum": 3,
      "maximum": 256
    }
  }
}
```

## Verified literature

[EST] Boris D. Lubachevsky and Frank H. Stillinger, **“Geometric properties of
random disk packings,” Journal of Statistical Physics 60 (1990), 561–583**,
[doi:10.1007/BF01025983](https://link.springer.com/article/10.1007/BF01025983).
Verified authors, title, venue, year and page range on the publisher's article
page on 2026-10-09. Its abstract describes uniformly growing ballistic discs
and event-driven simulation; the hard walls and queue rebuilding here are
implementation choices rather than reproductions of its periodic-cell code.

[EST] Boris D. Lubachevsky, **“How to simulate billiards and similar systems,”
Journal of Computational Physics 94(2) (1991), 255–283**,
[doi:10.1016/0021-9991(91)90222-7](https://www.sciencedirect.com/science/article/abs/pii/0021999191902227).
Verified bibliographic details in the publisher's indexed result and the
author's [arXiv manuscript record](https://arxiv.org/abs/cond-mat/0503627),
accessed 2026-10-09. Direct publisher retrieval returned HTTP 403. This is the
source for chronological event scheduling, not a claim that this implementation
has its asynchronous scheduling efficiency.

[EST] Aleksandar Donev, Salvatore Torquato and Frank H. Stillinger,
**“Neighbor list collision-driven molecular dynamics simulation for nonspherical
hard particles. I. Algorithmic details,” Journal of Computational Physics
202(2) (2005), 737–764**, doi:10.1016/j.jcp.2004.08.014.
Verified all details from page 1 of the
[author-hosted paper](https://fhstillinger.github.io/FrankStillingerWebsite/fhspapers/fhspaper288.pdf)
on 2026-10-09. Its time-driven discussion explicitly describes overlap detection
and rolling back to collision, and warns about missed and misordered events.
Its rigorous nonspherical event-driven algorithm is **not** implemented here.
No unverified reference is included.

## Measurements

[CALC] All 960 requested comparison and growth-rate runs completed with final polish enabled. Every group uses seeds 1–20. Both methods receive the **same random loose start** constructed by `randomLoose(problem, seededRandom(seed), () => false)`, then their method random streams independently begin from that same seed. Mandatory start assessment counts against both budgets. These supplied random starts avoid method-specific seeding differences; the no-start regression is separate.

[CALC] Hardware/runtime: Apple M1 Pro, eight logical CPUs, Darwin arm64, Node v26.5.0. Four benchmark shards ran concurrently. Seconds include start assessment, dynamics/optimization and final polish, but exclude constructing the supplied random arrangement. Host load was not controlled; timings are local measurements. The evaluation budget is a hard cap, not a requirement to waste evaluations after stagnation or jamming. Penalty frequently converges before either cap.

[CALC] Success means **absolute** difference from the stored `data/records.json` value at most the stated tolerance. Some targets are truncated: triangle six circles stores `7.464` at precision 3, pentagon six stores `2.61803` at precision 5, hexagon seven stores `2.886` at precision 3. The six-circle triangular construction has side approximately `7.464101615`, exceeding its literal stored value by about `1.01615e-4`, so even that exact construction misses the requested `1e-4` count. Zero successes at `1e-9` for truncated targets must not be interpreted as a precisely established literature gap. Values are retained literally as requested; no extra literature precision is invented.

### Default LS versus penalty

| N/M/P  | Evaluation cap | Method    |  Stored value | Success ≤1e-4 · ≤1e-9 | Median score |  Worst score | Seconds median / worst / total |
| ------ | -------------: | --------- | ------------: | --------------------- | -----------: | -----------: | -----------------------------: |
| 0/0/7  |          3,000 | ls_growth |             3 | 20/20 · 20/20         | 3.0000000000 | 3.0000000000 |          0.357 / 0.404 / 7.119 |
| 0/0/7  |          3,000 | penalty   |             3 | 18/20 · 18/20         | 3.0000000000 | 3.3047648710 |          0.016 / 0.042 / 0.417 |
| 0/0/7  |         30,000 | ls_growth |             3 | 20/20 · 20/20         | 3.0000000000 | 3.0000000000 |          0.322 / 0.351 / 6.337 |
| 0/0/7  |         30,000 | penalty   |             3 | 18/20 · 18/20         | 3.0000000000 | 3.3047648710 |          0.013 / 0.022 / 0.281 |
| 0/0/12 |          3,000 | ls_growth | 4.02960193012 | 20/20 · 20/20         | 4.0296019301 | 4.0296019301 |         0.901 / 1.116 / 18.406 |
| 0/0/12 |          3,000 | penalty   | 4.02960193012 | 17/20 · 17/20         | 4.0296019301 | 4.2360679775 |          0.094 / 0.251 / 2.204 |
| 0/0/12 |         30,000 | ls_growth | 4.02960193012 | 20/20 · 20/20         | 4.0296019301 | 4.0296019301 |         0.769 / 1.996 / 20.773 |
| 0/0/12 |         30,000 | penalty   | 4.02960193012 | 17/20 · 17/20         | 4.0296019301 | 4.2360679775 |          0.190 / 0.540 / 4.378 |
| 0/0/19 |          3,000 | ls_growth | 4.86370330516 | 20/20 · 20/20         | 4.8637033052 | 4.8637033052 |         2.066 / 4.272 / 45.789 |
| 0/0/19 |          3,000 | penalty   | 4.86370330516 | 16/20 · 16/20         | 4.8637033052 | 5.4939592074 |          0.394 / 0.918 / 7.982 |
| 0/0/19 |         30,000 | ls_growth | 4.86370330516 | 20/20 · 20/20         | 4.8637033052 | 4.8637033052 |         2.001 / 2.375 / 41.206 |
| 0/0/19 |         30,000 | penalty   | 4.86370330516 | 16/20 · 16/20         | 4.8637033052 | 5.4939592074 |          0.210 / 0.669 / 4.335 |
| 0/0/30 |          3,000 | ls_growth | 6.19774107088 | 12/20 · 0/20          | 6.1978019203 | 6.1998607981 |       5.394 / 13.254 / 126.246 |
| 0/0/30 |          3,000 | penalty   | 6.19774107088 | 4/20 · 4/20           | 6.2012172709 | 6.4421911518 |         1.537 / 3.312 / 33.698 |
| 0/0/30 |         30,000 | ls_growth | 6.19774107088 | 14/20 · 6/20          | 6.1977447973 | 6.1997856182 |        7.226 / 9.091 / 147.218 |
| 0/0/30 |         30,000 | penalty   | 6.19774107088 | 4/20 · 4/20           | 6.2012172709 | 6.4421911518 |         1.575 / 5.722 / 41.329 |
| 0/4/10 |          3,000 | ls_growth | 6.74744152325 | 13/20 · 12/20         | 6.7474415232 | 6.7671021393 |         0.653 / 0.806 / 13.341 |
| 0/4/10 |          3,000 | penalty   | 6.74744152325 | 11/20 · 11/20         | 6.7474415232 | 6.9469971991 |          0.133 / 0.192 / 2.618 |
| 0/4/10 |         30,000 | ls_growth | 6.74744152325 | 13/20 · 12/20         | 6.7474415232 | 6.7671021393 |         1.270 / 1.784 / 25.638 |
| 0/4/10 |         30,000 | penalty   | 6.74744152325 | 11/20 · 11/20         | 6.7474415232 | 6.9469971991 |          0.150 / 0.273 / 3.010 |
| 0/4/20 |          3,000 | ls_growth | 8.97808335286 | 17/20 · 17/20         | 8.9780833528 | 9.1439503330 |         2.236 / 4.792 / 49.112 |
| 0/4/20 |          3,000 | penalty   | 8.97808335286 | 9/20 · 9/20           | 9.1462718814 | 9.4363133751 |         0.756 / 1.070 / 14.296 |
| 0/4/20 |         30,000 | ls_growth | 8.97808335286 | 17/20 · 17/20         | 8.9780833528 | 9.1439503292 |         2.608 / 3.075 / 53.477 |
| 0/4/20 |         30,000 | penalty   | 8.97808335286 | 9/20 · 9/20           | 9.1462718814 | 9.4363133751 |         0.763 / 1.072 / 14.552 |
| 0/3/6  |          3,000 | ls_growth |         7.464 | 0/20 · 0/20           | 7.4641016151 | 7.4641016151 |          0.227 / 0.273 / 4.697 |
| 0/3/6  |          3,000 | penalty   |         7.464 | 0/20 · 0/20           | 7.4641016151 | 7.4641016151 |          0.010 / 0.017 / 0.223 |
| 0/3/6  |         30,000 | ls_growth |         7.464 | 0/20 · 0/20           | 7.4641016151 | 7.4641016151 |          0.246 / 0.287 / 4.961 |
| 0/3/6  |         30,000 | penalty   |         7.464 | 0/20 · 0/20           | 7.4641016151 | 7.4641016151 |          0.010 / 0.021 / 0.223 |
| 4/4/5  |          3,000 | ls_growth | 2.70710678119 | 2/20 · 2/20           | 2.8487913987 | 3.0007918656 |         3.005 / 3.991 / 62.327 |
| 4/4/5  |          3,000 | penalty   | 2.70710678119 | 0/20 · 0/20           | 3.0000000000 | 3.0000000000 |          0.038 / 0.135 / 0.935 |
| 4/4/5  |         30,000 | ls_growth | 2.70710678119 | 3/20 · 3/20           | 2.8682802462 | 3.0002921134 |         3.625 / 4.870 / 73.013 |
| 4/4/5  |         30,000 | penalty   | 2.70710678119 | 0/20 · 0/20           | 3.0000000000 | 3.0000000000 |          0.037 / 0.131 / 0.907 |
| 5/5/6  |          3,000 | ls_growth |       2.61803 | 18/20 · 0/20          | 2.6180341194 | 2.8066244751 |        5.737 / 7.036 / 116.799 |
| 5/5/6  |          3,000 | penalty   |       2.61803 | 9/20 · 0/20           | 2.9988828102 | 3.4138616690 |          0.414 / 0.590 / 8.102 |
| 5/5/6  |         30,000 | ls_growth |       2.61803 | 18/20 · 0/20          | 2.6180339895 | 3.0520171714 |       6.471 / 13.377 / 137.564 |
| 5/5/6  |         30,000 | penalty   |       2.61803 | 9/20 · 0/20           | 2.9988828102 | 3.4138616690 |         0.617 / 0.923 / 11.494 |
| 6/6/7  |          3,000 | ls_growth |         2.886 | 0/20 · 0/20           | 2.9256355263 | 2.9420735365 |        7.731 / 8.888 / 157.816 |
| 6/6/7  |          3,000 | penalty   |         2.886 | 0/20 · 0/20           | 2.9353264196 | 3.6571935648 |          0.321 / 0.649 / 6.976 |
| 6/6/7  |         30,000 | ls_growth |         2.886 | 0/20 · 0/20           | 2.9254764231 | 2.9459833105 |       8.692 / 18.053 / 182.570 |
| 6/6/7  |         30,000 | penalty   |         2.886 | 0/20 · 0/20           | 2.9353264196 | 3.6571935648 |          0.332 / 0.959 / 7.342 |

### Growth-rate comparison

[CALC] All other LS defaults remain fixed. Default-rate rows repeat above for comparison. A larger cap changes restart slices and future random-stream consumption, so scores need not improve monotonically across independent runs with different caps.

| N/M/P  | Evaluation cap | Method          |  Stored value | Success ≤1e-4 · ≤1e-9 | Median score |  Worst score | Seconds median / worst / total |
| ------ | -------------: | --------------- | ------------: | --------------------- | -----------: | -----------: | -----------------------------: |
| 0/0/19 |          3,000 | ls_growth 0.001 | 4.86370330516 | 20/20 · 20/20         | 4.8637033052 | 4.8637033052 |         1.723 / 2.689 / 34.875 |
| 0/0/19 |          3,000 | ls_growth 0.01  | 4.86370330516 | 20/20 · 20/20         | 4.8637033052 | 4.8637033052 |         2.066 / 4.272 / 45.789 |
| 0/0/19 |          3,000 | ls_growth 0.1   | 4.86370330516 | 17/20 · 17/20         | 4.8637033052 | 5.1256221773 |          0.255 / 0.658 / 6.090 |
| 0/0/19 |         30,000 | ls_growth 0.001 | 4.86370330516 | 20/20 · 20/20         | 4.8637033052 | 4.8637033052 |       8.851 / 11.279 / 165.832 |
| 0/0/19 |         30,000 | ls_growth 0.01  | 4.86370330516 | 20/20 · 20/20         | 4.8637033052 | 4.8637033052 |         2.001 / 2.375 / 41.206 |
| 0/0/19 |         30,000 | ls_growth 0.1   | 4.86370330516 | 17/20 · 17/20         | 4.8637033052 | 5.1256221773 |          0.312 / 0.712 / 6.752 |
| 0/0/30 |          3,000 | ls_growth 0.001 | 6.19774107088 | 0/20 · 0/20           | 6.2088954168 | 6.3284406987 |         4.880 / 6.019 / 96.173 |
| 0/0/30 |          3,000 | ls_growth 0.01  | 6.19774107088 | 12/20 · 0/20          | 6.1978019203 | 6.1998607981 |       5.394 / 13.254 / 126.246 |
| 0/0/30 |          3,000 | ls_growth 0.1   | 6.19774107088 | 0/20 · 0/20           | 6.2481713362 | 6.3812525657 |         3.235 / 5.101 / 65.940 |
| 0/0/30 |         30,000 | ls_growth 0.001 | 6.19774107088 | 9/20 · 2/20           | 6.1986297571 | 6.2101943506 |      14.854 / 21.592 / 298.567 |
| 0/0/30 |         30,000 | ls_growth 0.01  | 6.19774107088 | 14/20 · 6/20          | 6.1977447973 | 6.1997856182 |        7.226 / 9.091 / 147.218 |
| 0/0/30 |         30,000 | ls_growth 0.1   | 6.19774107088 | 0/20 · 0/20           | 6.2481713362 | 6.3812525657 |         3.072 / 4.291 / 59.706 |

[CALC] At P=19 the two slower rates reach the stored value in 20/20 runs at either cap, versus 17/20 for the fastest rate. At P=30, rate 0.01 performs best at 3,000 evaluations; rate 0.001 has not compressed enough at that cap. Density and ordering at a finite hard boundary cannot be inferred from growth rate alone. Structural-order measurements follow below. Defaults were measured over twenty seeds and were not tuned to the first five.

### Repair frequency and strict results

| LS group         | Runs with repair | Repair calls | Queue operations / polygon steps | Repairs per 1,000 operations |
| ---------------- | ---------------: | -----------: | -------------------------------: | ---------------------------: |
| Default discs    |          280/280 |    2,535,785 |                        9,560,144 |                      265.245 |
| Default polygons |          120/120 |        2,029 |                        3,210,949 |                        0.632 |
| All LS rates     |          560/560 |    5,440,289 |                       23,650,715 |                      230.026 |

[CALC] Minimum final pair separation: **all 960 results -1.6986412276764895e-14**, **LS -1.4876988529977098e-14**, **disc results 0**. No result is below −1e-12. Tiny negative polygon gaps arise after the shared appended polish, whose original strict contract permitted 1e-12 penetration (current framework margin is `1e−12 + 4 * Number.EPSILON * max(abs(x), abs(y))`); LS submissions require nonnegative separation. Nonnegative polygon contacts on the final returned result require changes to shared polish restoration/acceptance and framework strict tracking, which this method does not alter.

### Structural order

[CALC] A separate twenty-seed repeat at 3,000 evaluations with final polish measures the diagnostic `|ψ6| = |Σ exp(6i atan2(dy,dx))| / B`, over the B unordered centre pairs at distance at most 2.4. It is invariant to rotating the whole packing. This particular global metric is defined here; it is not a claim of thermodynamic crystallinity. The same starts and parameter defaults are used as in the comparison.

| Circles P | Growth rate | Median global \|ψ6\| | Maximum global \|ψ6\| |
| --------: | ----------: | -------------------: | --------------------: |
|        19 |       0.001 |             <1.4e-13 |              <1.4e-13 |
|        19 |        0.01 |             <1.4e-13 |              <1.4e-13 |
|        19 |         0.1 |             <1.4e-13 |              0.473394 |
|        30 |       0.001 |             0.062482 |              0.435887 |
|        30 |        0.01 |             0.039108 |              0.039187 |
|        30 |         0.1 |             0.075820 |              0.497573 |

[CALC] The 19-circle optimum has twelvefold ring symmetry, so neighbouring bond directions cancel in this global sixfold diagnostic. Its near-zero value is not disorder. At P=30, the faster rate has a higher median global sixfold value despite worse density. Therefore these finite, hard-wall, polished examples do **not** establish a monotonic growth-rate-versus-order relationship. Slower growth allows more rearrangement and can improve density, as the score measurements show; bulk ordering intuition cannot be presented as a measured universal result for these cases.

```sh
LS_ORDER=1 npx vitest run packages/solver/test/ls_growth.test.ts -t 'bond-order'
```

### Dynamics throughput

[CALC] Five independent seeds 1–5 on the same Node/Apple M1 Pro host. Each circle sample advances 4,000 queue operations at P=30 or 2,000 at P=200; each square sample advances 1,000 steps. Timing includes the actual event search or backed-up step, strict geometry repair, thermostat and the per-operation Vitest invariant assertion. It excludes creating the arrangement, context scoring and final polish. Disc events below mean physical pair/wall collisions; horizon maintenance is included only in operations. Browser throughput remains unmeasured.

| Pieces/container | Count P | Median events/s (range) | Median operations or steps/s (range) | Repair calls / operations, five samples |
| ---------------- | ------: | ----------------------: | -----------------------------------: | --------------------------------------: |
| Circles/circle   |      30 |  15,017 (13,888–16,168) |               15,900 (14,600–17,149) |                          5,531 / 20,000 |
| Circles/circle   |     200 |     1,331 (1,269–2,521) |                  1,340 (1,284–2,553) |                          3,821 / 10,000 |
| Squares/square   |      30 |                       — |                  2,605 (2,454–2,889) |                               0 / 5,000 |

```sh
LS_PERF=1 npx vitest run packages/solver/test/ls_growth.test.ts -t 'throughput'
```

<details>
<summary>Raw throughput measurements</summary>

```csv
N,M,P,seed,seconds,operations,collisions,repairs
0,0,30,1,0.2515775840000133,4000,3778,1140
0,0,30,2,0.26667350000003354,4000,3709,1105
0,0,30,3,0.2739715420000139,4000,3805,1098
0,0,30,4,0.24821241599996574,4000,3757,1068
0,0,30,5,0.23324433300003874,4000,3771,1120
0,0,200,1,0.7833094999999739,2000,1975,759
0,0,200,2,1.116744000000006,2000,1983,746
0,0,200,3,1.4927864160000464,2000,1987,779
0,0,200,4,1.4957336249999935,2000,1964,759
0,0,200,5,1.5579374170000082,2000,1977,778
4,4,30,1,0.3461619580000406,1000,125,0
4,4,30,2,0.40744162499997766,1000,105,0
4,4,30,3,0.39269062499998836,1000,114,0
4,4,30,4,0.3514589590000105,1000,102,0
4,4,30,5,0.38383620900003007,1000,124,0
```

</details>

### Verification and remaining limits

[CALC] The ordinary LS test file has 16 tests (measured at **30.07 s**), plus three opt-in measurement tests that are skipped by default. It checks exact event times against stepping, zero-growth energy/momentum, long strict disc runs, random shapes, known targets, exact evaluation accounting, determinism, time/abort limits, invalid-start repair and independent review regressions. The separate ordering/throughput invocation passed both measurement tests in **447.25 s**; the long runners are deliberately excluded from normal verification. The four comparison shards completed all 960 rows, twenty seeds per group.

[CALC] An independent review of the implementation identified, and verified fixes for, curved-wall tangency, selecting a later polygon contact after backing up to an earlier wall, and omitting event-free growth from jam assessment. The horizon-jamming regression test comes from that review.

[CALC] Explicit remaining limits: polygon rotation omits torque and can miss brief contacts between samples; queues rebuild after each event rather than using asynchronous per-particle updates; browser throughput is not measured; the common float64 polish runs, not an automatically invoked 50-digit Python solver. With an invalid twelve-circle start and final polish enabled, cap 2 produces no valid best because the framework reserves the sole post-start evaluation for polish and skips LS; caps 3 and 8 repair successfully. Disabling final polish permits repair at cap 2. Already-aborted or zero-time runs without a valid supplied start may likewise return no configuration. Allowing a restoration assessment before the polish reserve requires a framework change. LS does not emit an invalid configuration as a returned best.

Reproduce the comparison by running this command for SHARD values 0, 1, 2, 3. Each shard appends headerless CSV rows to `LS_BENCH_OUT`, or by default to `polypack-ls-bench-shard-<SHARD>.csv` in the OS temporary directory, and logs the path; delete that file before rerunning a shard.

```sh
LS_BENCH_SHARD=0 npx vitest run packages/solver/test/ls_growth.test.ts -t 'twenty-seed ls_growth and penalty'
```

<details>
<summary>Raw twenty-seed measurements (CSV; Node v26.5.0)</summary>

```csv
N,M,P,budget,method,growthRate,seed,published,score,seconds,evaluations,minSeparation,operations,collisions,repairs,thermostats
0,0,7,3000,ls_growth,0.01,1,3,3.0000000000001985,0.3558320410000001,1391,1.9317880628477724e-13,20210,19777,4975,60
0,0,7,3000,ls_growth,0.01,2,3,3.000000000000199,0.3969441669999999,1342,1.900701818158268e-13,19960,19653,4786,60
0,0,7,3000,ls_growth,0.01,3,3,3.000000000000199,0.40405012499999976,1348,1.9229062786507711e-13,20052,19635,4887,60
0,0,7,3000,ls_growth,0.01,4,3,3.0000000000002007,0.33264904100000015,1328,1.98507876802978e-13,19754,19397,4944,59
0,0,7,3000,ls_growth,0.01,5,3,3.0000000000002,0.357378792,1346,1.9317880628477724e-13,19744,19388,4716,59
0,0,7,3000,ls_growth,0.01,6,3,3.000000000000199,0.36295075,1339,1.9761969838327786e-13,19909,19610,4888,59
0,0,7,3000,ls_growth,0.01,7,3,3.000000000000174,0.38276470900000004,1337,1.021405182655144e-14,19900,19600,5000,59
0,0,7,3000,ls_growth,0.01,8,3,3.0000000000002,0.3047612079999999,1376,1.936228954946273e-13,19466,19078,4704,59
0,0,7,3000,ls_growth,0.01,9,3,3.0000000000002,0.36392387499999995,1317,1.91402449445377e-13,19555,19185,4679,58
0,0,7,3000,ls_growth,0.01,10,3,3.0000000000001905,0.40287212499999986,1363,1.8074430840897548e-13,20289,19829,4787,61
0,0,7,3000,ls_growth,0.01,11,3,3.0000000000001985,0.3384445420000002,1352,1.91402449445377e-13,20111,19632,4890,60
0,0,7,3000,ls_growth,0.01,12,3,3.000000000000199,0.3194338749999997,1328,1.949551631241775e-13,19735,19406,4803,59
0,0,7,3000,ls_growth,0.01,13,3,3.0000000000001994,0.3769749579999998,1338,1.9628743075372768e-13,19885,19511,4855,59
0,0,7,3000,ls_growth,0.01,14,3,3.0000000000002007,0.383472084,1323,1.9895196601282805e-13,19651,19235,4589,58
0,0,7,3000,ls_growth,0.01,15,3,3.000000000000199,0.3325672080000004,1338,1.9584334154387761e-13,19885,19448,4737,59
0,0,7,3000,ls_growth,0.01,16,3,3.0000000000002003,0.32988337500000037,1348,1.9539925233402755e-13,19771,19422,4876,60
0,0,7,3000,ls_growth,0.01,17,3,3.0000000000002003,0.317670709,1343,1.971756091734278e-13,19956,19484,4736,59
0,0,7,3000,ls_growth,0.01,18,3,3.000000000000198,0.34370145799999957,1346,1.9673151996357774e-13,20017,19527,4743,60
0,0,7,3000,ls_growth,0.01,19,3,3.0000000000001963,0.36340099999999986,1337,1.829647544582258e-13,19873,19430,4852,60
0,0,7,3000,ls_growth,0.01,20,3,3.0000000000001985,0.3493299999999999,1359,1.9317880628477724e-13,19945,19481,4878,59
0,0,7,3000,penalty,0.01,1,3,3.304764870962714,0.032891499999999727,216,1.936228954946273e-13,0,0,0,0
0,0,7,3000,penalty,0.01,2,3,3.000000000000179,0.028272417000000133,202,3.6415315207705135e-14,0,0,0,0
0,0,7,3000,penalty,0.01,3,3,3.0000000000001887,0.015376540999999634,223,1.3322676295501878e-15,0,0,0,0
0,0,7,3000,penalty,0.01,4,3,3.0000000000001985,0.031097332999999706,239,1.9628743075372768e-13,0,0,0,0
0,0,7,3000,penalty,0.01,5,3,3.000000000000195,0.02413929200000166,187,1.8696155734687636e-13,0,0,0,0
0,0,7,3000,penalty,0.01,6,3,3.0000000000002003,0.0217973750000001,186,1.9628743075372768e-13,0,0,0,0
0,0,7,3000,penalty,0.01,7,3,3.0000000000002007,0.03128408300000046,223,1.9673151996357774e-13,0,0,0,0
0,0,7,3000,penalty,0.01,8,3,3.0000000000001994,0.009307042000000366,186,1.9584334154387761e-13,0,0,0,0
0,0,7,3000,penalty,0.01,9,3,3.000000000000158,0.02422637500000019,230,5.1514348342607263e-14,0,0,0,0
0,0,7,3000,penalty,0.01,10,3,3.000000000000178,0.034360458000001017,220,8.526512829121202e-14,0,0,0,0
0,0,7,3000,penalty,0.01,11,3,3.0000000000001985,0.016180624999999053,205,1.9584334154387761e-13,0,0,0,0
0,0,7,3000,penalty,0.01,12,3,3.000000000000201,0.014337125000000015,206,1.949551631241775e-13,0,0,0,0
0,0,7,3000,penalty,0.01,13,3,3.0000000000001994,0.011903332999998384,207,1.9806378759312793e-13,0,0,0,0
0,0,7,3000,penalty,0.01,14,3,3.0000000000002003,0.010222125000000233,220,1.9539925233402755e-13,0,0,0,0
0,0,7,3000,penalty,0.01,15,3,3.0000000000001994,0.04190475000000151,321,1.936228954946273e-13,0,0,0,0
0,0,7,3000,penalty,0.01,16,3,3.000000000000198,0.015625332999999957,207,1.887379141862766e-13,0,0,0,0
0,0,7,3000,penalty,0.01,17,3,3.0000000000002003,0.014693250000000262,225,1.9806378759312793e-13,0,0,0,0
0,0,7,3000,penalty,0.01,18,3,3.304764870962715,0.011911916999999448,253,1.7985612998927536e-13,0,0,0,0
0,0,7,3000,penalty,0.01,19,3,3.000000000000198,0.015057666000000608,220,1.9539925233402755e-13,0,0,0,0
0,0,7,3000,penalty,0.01,20,3,3.0000000000002007,0.01226129100000071,248,1.971756091734278e-13,0,0,0,0
0,0,7,30000,ls_growth,0.01,1,3,3.0000000000001985,0.3173664169999993,1391,1.9317880628477724e-13,20210,19777,4975,60
0,0,7,30000,ls_growth,0.01,2,3,3.000000000000199,0.3278512499999997,1342,1.900701818158268e-13,19960,19653,4786,60
0,0,7,30000,ls_growth,0.01,3,3,3.000000000000199,0.3297634999999991,1348,1.9229062786507711e-13,20052,19635,4887,60
0,0,7,30000,ls_growth,0.01,4,3,3.0000000000002007,0.3505600830000003,1328,1.98507876802978e-13,19754,19397,4944,59
0,0,7,30000,ls_growth,0.01,5,3,3.0000000000002,0.31004120799999874,1346,1.9317880628477724e-13,19744,19388,4716,59
0,0,7,30000,ls_growth,0.01,6,3,3.000000000000199,0.3380037499999999,1339,1.9761969838327786e-13,19909,19610,4888,59
0,0,7,30000,ls_growth,0.01,7,3,3.000000000000174,0.28934200000000054,1337,1.021405182655144e-14,19900,19600,5000,59
0,0,7,30000,ls_growth,0.01,8,3,3.0000000000002,0.30150374999999985,1376,1.936228954946273e-13,19466,19078,4704,59
0,0,7,30000,ls_growth,0.01,9,3,3.0000000000002,0.28848033400000167,1317,1.91402449445377e-13,19555,19185,4679,58
0,0,7,30000,ls_growth,0.01,10,3,3.0000000000001905,0.32909449999999923,1363,1.8074430840897548e-13,20289,19829,4787,61
0,0,7,30000,ls_growth,0.01,11,3,3.0000000000001985,0.3332440830000014,1352,1.91402449445377e-13,20111,19632,4890,60
0,0,7,30000,ls_growth,0.01,12,3,3.000000000000199,0.3301413329999996,1328,1.949551631241775e-13,19735,19406,4803,59
0,0,7,30000,ls_growth,0.01,13,3,3.0000000000001994,0.3121367499999997,1338,1.9628743075372768e-13,19885,19511,4855,59
0,0,7,30000,ls_growth,0.01,14,3,3.0000000000002007,0.2904412080000002,1323,1.9895196601282805e-13,19651,19235,4589,58
0,0,7,30000,ls_growth,0.01,15,3,3.000000000000199,0.32849191699999936,1338,1.9584334154387761e-13,19885,19448,4737,59
0,0,7,30000,ls_growth,0.01,16,3,3.0000000000002003,0.3469703750000008,1348,1.9539925233402755e-13,19771,19422,4876,60
0,0,7,30000,ls_growth,0.01,17,3,3.0000000000002003,0.3038130000000001,1343,1.971756091734278e-13,19956,19484,4736,59
0,0,7,30000,ls_growth,0.01,18,3,3.000000000000198,0.32762320799999906,1346,1.9673151996357774e-13,20017,19527,4743,60
0,0,7,30000,ls_growth,0.01,19,3,3.0000000000001963,0.2878778750000001,1337,1.829647544582258e-13,19873,19430,4852,60
0,0,7,30000,ls_growth,0.01,20,3,3.0000000000001985,0.29376358299999994,1359,1.9317880628477724e-13,19945,19481,4878,59
0,0,7,30000,penalty,0.01,1,3,3.304764870962714,0.014389250000000174,216,1.936228954946273e-13,0,0,0,0
0,0,7,30000,penalty,0.01,2,3,3.000000000000179,0.016373584000000847,202,3.6415315207705135e-14,0,0,0,0
0,0,7,30000,penalty,0.01,3,3,3.0000000000001887,0.014961875000000874,223,1.3322676295501878e-15,0,0,0,0
0,0,7,30000,penalty,0.01,4,3,3.0000000000001985,0.022113624999999956,239,1.9628743075372768e-13,0,0,0,0
0,0,7,30000,penalty,0.01,5,3,3.000000000000195,0.012165917000000264,187,1.8696155734687636e-13,0,0,0,0
0,0,7,30000,penalty,0.01,6,3,3.0000000000002003,0.019929291999998894,186,1.9628743075372768e-13,0,0,0,0
0,0,7,30000,penalty,0.01,7,3,3.0000000000002007,0.016762625000001207,223,1.9673151996357774e-13,0,0,0,0
0,0,7,30000,penalty,0.01,8,3,3.0000000000001994,0.007621750000000247,186,1.9584334154387761e-13,0,0,0,0
0,0,7,30000,penalty,0.01,9,3,3.000000000000158,0.012974959000001035,230,5.1514348342607263e-14,0,0,0,0
0,0,7,30000,penalty,0.01,10,3,3.000000000000178,0.010844750000000203,220,8.526512829121202e-14,0,0,0,0
0,0,7,30000,penalty,0.01,11,3,3.0000000000001985,0.008744042000000262,205,1.9584334154387761e-13,0,0,0,0
0,0,7,30000,penalty,0.01,12,3,3.000000000000201,0.020462457999999968,206,1.949551631241775e-13,0,0,0,0
0,0,7,30000,penalty,0.01,13,3,3.0000000000001994,0.010260333000000173,207,1.9806378759312793e-13,0,0,0,0
0,0,7,30000,penalty,0.01,14,3,3.0000000000002003,0.010929167000000234,220,1.9539925233402755e-13,0,0,0,0
0,0,7,30000,penalty,0.01,15,3,3.0000000000001994,0.019690292000001136,321,1.936228954946273e-13,0,0,0,0
0,0,7,30000,penalty,0.01,16,3,3.000000000000198,0.012442250000000057,207,1.887379141862766e-13,0,0,0,0
0,0,7,30000,penalty,0.01,17,3,3.0000000000002003,0.0164443339999998,225,1.9806378759312793e-13,0,0,0,0
0,0,7,30000,penalty,0.01,18,3,3.304764870962715,0.012436125000000174,253,1.7985612998927536e-13,0,0,0,0
0,0,7,30000,penalty,0.01,19,3,3.000000000000198,0.010938666000000012,220,1.9539925233402755e-13,0,0,0,0
0,0,7,30000,penalty,0.01,20,3,3.0000000000002007,0.010109582999999474,248,1.971756091734278e-13,0,0,0,0
0,0,12,3000,ls_growth,0.01,1,4.029601930116184,4.0296019301164705,1.115502333,2367,1.6653345369377348e-13,30117,29812,7732,56
0,0,12,3000,ls_growth,0.01,2,4.029601930116184,4.029601930116492,1.0866870829999997,2328,1.7363888105137448e-13,29460,29234,7443,53
0,0,12,3000,ls_growth,0.01,3,4.029601930116184,4.02960193011647,1.0516630419999997,2745,1.7896795156957523e-13,29895,29578,7685,55
0,0,12,3000,ls_growth,0.01,4,4.029601930116184,4.029601930116487,0.8941791670000002,2287,1.7852386235972517e-13,29100,28767,7452,52
0,0,12,3000,ls_growth,0.01,5,4.029601930116184,4.029601930116492,0.9783678330000003,2626,1.7896795156957523e-13,29268,28973,7547,53
0,0,12,3000,ls_growth,0.01,6,4.029601930116184,4.029601930116491,0.8481266249999999,2295,1.8252066524837574e-13,29490,29134,7648,55
0,0,12,3000,ls_growth,0.01,7,4.029601930116184,4.0296019301164785,0.9644909590000007,2361,1.687538997430238e-13,30011,29680,7779,53
0,0,12,3000,ls_growth,0.01,8,4.029601930116184,4.029601930116495,0.9982984169999991,2340,1.723066134218243e-13,29692,29336,7542,53
0,0,12,3000,ls_growth,0.01,9,4.029601930116184,4.029601930116485,0.891770292000001,2338,1.6697754290362354e-13,29628,29284,7496,54
0,0,12,3000,ls_growth,0.01,10,4.029601930116184,4.029601930116483,0.9176147500000006,2344,1.8030021919912542e-13,30017,29673,7648,54
0,0,12,3000,ls_growth,0.01,11,4.029601930116184,4.029601930116481,0.8942777089999999,2378,1.745270594710746e-13,30291,29917,7838,55
0,0,12,3000,ls_growth,0.01,12,4.029601930116184,4.029601930116482,0.9012567920000001,2285,1.7674750552032492e-13,29073,28835,7474,53
0,0,12,3000,ls_growth,0.01,13,4.029601930116184,4.029601930116502,0.905936291,2320,1.6830981053317373e-13,29301,28986,7346,53
0,0,12,3000,ls_growth,0.01,14,4.029601930116184,4.029601930116492,0.9588732500000006,2293,1.816324868286756e-13,28927,28710,7460,53
0,0,12,3000,ls_growth,0.01,15,4.029601930116184,4.029601930116483,0.8508924999999999,2293,1.7719159473017498e-13,29194,28865,7521,52
0,0,12,3000,ls_growth,0.01,16,4.029601930116184,4.029601930116478,0.9004574169999996,2388,1.6653345369377348e-13,30456,30134,7648,55
0,0,12,3000,ls_growth,0.01,17,4.029601930116184,4.029601930116483,0.8730265830000008,2392,1.6830981053317373e-13,30773,30430,7780,54
0,0,12,3000,ls_growth,0.01,18,4.029601930116184,4.029601930116482,0.8955807080000013,2755,1.674216321134736e-13,29694,29367,7585,55
0,0,12,3000,ls_growth,0.01,19,4.029601930116184,4.029601930116488,0.7506450829999994,2333,1.674216321134736e-13,29571,29268,7729,53
0,0,12,3000,ls_growth,0.01,20,4.029601930116184,4.029601930116498,0.7282560410000005,2403,1.6964207816272392e-13,29890,29582,7617,53
0,0,12,3000,penalty,0.01,1,4.029601930116184,4.029601930116498,0.10776645800000187,350,1.7497114868092467e-13,0,0,0,0
0,0,12,3000,penalty,0.01,2,4.029601930116184,4.029601930116499,0.0973438750000023,348,1.638689184346731e-13,0,0,0,0
0,0,12,3000,penalty,0.01,3,4.029601930116184,4.029601930116499,0.09068941699999777,436,1.709743457922741e-13,0,0,0,0
0,0,12,3000,penalty,0.01,4,4.029601930116184,4.029601930116494,0.2505553329999966,1023,1.7363888105137448e-13,0,0,0,0
0,0,12,3000,penalty,0.01,5,4.029601930116184,4.029601930116442,0.11710637499999939,510,2.842170943040401e-14,0,0,0,0
0,0,12,3000,penalty,0.01,6,4.029601930116184,4.029601930116485,0.1499249579999996,621,1.709743457922741e-13,0,0,0,0
0,0,12,3000,penalty,0.01,7,4.029601930116184,4.029601930116485,0.23163904200000252,1150,1.6697754290362354e-13,0,0,0,0
0,0,12,3000,penalty,0.01,8,4.029601930116184,4.029601930116497,0.15299370899999848,561,1.6786572132332367e-13,0,0,0,0
0,0,12,3000,penalty,0.01,9,4.029601930116184,4.0296019301165025,0.09538845799999762,404,1.687538997430238e-13,0,0,0,0
0,0,12,3000,penalty,0.01,10,4.029601930116184,4.236067977499884,0.04475770900000134,323,1.4654943925052066e-14,0,0,0,0
0,0,12,3000,penalty,0.01,11,4.029601930116184,4.113622360487554,0.11362195799999972,502,1.8074430840897548e-13,0,0,0,0
0,0,12,3000,penalty,0.01,12,4.029601930116184,4.029601930116488,0.0844420420000024,366,1.7008616737257398e-13,0,0,0,0
0,0,12,3000,penalty,0.01,13,4.029601930116184,4.029601930116474,0.09263554099999965,474,1.7319479184152442e-13,0,0,0,0
0,0,12,3000,penalty,0.01,14,4.029601930116184,4.02960193011649,0.07060745899999893,356,1.709743457922741e-13,0,0,0,0
0,0,12,3000,penalty,0.01,15,4.029601930116184,4.029601930116488,0.06699412500000107,318,1.5054624213917123e-13,0,0,0,0
0,0,12,3000,penalty,0.01,16,4.029601930116184,4.02960193011648,0.13490395799999896,857,1.674216321134736e-13,0,0,0,0
0,0,12,3000,penalty,0.01,17,4.029601930116184,4.236067977499879,0.04627416699999958,388,1.021405182655144e-14,0,0,0,0
0,0,12,3000,penalty,0.01,18,4.029601930116184,4.02960193011649,0.08347704200000226,362,1.6475709685437323e-13,0,0,0,0
0,0,12,3000,penalty,0.01,19,4.029601930116184,4.02960193011649,0.08688837499999863,392,1.6786572132332367e-13,0,0,0,0
0,0,12,3000,penalty,0.01,20,4.029601930116184,4.029601930116492,0.08583725000000049,483,1.7319479184152442e-13,0,0,0,0
0,4,10,3000,ls_growth,0.01,1,6.74744152324853,6.747441523238584,0.705572583000001,2029,1.91402449445377e-13,25339,24984,6079,56
0,4,10,3000,ls_growth,0.01,2,6.74744152324853,6.747441523238579,0.8062176249999975,2010,1.865174681370263e-13,24127,23806,5950,55
0,4,10,3000,ls_growth,0.01,3,6.74744152324853,6.747441523238578,0.7415327089999991,2155,1.8118839761882555e-13,24421,24133,5802,55
0,4,10,3000,ls_growth,0.01,4,6.74744152324853,6.76027877732484,0.6289559580000023,1820,1.8385293287792592e-13,27583,27318,6932,58
0,4,10,3000,ls_growth,0.01,5,6.74744152324853,6.747441523238602,0.6769051670000008,2106,1.8740564655672642e-13,24183,23797,5837,54
0,4,10,3000,ls_growth,0.01,6,6.74744152324853,6.760278777324809,0.5855047909999994,1836,1.7763568394002505e-13,27319,27043,6908,58
0,4,10,3000,ls_growth,0.01,7,6.74744152324853,6.747441523238579,0.7405162500000005,2103,1.8562928971732617e-13,24144,23858,5763,55
0,4,10,3000,ls_growth,0.01,8,6.74744152324853,6.760278777324807,0.5914100419999995,1759,1.8074430840897548e-13,26626,26244,6555,56
0,4,10,3000,ls_growth,0.01,9,6.74744152324853,6.760278777324812,0.6319350830000003,1848,1.6209256159527285e-13,27268,27001,6784,57
0,4,10,3000,ls_growth,0.01,10,6.74744152324853,6.767102139331925,0.5422539580000012,1883,1.8696155734687636e-13,24277,23922,6133,55
0,4,10,3000,ls_growth,0.01,11,6.74744152324853,6.760278777324825,0.6351233749999993,1799,1.8918200339612667e-13,27259,26950,6651,56
0,4,10,3000,ls_growth,0.01,12,6.74744152324853,6.747441523238595,0.6792690829999992,2167,1.8607337892717624e-13,25228,24864,6136,58
0,4,10,3000,ls_growth,0.01,13,6.74744152324853,6.747441523238589,0.6269459999999999,2087,1.8607337892717624e-13,25201,24915,5850,56
0,4,10,3000,ls_growth,0.01,14,6.74744152324853,6.760278777324825,0.5768232920000009,1816,1.8562928971732617e-13,27540,27128,6897,58
0,4,10,3000,ls_growth,0.01,15,6.74744152324853,6.747478422980431,0.7820946670000012,1864,1.8918200339612667e-13,24823,24422,5791,56
0,4,10,3000,ls_growth,0.01,16,6.74744152324853,6.74744152323859,0.651393541999998,2076,1.8784973576657649e-13,24544,24235,6071,57
0,4,10,3000,ls_growth,0.01,17,6.74744152324853,6.747441523238584,0.5786711660000001,2012,1.9095836023552692e-13,24402,24011,5926,56
0,4,10,3000,ls_growth,0.01,18,6.74744152324853,6.74744152323859,0.7091402500000004,2095,1.8607337892717624e-13,24527,24142,6045,56
0,4,10,3000,ls_growth,0.01,19,6.74744152324853,6.747441523238584,0.6551875,2068,1.9051427102567686e-13,25009,24618,6224,56
0,4,10,3000,ls_growth,0.01,20,6.74744152324853,6.747441523238586,0.7950933750000003,1988,1.8696155734687636e-13,24170,23842,5724,56
0,4,10,3000,penalty,0.01,1,6.74744152324853,6.920100293624486,0.1292070419999982,663,1.8696155734687636e-13,0,0,0,0
0,4,10,3000,penalty,0.01,2,6.74744152324853,6.747441523238586,0.1575218329999989,912,1.8962609260597674e-13,0,0,0,0
0,4,10,3000,penalty,0.01,3,6.74744152324853,6.747441523238582,0.16110770799999954,955,1.8918200339612667e-13,0,0,0,0
0,4,10,3000,penalty,0.01,4,6.74744152324853,6.747441523238595,0.14696437499999956,935,1.8784973576657649e-13,0,0,0,0
0,4,10,3000,penalty,0.01,5,6.74744152324853,6.747441523238588,0.12523445899999933,1070,1.8740564655672642e-13,0,0,0,0
0,4,10,3000,penalty,0.01,6,6.74744152324853,6.747441523238581,0.12989795800000137,885,1.8784973576657649e-13,0,0,0,0
0,4,10,3000,penalty,0.01,7,6.74744152324853,6.747441523238579,0.12116545799999949,671,1.9051427102567686e-13,0,0,0,0
0,4,10,3000,penalty,0.01,8,6.74744152324853,6.760278777324804,0.08941491699999823,638,1.829647544582258e-13,0,0,0,0
0,4,10,3000,penalty,0.01,9,6.74744152324853,6.8700652018290755,0.16104870799999843,991,1.758593271006248e-13,0,0,0,0
0,4,10,3000,penalty,0.01,10,6.74744152324853,6.747441523238606,0.1917049589999988,1034,1.900701818158268e-13,0,0,0,0
0,4,10,3000,penalty,0.01,11,6.74744152324853,6.870065201829102,0.1524924170000013,958,1.8030021919912542e-13,0,0,0,0
0,4,10,3000,penalty,0.01,12,6.74744152324853,6.8142877380558655,0.11704470800000126,935,1.9229062786507711e-13,0,0,0,0
0,4,10,3000,penalty,0.01,13,6.74744152324853,6.946997199143914,0.08142004200000155,624,1.9273471707492718e-13,0,0,0,0
0,4,10,3000,penalty,0.01,14,6.74744152324853,6.747441523238577,0.16737529099999665,1027,1.865174681370263e-13,0,0,0,0
0,4,10,3000,penalty,0.01,15,6.74744152324853,6.946997199143923,0.09494812499999898,810,1.8562928971732617e-13,0,0,0,0
0,4,10,3000,penalty,0.01,16,6.74744152324853,6.747441523238577,0.1566955420000013,1088,1.900701818158268e-13,0,0,0,0
0,4,10,3000,penalty,0.01,17,6.74744152324853,6.747441523238575,0.13623854100000243,973,1.865174681370263e-13,0,0,0,0
0,4,10,3000,penalty,0.01,18,6.74744152324853,6.760278777324809,0.06511245799999961,424,1.7852386235972517e-13,0,0,0,0
0,4,10,3000,penalty,0.01,19,6.74744152324853,6.747441523238586,0.15902937499999825,960,1.8918200339612667e-13,0,0,0,0
0,4,10,3000,penalty,0.01,20,6.74744152324853,6.760278777324824,0.0744565419999999,374,1.7719159473017498e-13,0,0,0,0
0,0,12,30000,ls_growth,0.01,1,4.029601930116184,4.0296019301164705,0.7617375409999986,2367,1.6653345369377348e-13,30117,29812,7732,56
0,0,12,30000,ls_growth,0.01,2,4.029601930116184,4.029601930116492,0.7055042500000017,2328,1.7363888105137448e-13,29460,29234,7443,53
0,0,12,30000,ls_growth,0.01,3,4.029601930116184,4.02960193011647,0.7886201660000006,2745,1.7896795156957523e-13,29895,29578,7685,55
0,0,12,30000,ls_growth,0.01,4,4.029601930116184,4.029601930116487,0.7512510000000002,2287,1.7852386235972517e-13,29100,28767,7452,52
0,0,12,30000,ls_growth,0.01,5,4.029601930116184,4.029601930116492,0.7703677920000009,2626,1.7896795156957523e-13,29268,28973,7547,53
0,0,12,30000,ls_growth,0.01,6,4.029601930116184,4.029601930116491,0.7252045829999988,2295,1.8252066524837574e-13,29490,29134,7648,55
0,0,12,30000,ls_growth,0.01,7,4.029601930116184,4.0296019301164785,0.7478097080000007,2361,1.687538997430238e-13,30011,29680,7779,53
0,0,12,30000,ls_growth,0.01,8,4.029601930116184,4.029601930116495,0.7706127079999969,2340,1.723066134218243e-13,29692,29336,7542,53
0,0,12,30000,ls_growth,0.01,9,4.029601930116184,4.029601930116485,0.7435198330000021,2338,1.6697754290362354e-13,29628,29284,7496,54
0,0,12,30000,ls_growth,0.01,10,4.029601930116184,4.029601930116483,0.7699256249999998,2344,1.8030021919912542e-13,30017,29673,7648,54
0,0,12,30000,ls_growth,0.01,11,4.029601930116184,4.029601930116481,0.750968667000001,2378,1.745270594710746e-13,30291,29917,7838,55
0,0,12,30000,ls_growth,0.01,12,4.029601930116184,4.029601930116482,0.7497477499999986,2285,1.7674750552032492e-13,29073,28835,7474,53
0,0,12,30000,ls_growth,0.01,13,4.029601930116184,4.029601930116502,0.7679779999999992,2320,1.6830981053317373e-13,29301,28986,7346,53
0,0,12,30000,ls_growth,0.01,14,4.029601930116184,4.029601930116492,0.7611502089999994,2293,1.816324868286756e-13,28927,28710,7460,53
0,0,12,30000,ls_growth,0.01,15,4.029601930116184,4.029601930116483,1.0822437500000015,2293,1.7719159473017498e-13,29194,28865,7521,52
0,0,12,30000,ls_growth,0.01,16,4.029601930116184,4.029601930116478,1.6924228749999966,2388,1.6653345369377348e-13,30456,30134,7648,55
0,0,12,30000,ls_growth,0.01,17,4.029601930116184,4.029601930116483,1.756630250000002,2392,1.6830981053317373e-13,30773,30430,7780,54
0,0,12,30000,ls_growth,0.01,18,4.029601930116184,4.029601930116482,1.9963002080000005,2755,1.674216321134736e-13,29694,29367,7585,55
0,0,12,30000,ls_growth,0.01,19,4.029601930116184,4.029601930116488,1.8828132080000068,2333,1.674216321134736e-13,29571,29268,7729,53
0,0,12,30000,ls_growth,0.01,20,4.029601930116184,4.029601930116498,1.7982475410000043,2403,1.6964207816272392e-13,29890,29582,7617,53
0,0,12,30000,penalty,0.01,1,4.029601930116184,4.029601930116498,0.14940183299999626,350,1.7497114868092467e-13,0,0,0,0
0,0,12,30000,penalty,0.01,2,4.029601930116184,4.029601930116499,0.1369489160000012,348,1.638689184346731e-13,0,0,0,0
0,0,12,30000,penalty,0.01,3,4.029601930116184,4.029601930116499,0.19861074999999984,436,1.709743457922741e-13,0,0,0,0
0,0,12,30000,penalty,0.01,4,4.029601930116184,4.029601930116494,0.5398555420000047,1023,1.7363888105137448e-13,0,0,0,0
0,0,12,30000,penalty,0.01,5,4.029601930116184,4.029601930116442,0.20783233300000575,510,2.842170943040401e-14,0,0,0,0
0,0,12,30000,penalty,0.01,6,4.029601930116184,4.029601930116485,0.331127999999997,621,1.709743457922741e-13,0,0,0,0
0,0,12,30000,penalty,0.01,7,4.029601930116184,4.029601930116485,0.44860975000000325,1150,1.6697754290362354e-13,0,0,0,0
0,0,12,30000,penalty,0.01,8,4.029601930116184,4.029601930116497,0.2938470420000012,561,1.6786572132332367e-13,0,0,0,0
0,0,12,30000,penalty,0.01,9,4.029601930116184,4.0296019301165025,0.2171339999999982,404,1.687538997430238e-13,0,0,0,0
0,0,12,30000,penalty,0.01,10,4.029601930116184,4.236067977499884,0.06759129199999733,323,1.4654943925052066e-14,0,0,0,0
0,0,12,30000,penalty,0.01,11,4.029601930116184,4.113622360487554,0.21438991700000043,502,1.8074430840897548e-13,0,0,0,0
0,0,12,30000,penalty,0.01,12,4.029601930116184,4.029601930116488,0.13749358300000314,366,1.7008616737257398e-13,0,0,0,0
0,0,12,30000,penalty,0.01,13,4.029601930116184,4.029601930116474,0.19188700000000244,474,1.7319479184152442e-13,0,0,0,0
0,0,12,30000,penalty,0.01,14,4.029601930116184,4.02960193011649,0.14780395800000407,356,1.709743457922741e-13,0,0,0,0
0,0,12,30000,penalty,0.01,15,4.029601930116184,4.029601930116488,0.09944716700000572,318,1.5054624213917123e-13,0,0,0,0
0,0,12,30000,penalty,0.01,16,4.029601930116184,4.02960193011648,0.3228266670000012,857,1.674216321134736e-13,0,0,0,0
0,0,12,30000,penalty,0.01,17,4.029601930116184,4.236067977499879,0.11713133399999788,388,1.021405182655144e-14,0,0,0,0
0,0,12,30000,penalty,0.01,18,4.029601930116184,4.02960193011649,0.17965195799999492,362,1.6475709685437323e-13,0,0,0,0
0,0,12,30000,penalty,0.01,19,4.029601930116184,4.02960193011649,0.18749058299999888,392,1.6786572132332367e-13,0,0,0,0
0,0,12,30000,penalty,0.01,20,4.029601930116184,4.029601930116492,0.18848937500000465,483,1.7319479184152442e-13,0,0,0,0
0,0,19,3000,ls_growth,0.01,1,4.863703305156274,4.86370330515665,2.140560666,2733,1.6786572132332367e-13,42213,41889,10765,49
0,0,19,3000,ls_growth,0.01,2,4.863703305156274,4.863703305156646,2.2681318749999995,2847,1.8474111129762605e-13,42998,42699,11197,50
0,0,19,3000,ls_growth,0.01,3,4.863703305156274,4.863703305156662,2.1056490830000003,2749,1.8740564655672642e-13,42469,42125,11085,48
0,0,19,3000,ls_growth,0.01,4,4.863703305156274,4.863703305156669,2.1865771670000003,2919,1.8207657603852567e-13,42859,42509,11075,49
0,0,19,3000,ls_growth,0.01,5,4.863703305156274,4.863703305156643,2.099741916000001,2801,1.8074430840897548e-13,42785,42469,11070,49
0,0,19,3000,ls_growth,0.01,6,4.863703305156274,4.863703305156654,2.1278685000000004,2753,1.7852386235972517e-13,42549,42195,10957,49
0,0,19,3000,ls_growth,0.01,7,4.863703305156274,4.863703305156642,2.032128499999999,2772,1.780797731498751e-13,42841,42560,11003,49
0,0,19,3000,ls_growth,0.01,8,4.863703305156274,4.863703305156665,1.944557375000002,2774,1.829647544582258e-13,42863,42600,11268,49
0,0,19,3000,ls_growth,0.01,9,4.863703305156274,4.863703305156635,1.7668674580000006,2792,1.7674750552032492e-13,43184,42850,11178,51
0,0,19,3000,ls_growth,0.01,10,4.863703305156274,4.863703305156639,1.769232,2773,1.8429702208777599e-13,42875,42577,11098,50
0,0,19,3000,ls_growth,0.01,11,4.863703305156274,4.863703305156648,1.7433070420000003,2752,1.8340884366807586e-13,42527,42179,11045,49
0,0,19,3000,ls_growth,0.01,12,4.863703305156274,4.86370330515666,1.6492555409999987,2756,1.8562928971732617e-13,42574,42259,11177,49
0,0,19,3000,ls_growth,0.01,13,4.863703305156274,4.863703305156646,1.732367291999999,2753,1.7896795156957523e-13,42541,42241,11225,49
0,0,19,3000,ls_growth,0.01,14,4.863703305156274,4.863703305156665,1.771680542000002,2792,1.8118839761882555e-13,43180,42853,11230,50
0,0,19,3000,ls_growth,0.01,15,4.863703305156274,4.863703305156649,1.7535715839999975,2763,1.8118839761882555e-13,42696,42364,11143,48
0,0,19,3000,ls_growth,0.01,16,4.863703305156274,4.863703305156651,1.7457245409999995,2769,1.851852005074761e-13,42812,42518,10989,49
0,0,19,3000,ls_growth,0.01,17,4.863703305156274,4.863703305156655,2.8849313750000003,2786,1.8030021919912542e-13,43079,42765,11142,50
0,0,19,3000,ls_growth,0.01,18,4.863703305156274,4.863703305156668,3.8970454159999934,2825,1.8340884366807586e-13,43181,42882,11152,50
0,0,19,3000,ls_growth,0.01,19,4.863703305156274,4.863703305156662,4.271569667000003,2739,1.8385293287792592e-13,42309,41976,10775,48
0,0,19,3000,ls_growth,0.01,20,4.863703305156274,4.863703305156668,3.8985666670000065,2789,1.8829382497642655e-13,43113,42825,11236,50
0,0,19,3000,penalty,0.01,1,4.863703305156274,4.863703305156658,0.3934403749999983,454,1.8474111129762605e-13,0,0,0,0
0,0,19,3000,penalty,0.01,2,4.863703305156274,4.863703305156644,0.472755541999999,538,1.8740564655672642e-13,0,0,0,0
0,0,19,3000,penalty,0.01,3,4.863703305156274,4.863703305156645,0.5249551250000004,531,1.816324868286756e-13,0,0,0,0
0,0,19,3000,penalty,0.01,4,4.863703305156274,4.863703305156667,0.6430669169999965,601,1.8429702208777599e-13,0,0,0,0
0,0,19,3000,penalty,0.01,5,4.863703305156274,4.863703305156679,0.20771437499999593,340,1.7719159473017498e-13,0,0,0,0
0,0,19,3000,penalty,0.01,6,4.863703305156274,4.863703305156662,0.5108139579999988,561,1.7896795156957523e-13,0,0,0,0
0,0,19,3000,penalty,0.01,7,4.863703305156274,4.863703305156658,0.2602260830000014,317,1.8562928971732617e-13,0,0,0,0
0,0,19,3000,penalty,0.01,8,4.863703305156274,4.86370330515667,0.4647049590000024,472,1.8340884366807586e-13,0,0,0,0
0,0,19,3000,penalty,0.01,9,4.863703305156274,5.493959207435053,0.2062878750000018,293,4.440892098500626e-16,0,0,0,0
0,0,19,3000,penalty,0.01,10,4.863703305156274,4.863703305156643,0.40900074999999925,454,1.7719159473017498e-13,0,0,0,0
0,0,19,3000,penalty,0.01,11,4.863703305156274,4.863703305156649,0.35951124999999595,425,1.900701818158268e-13,0,0,0,0
0,0,19,3000,penalty,0.01,12,4.863703305156274,4.863703305156651,0.34698729099999764,428,1.8696155734687636e-13,0,0,0,0
0,0,19,3000,penalty,0.01,13,4.863703305156274,5.178581468860583,0.20706149999999615,300,6.661338147750939e-15,0,0,0,0
0,0,19,3000,penalty,0.01,14,4.863703305156274,4.86370330515667,0.4401562080000003,554,1.887379141862766e-13,0,0,0,0
0,0,19,3000,penalty,0.01,15,4.863703305156274,5.178581468860475,0.1686710000000021,362,8.43769498715119e-15,0,0,0,0
0,0,19,3000,penalty,0.01,16,4.863703305156274,4.863703305156646,0.23984729099999821,346,1.7674750552032492e-13,0,0,0,0
0,0,19,3000,penalty,0.01,17,4.863703305156274,4.863703305156659,0.4509739999999947,652,1.8429702208777599e-13,0,0,0,0
0,0,19,3000,penalty,0.01,18,4.863703305156274,4.8637033051566565,0.3630864999999976,568,1.8340884366807586e-13,0,0,0,0
0,0,19,3000,penalty,0.01,19,4.863703305156274,5.100822655218623,0.9179741250000006,1260,1.7319479184152442e-13,0,0,0,0
0,0,19,3000,penalty,0.01,20,4.863703305156274,4.8637033051566405,0.39492374999999447,485,1.745270594710746e-13,0,0,0,0
0,4,10,30000,ls_growth,0.01,1,6.74744152324853,6.747441523238584,0.6556844170000004,2029,1.91402449445377e-13,25339,24984,6079,56
0,4,10,30000,ls_growth,0.01,2,6.74744152324853,6.747441523238579,0.6848919590000005,2010,1.865174681370263e-13,24127,23806,5950,55
0,4,10,30000,ls_growth,0.01,3,6.74744152324853,6.747441523238578,1.1627204170000005,2155,1.8118839761882555e-13,24421,24133,5802,55
0,4,10,30000,ls_growth,0.01,4,6.74744152324853,6.76027877732484,1.5987541659999989,1820,1.8385293287792592e-13,27583,27318,6932,58
0,4,10,30000,ls_growth,0.01,5,6.74744152324853,6.747441523238602,1.576103624999996,2106,1.8740564655672642e-13,24183,23797,5837,54
0,4,10,30000,ls_growth,0.01,6,6.74744152324853,6.760278777324809,1.2619048750000001,1836,1.7763568394002505e-13,27319,27043,6908,58
0,4,10,30000,ls_growth,0.01,7,6.74744152324853,6.747441523238579,1.726609375,2103,1.8562928971732617e-13,24144,23858,5763,55
0,4,10,30000,ls_growth,0.01,8,6.74744152324853,6.760278777324807,1.5002480419999993,1759,1.8074430840897548e-13,26626,26244,6555,56
0,4,10,30000,ls_growth,0.01,9,6.74744152324853,6.760278777324812,1.3673163750000021,1848,1.6209256159527285e-13,27268,27001,6784,57
0,4,10,30000,ls_growth,0.01,10,6.74744152324853,6.767102139331925,1.2361960000000036,1883,1.8696155734687636e-13,24277,23922,6133,55
0,4,10,30000,ls_growth,0.01,11,6.74744152324853,6.760278777324825,1.3100803339999985,1799,1.8918200339612667e-13,27259,26950,6651,56
0,4,10,30000,ls_growth,0.01,12,6.74744152324853,6.747441523238595,1.576581917000003,2167,1.8607337892717624e-13,25228,24864,6136,58
0,4,10,30000,ls_growth,0.01,13,6.74744152324853,6.747441523238589,1.3010502080000006,2087,1.8607337892717624e-13,25201,24915,5850,56
0,4,10,30000,ls_growth,0.01,14,6.74744152324853,6.760278777324825,1.2686527080000014,1816,1.8562928971732617e-13,27540,27128,6897,58
0,4,10,30000,ls_growth,0.01,15,6.74744152324853,6.747478422980431,1.7840948329999955,1864,1.8918200339612667e-13,24823,24422,5791,56
0,4,10,30000,ls_growth,0.01,16,6.74744152324853,6.74744152323859,1.2712194159999999,2076,1.8784973576657649e-13,24544,24235,6071,57
0,4,10,30000,ls_growth,0.01,17,6.74744152324853,6.747441523238584,0.9494901249999966,2012,1.9095836023552692e-13,24402,24011,5926,56
0,4,10,30000,ls_growth,0.01,18,6.74744152324853,6.74744152323859,1.2193290000000052,2095,1.8607337892717624e-13,24527,24142,6045,56
0,4,10,30000,ls_growth,0.01,19,6.74744152324853,6.747441523238584,1.0331957080000065,2068,1.9051427102567686e-13,25009,24618,6224,56
0,4,10,30000,ls_growth,0.01,20,6.74744152324853,6.747441523238586,1.1542768750000032,1988,1.8696155734687636e-13,24170,23842,5724,56
0,4,10,30000,penalty,0.01,1,6.74744152324853,6.920100293624486,0.15341449999999895,663,1.8696155734687636e-13,0,0,0,0
0,4,10,30000,penalty,0.01,2,6.74744152324853,6.747441523238586,0.20266937500000495,912,1.8962609260597674e-13,0,0,0,0
0,4,10,30000,penalty,0.01,3,6.74744152324853,6.747441523238582,0.21710216599999693,955,1.8918200339612667e-13,0,0,0,0
0,4,10,30000,penalty,0.01,4,6.74744152324853,6.747441523238595,0.2734177500000005,935,1.8784973576657649e-13,0,0,0,0
0,4,10,30000,penalty,0.01,5,6.74744152324853,6.747441523238588,0.14755720799999836,1070,1.8740564655672642e-13,0,0,0,0
0,4,10,30000,penalty,0.01,6,6.74744152324853,6.747441523238581,0.15764833300000464,885,1.8784973576657649e-13,0,0,0,0
0,4,10,30000,penalty,0.01,7,6.74744152324853,6.747441523238579,0.13866799999999785,671,1.9051427102567686e-13,0,0,0,0
0,4,10,30000,penalty,0.01,8,6.74744152324853,6.760278777324804,0.10834041699999944,638,1.829647544582258e-13,0,0,0,0
0,4,10,30000,penalty,0.01,9,6.74744152324853,6.8700652018290755,0.13769795899999734,991,1.758593271006248e-13,0,0,0,0
0,4,10,30000,penalty,0.01,10,6.74744152324853,6.747441523238606,0.15988416699999652,1034,1.900701818158268e-13,0,0,0,0
0,4,10,30000,penalty,0.01,11,6.74744152324853,6.870065201829102,0.15158933300000355,958,1.8030021919912542e-13,0,0,0,0
0,4,10,30000,penalty,0.01,12,6.74744152324853,6.8142877380558655,0.13651533300000301,935,1.9229062786507711e-13,0,0,0,0
0,4,10,30000,penalty,0.01,13,6.74744152324853,6.946997199143914,0.09082287499999803,624,1.9273471707492718e-13,0,0,0,0
0,4,10,30000,penalty,0.01,14,6.74744152324853,6.747441523238577,0.2034349169999987,1027,1.865174681370263e-13,0,0,0,0
0,4,10,30000,penalty,0.01,15,6.74744152324853,6.946997199143923,0.09081575000000157,810,1.8562928971732617e-13,0,0,0,0
0,4,10,30000,penalty,0.01,16,6.74744152324853,6.747441523238577,0.18789083299999765,1088,1.900701818158268e-13,0,0,0,0
0,4,10,30000,penalty,0.01,17,6.74744152324853,6.747441523238575,0.16375483300000632,973,1.865174681370263e-13,0,0,0,0
0,4,10,30000,penalty,0.01,18,6.74744152324853,6.760278777324809,0.0816304999999993,424,1.7852386235972517e-13,0,0,0,0
0,4,10,30000,penalty,0.01,19,6.74744152324853,6.747441523238586,0.14428754199999821,960,1.8918200339612667e-13,0,0,0,0
0,4,10,30000,penalty,0.01,20,6.74744152324853,6.760278777324824,0.06279762499999925,374,1.7719159473017498e-13,0,0,0,0
0,0,19,3000,ls_growth,0.001,1,4.863703305156274,4.863703305156643,2.6889808750000013,2844,1.745270594710746e-13,43184,39963,10430,3
0,0,19,3000,ls_growth,0.001,2,4.863703305156274,4.863703305156659,1.9105676669999958,2841,1.8385293287792592e-13,43184,39884,10261,3
0,0,19,3000,ls_growth,0.001,3,4.863703305156274,4.8637033051566405,1.9293202080000047,2835,1.8030021919912542e-13,43184,39771,10304,3
0,0,19,3000,ls_growth,0.001,4,4.863703305156274,4.863703305156642,1.749827416,2836,1.7630341631047486e-13,43184,39789,10001,3
0,0,19,3000,ls_growth,0.001,5,4.863703305156274,4.863703305156665,1.727234375,2851,1.8696155734687636e-13,43184,39836,10354,3
0,0,19,3000,ls_growth,0.001,6,4.863703305156274,4.863703305156669,1.7414674589999923,2841,1.8607337892717624e-13,43184,39622,10220,3
0,0,19,3000,ls_growth,0.001,7,4.863703305156274,4.863703305156643,1.4472037909999926,2396,1.8030021919912542e-13,36064,33386,8606,3
0,0,19,3000,ls_growth,0.001,8,4.863703305156274,4.863703305156665,1.797182541999995,2850,1.8030021919912542e-13,43184,40240,10409,3
0,0,19,3000,ls_growth,0.001,9,4.863703305156274,4.863703305156651,1.6446509159999987,2844,1.8340884366807586e-13,43184,39883,10386,3
0,0,19,3000,ls_growth,0.001,10,4.863703305156274,4.863703305156651,1.712678,2856,1.8429702208777599e-13,43184,40252,10388,3
0,0,19,3000,ls_growth,0.001,11,4.863703305156274,4.8637033051566725,1.7610694579999981,2834,1.8696155734687636e-13,43184,39653,10304,3
0,0,19,3000,ls_growth,0.001,12,4.863703305156274,4.863703305156639,1.6323706249999959,2540,1.816324868286756e-13,38016,34649,9001,2
0,0,19,3000,ls_growth,0.001,13,4.863703305156274,4.86370330515666,1.641729833000005,2482,1.8918200339612667e-13,36720,33296,8552,2
0,0,19,3000,ls_growth,0.001,14,4.863703305156274,4.863703305156672,1.7327295000000014,2836,1.887379141862766e-13,43184,39616,10283,3
0,0,19,3000,ls_growth,0.001,15,4.863703305156274,4.863703305156648,1.7595033339999937,2840,1.8696155734687636e-13,43184,39974,10429,3
0,0,19,3000,ls_growth,0.001,16,4.863703305156274,4.863703305156639,1.7190225000000063,2840,1.8385293287792592e-13,43184,39944,10153,3
0,0,19,3000,ls_growth,0.001,17,4.863703305156274,4.863703305156655,1.6512425000000075,2846,1.816324868286756e-13,43184,39985,10357,3
0,0,19,3000,ls_growth,0.001,18,4.863703305156274,4.863703305156651,1.5262951659999962,2546,1.8207657603852567e-13,38064,34833,9069,2
0,0,19,3000,ls_growth,0.001,19,4.863703305156274,4.86370330515665,1.6245925419999985,2842,1.8118839761882555e-13,43184,39824,10341,3
0,0,19,3000,ls_growth,0.001,20,4.863703305156274,4.863703305156659,1.477289042000004,2660,1.829647544582258e-13,39984,37147,9713,2
0,0,19,3000,ls_growth,0.1,1,4.863703305156274,4.863703305156662,0.23123833300000116,469,1.8385293287792592e-13,5977,5959,1611,70
0,0,19,3000,ls_growth,0.1,2,4.863703305156274,4.863703305156672,0.24507604099999297,523,1.7896795156957523e-13,6075,6054,1607,69
0,0,19,3000,ls_growth,0.1,3,4.863703305156274,4.863703305156667,0.23240308400000503,478,1.7896795156957523e-13,6150,6123,1659,71
0,0,19,3000,ls_growth,0.1,4,4.863703305156274,4.863703305156655,0.22476495900000737,467,1.8829382497642655e-13,5978,5947,1582,69
0,0,19,3000,ls_growth,0.1,5,4.863703305156274,4.8637033051566405,0.2698559580000001,477,1.8429702208777599e-13,6141,6112,1623,71
0,0,19,3000,ls_growth,0.1,6,4.863703305156274,4.8637033051566645,0.24778804200000012,476,1.8740564655672642e-13,5852,5814,1401,71
0,0,19,3000,ls_growth,0.1,7,4.863703305156274,4.863703305156666,0.2533112079999992,486,1.8074430840897548e-13,6275,6249,1627,74
0,0,19,3000,ls_growth,0.1,8,4.863703305156274,4.86370330515667,0.24391337500000373,481,1.851852005074761e-13,6194,6168,1636,72
0,0,19,3000,ls_growth,0.1,9,4.863703305156274,4.863703305156642,0.25226304200000593,507,1.780797731498751e-13,6603,6573,1776,76
0,0,19,3000,ls_growth,0.1,10,4.863703305156274,4.863703305156676,0.23625354200000584,468,1.8385293287792592e-13,5972,5951,1586,70
0,0,19,3000,ls_growth,0.1,11,4.863703305156274,4.863703305156644,0.2618935419999907,469,1.8784973576657649e-13,6004,5979,1641,70
0,0,19,3000,ls_growth,0.1,12,4.863703305156274,4.863703305156649,0.28347962500000723,473,1.7497114868092467e-13,6076,6050,1617,70
0,0,19,3000,ls_growth,0.1,13,4.863703305156274,5.099682709790221,0.6577125830000005,919,1.7630341631047486e-13,6519,6483,1771,72
0,0,19,3000,ls_growth,0.1,14,4.863703305156274,4.863703305156676,0.28031837500000256,555,1.8562928971732617e-13,6604,6582,1697,75
0,0,19,3000,ls_growth,0.1,15,4.863703305156274,5.090897789666707,0.49879391699998815,699,1.7408297026122455e-13,6290,6268,1771,73
0,0,19,3000,ls_growth,0.1,16,4.863703305156274,5.125622177271205,0.6002520829999994,821,1.7719159473017498e-13,5367,5344,1431,69
0,0,19,3000,ls_growth,0.1,17,4.863703305156274,4.863703305156665,0.25115016699999976,482,1.7763568394002505e-13,6216,6192,1682,72
0,0,19,3000,ls_growth,0.1,18,4.863703305156274,4.863703305156665,0.2562857090000034,514,1.8784973576657649e-13,6197,6169,1545,72
0,0,19,3000,ls_growth,0.1,19,4.863703305156274,4.863703305156649,0.26593441699999676,530,1.745270594710746e-13,6708,6682,1621,76
0,0,19,3000,ls_growth,0.1,20,4.863703305156274,4.863703305156665,0.29763337500000486,476,1.8474111129762605e-13,6111,6084,1556,72
0,4,20,3000,ls_growth,0.01,1,8.978083352860407,8.978083352831518,4.791895541999998,3000,8.881784197001252e-16,43184,42938,11100,48
0,4,20,3000,ls_growth,0.01,2,8.978083352860407,9.14317646724699,3.543903750000005,3000,3.552713678800501e-15,43184,42948,11330,48
0,4,20,3000,ls_growth,0.01,3,8.978083352860407,8.97808335283896,3.1653642080000064,3000,2.842170943040401e-14,43174,42979,11518,48
0,4,20,3000,ls_growth,0.01,4,8.978083352860407,8.978083352828799,2.385556875000002,3000,2.5757174171303632e-14,43184,42950,11372,47
0,4,20,3000,ls_growth,0.01,5,8.978083352860407,8.978083352835196,2.355374084000003,3000,2.6645352591003757e-15,43184,42927,11480,47
0,4,20,3000,ls_growth,0.01,6,8.978083352860407,8.978083352831467,2.201158958,3000,1.3322676295501878e-15,43184,42982,11863,48
0,4,20,3000,ls_growth,0.01,7,8.978083352860407,8.97808335283058,2.203462832999998,3000,2.930988785010413e-14,43184,42980,11343,48
0,4,20,3000,ls_growth,0.01,8,8.978083352860407,8.978083352833183,2.215747583999997,3000,1.7763568394002505e-15,42675,42415,11163,46
0,4,20,3000,ls_growth,0.01,9,8.978083352860407,8.978083352840672,2.1608408749999946,3000,8.881784197001252e-15,43184,42923,11538,47
0,4,20,3000,ls_growth,0.01,10,8.978083352860407,8.97808335282959,2.285308334000001,3000,5.329070518200751e-15,43184,42900,11368,48
0,4,20,3000,ls_growth,0.01,11,8.978083352860407,8.978083352837528,2.332360750000007,3000,2.1760371282653068e-14,43184,42951,11557,47
0,4,20,3000,ls_growth,0.01,12,8.978083352860407,8.978083352842082,2.201902124999993,3000,1.8207657603852567e-14,43168,42934,11498,47
0,4,20,3000,ls_growth,0.01,13,8.978083352860407,9.143950333040001,2.275784916999997,3000,2.042810365310288e-14,42149,41935,11361,46
0,4,20,3000,ls_growth,0.01,14,8.978083352860407,8.9780833528309,2.252608666999993,3000,1.9095836023552692e-14,43184,42957,11233,48
0,4,20,3000,ls_growth,0.01,15,8.978083352860407,9.143176467254996,2.0609341669999997,3000,6.661338147750939e-15,43184,42958,11297,48
0,4,20,3000,ls_growth,0.01,16,8.978083352860407,8.978083352827868,2.1576153339999875,3000,4.440892098500626e-15,42676,42476,11448,47
0,4,20,3000,ls_growth,0.01,17,8.978083352860407,8.978083352836489,1.973625291999997,3000,6.128431095930864e-14,43184,42954,11454,48
0,4,20,3000,ls_growth,0.01,18,8.978083352860407,8.978083352830355,2.0218720420000027,3000,9.769962616701378e-15,43178,42954,11403,47
0,4,20,3000,ls_growth,0.01,19,8.978083352860407,8.978083352829374,2.219247291000007,3000,1.4654943925052066e-14,43179,42933,11403,47
0,4,20,3000,ls_growth,0.01,20,8.978083352860407,8.978083352842562,2.3069764580000047,3000,5.773159728050814e-15,43184,42926,11522,48
0,4,20,3000,penalty,0.01,1,8.978083352860407,8.97808335282244,0.8233081669999955,1358,1.8030021919912542e-13,0,0,0,0
0,4,20,3000,penalty,0.01,2,8.978083352860407,9.14859344917994,0.831468916999991,1389,1.900701818158268e-13,0,0,0,0
0,4,20,3000,penalty,0.01,3,8.978083352860407,9.2478852834849,1.0062589169999991,1652,1.9229062786507711e-13,0,0,0,0
0,4,20,3000,penalty,0.01,4,8.978083352860407,9.306873805190689,0.9323642909999907,1552,1.509903313490213e-14,0,0,0,0
0,4,20,3000,penalty,0.01,5,8.978083352860407,8.978083352822468,0.4376984999999986,818,1.9584334154387761e-13,0,0,0,0
0,4,20,3000,penalty,0.01,6,8.978083352860407,9.283936011913566,0.8061846670000087,1544,1.8074430840897548e-13,0,0,0,0
0,4,20,3000,penalty,0.01,7,8.978083352860407,8.978083352822466,0.4525478340000118,717,1.9451107391432743e-13,0,0,0,0
0,4,20,3000,penalty,0.01,8,8.978083352860407,9.143950313706759,1.030994916999989,1741,1.9273471707492718e-13,0,0,0,0
0,4,20,3000,penalty,0.01,9,8.978083352860407,8.978083352822468,0.6007181249999994,1052,1.9628743075372768e-13,0,0,0,0
0,4,20,3000,penalty,0.01,10,8.978083352860407,8.978083352822463,0.5678470830000005,1063,1.9406698470447736e-13,0,0,0,0
0,4,20,3000,penalty,0.01,11,8.978083352860407,9.398937895014326,0.5980924159999995,1069,1.9584334154387761e-13,0,0,0,0
0,4,20,3000,penalty,0.01,12,8.978083352860407,9.149180438652767,1.0701007499999977,1723,1.9673151996357774e-13,0,0,0,0
0,4,20,3000,penalty,0.01,13,8.978083352860407,8.978083352822441,0.4611687919999968,894,1.8385293287792592e-13,0,0,0,0
0,4,20,3000,penalty,0.01,14,8.978083352860407,9.436313375126955,0.7852544999999954,1244,1.9406698470447736e-13,0,0,0,0
0,4,20,3000,penalty,0.01,15,8.978083352860407,8.978083352822454,0.3612959580000024,761,1.9584334154387761e-13,0,0,0,0
0,4,20,3000,penalty,0.01,16,8.978083352860407,9.14859344917997,0.813400667000009,1397,1.9051427102567686e-13,0,0,0,0
0,4,20,3000,penalty,0.01,17,8.978083352860407,9.29632652524442,0.6845778750000027,1301,1.949551631241775e-13,0,0,0,0
0,4,20,3000,penalty,0.01,18,8.978083352860407,8.978083352822456,0.8382193339999939,1498,1.9184653865522705e-13,0,0,0,0
0,4,20,3000,penalty,0.01,19,8.978083352860407,9.370752588260546,0.7274390839999978,1346,1.9229062786507711e-13,0,0,0,0
0,4,20,3000,penalty,0.01,20,8.978083352860407,8.978083352822473,0.4666346669999912,850,1.9539925233402755e-13,0,0,0,0
0,0,30,3000,ls_growth,0.01,1,6.197741070879227,6.197800324417046,4.325855209,3000,9.325873406851315e-15,43184,42944,12769,32
0,0,30,3000,ls_growth,0.01,2,6.197741070879227,6.197790192738953,7.923927375,3000,9.325873406851315e-15,43184,42933,12625,32
0,0,30,3000,ls_growth,0.01,3,6.197741070879227,6.197741184705744,4.197335666999999,3000,6.217248937900877e-15,43184,42957,12675,32
0,0,30,3000,ls_growth,0.01,4,6.197741070879227,6.197896722547087,5.095142041999999,3000,8.43769498715119e-15,43184,42925,12726,32
0,0,30,3000,ls_growth,0.01,5,6.197741070879227,6.19774457617916,4.421594249999998,3000,0,43184,42928,12723,32
0,0,30,3000,ls_growth,0.01,6,6.197741070879227,6.199725989177511,5.475762500000001,3000,2.6645352591003757e-15,43184,42963,12808,32
0,0,30,3000,ls_growth,0.01,7,6.197741070879227,6.199735513076979,13.253998999999997,3000,2.3092638912203256e-14,43184,42905,12769,32
0,0,30,3000,ls_growth,0.01,8,6.197741070879227,6.198099368082582,9.987056040999995,3000,1.3322676295501878e-15,43184,42951,12667,32
0,0,30,3000,ls_growth,0.01,9,6.197741070879227,6.19780113070261,7.370482625000005,3000,8.881784197001252e-16,43184,42964,12573,32
0,0,30,3000,ls_growth,0.01,10,6.197741070879227,6.197832999199291,5.309811165999992,3000,3.9968028886505635e-15,43184,42935,12777,32
0,0,30,3000,ls_growth,0.01,11,6.197741070879227,6.197775601949032,6.539103208,3000,1.2434497875801753e-14,43184,42937,12600,32
0,0,30,3000,ls_growth,0.01,12,6.197741070879227,6.197741119913727,3.9524477920000063,3000,5.329070518200751e-15,43184,42925,12720,32
0,0,30,3000,ls_growth,0.01,13,6.197741070879227,6.197909538874806,4.806318417000003,3000,1.7763568394002505e-15,43184,42931,12665,32
0,0,30,3000,ls_growth,0.01,14,6.197741070879227,6.1990836393658855,5.311556082999989,3000,0,43184,42915,12649,32
0,0,30,3000,ls_growth,0.01,15,6.197741070879227,6.197758282470479,4.7975516249999925,3000,7.993605777301127e-15,43184,42949,12639,32
0,0,30,3000,ls_growth,0.01,16,6.197741070879227,6.197771295311551,7.063080625000002,3000,3.8191672047105385e-14,43184,42919,12549,32
0,0,30,3000,ls_growth,0.01,17,6.197741070879227,6.198366694197571,5.218156499999997,3000,0,43184,42962,12840,32
0,0,30,3000,ls_growth,0.01,18,6.197741070879227,6.19780270991236,7.0611805840000015,3000,5.773159728050814e-15,43184,42920,12685,32
0,0,30,3000,ls_growth,0.01,19,6.197741070879227,6.1977418837651195,7.000508749999994,3000,5.329070518200751e-15,43184,42947,12721,32
0,0,30,3000,ls_growth,0.01,20,6.197741070879227,6.199860798069976,7.135551292000004,3000,4.884981308350689e-15,43184,42939,12662,32
0,0,19,30000,ls_growth,0.01,1,4.863703305156274,4.863703305156657,1.9418763750000072,2952,1.8962609260597674e-13,45715,45391,12100,52
0,0,19,30000,ls_growth,0.01,2,4.863703305156274,4.863703305156645,1.998028792000012,3055,1.8429702208777599e-13,46326,46027,12433,54
0,0,19,30000,ls_growth,0.01,3,4.863703305156274,4.863703305156661,2.0200935420000024,2948,1.8696155734687636e-13,45646,45302,12183,52
0,0,19,30000,ls_growth,0.01,4,4.863703305156274,4.863703305156669,2.004275125,3150,1.8118839761882555e-13,46527,46177,12426,55
0,0,19,30000,ls_growth,0.01,5,4.863703305156274,4.863703305156642,1.9492642090000007,3047,1.8030021919912542e-13,46707,46391,12321,54
0,0,19,30000,ls_growth,0.01,6,4.863703305156274,4.863703305156654,1.8979610419999953,2934,1.7852386235972517e-13,45433,45079,12127,53
0,0,19,30000,ls_growth,0.01,7,4.863703305156274,4.863703305156641,1.9131799160000083,2966,1.780797731498751e-13,45938,45657,12102,53
0,0,19,30000,ls_growth,0.01,8,4.863703305156274,4.863703305156665,1.9034186659999976,2992,1.8252066524837574e-13,46362,46099,12219,54
0,0,19,30000,ls_growth,0.01,9,4.863703305156274,4.863703305156635,1.9916337090000016,2947,1.7719159473017498e-13,45636,45302,12117,52
0,0,19,30000,ls_growth,0.01,10,4.863703305156274,4.863703305156637,1.915696167000002,2941,1.8474111129762605e-13,45540,45242,11985,52
0,0,19,30000,ls_growth,0.01,11,4.863703305156274,4.863703305156648,1.9754256659999956,3004,1.8385293287792592e-13,46547,46199,12319,54
0,0,19,30000,ls_growth,0.01,12,4.863703305156274,4.863703305156661,1.9174107499999955,2967,1.851852005074761e-13,45964,45649,12253,54
0,0,19,30000,ls_growth,0.01,13,4.863703305156274,4.863703305156646,2.3156195829999926,3021,1.7896795156957523e-13,46826,46526,12585,55
0,0,19,30000,ls_growth,0.01,14,4.863703305156274,4.863703305156665,2.0270152499999967,2931,1.8252066524837574e-13,45378,45051,12027,52
0,0,19,30000,ls_growth,0.01,15,4.863703305156274,4.86370330515666,2.161160584000012,3004,1.816324868286756e-13,46556,46224,12426,54
0,0,19,30000,ls_growth,0.01,16,4.863703305156274,4.863703305156651,2.145590542000005,3023,1.851852005074761e-13,46856,46562,12300,54
0,0,19,30000,ls_growth,0.01,17,4.863703305156274,4.863703305156655,2.3754882499999947,2974,1.8074430840897548e-13,46067,45753,12089,53
0,0,19,30000,ls_growth,0.01,18,4.863703305156274,4.863703305156668,2.343173542000004,2962,1.8340884366807586e-13,45344,45045,12097,52
0,0,19,30000,ls_growth,0.01,19,4.863703305156274,4.8637033051566405,2.320597084000008,2967,1.7896795156957523e-13,45956,45623,12048,53
0,0,19,30000,ls_growth,0.01,20,4.863703305156274,4.863703305156668,2.0893552500000223,2986,1.8829382497642655e-13,46253,45965,12204,54
0,0,19,30000,penalty,0.01,1,4.863703305156274,4.863703305156658,0.20886250000001746,454,1.8474111129762605e-13,0,0,0,0
0,0,19,30000,penalty,0.01,2,4.863703305156274,4.863703305156644,0.21725883299999987,538,1.8740564655672642e-13,0,0,0,0
0,0,19,30000,penalty,0.01,3,4.863703305156274,4.863703305156645,0.2596719999999914,531,1.816324868286756e-13,0,0,0,0
0,0,19,30000,penalty,0.01,4,4.863703305156274,4.863703305156667,0.30446462499999327,601,1.8429702208777599e-13,0,0,0,0
0,0,19,30000,penalty,0.01,5,4.863703305156274,4.863703305156679,0.11736875000002328,340,1.7719159473017498e-13,0,0,0,0
0,0,19,30000,penalty,0.01,6,4.863703305156274,4.863703305156662,0.24057037500001024,561,1.7896795156957523e-13,0,0,0,0
0,0,19,30000,penalty,0.01,7,4.863703305156274,4.863703305156658,0.11506570800000918,317,1.8562928971732617e-13,0,0,0,0
0,0,19,30000,penalty,0.01,8,4.863703305156274,4.86370330515667,0.2102412089999998,472,1.8340884366807586e-13,0,0,0,0
0,0,19,30000,penalty,0.01,9,4.863703305156274,5.493959207435053,0.10296408299999894,293,4.440892098500626e-16,0,0,0,0
0,0,19,30000,penalty,0.01,10,4.863703305156274,4.863703305156643,0.17094691699999384,454,1.7719159473017498e-13,0,0,0,0
0,0,19,30000,penalty,0.01,11,4.863703305156274,4.863703305156649,0.16805404099999577,425,1.900701818158268e-13,0,0,0,0
0,0,19,30000,penalty,0.01,12,4.863703305156274,4.863703305156651,0.1577349159999867,428,1.8696155734687636e-13,0,0,0,0
0,0,19,30000,penalty,0.01,13,4.863703305156274,5.178581468860583,0.08957408300001407,300,6.661338147750939e-15,0,0,0,0
0,0,19,30000,penalty,0.01,14,4.863703305156274,4.86370330515667,0.2398734579999873,554,1.887379141862766e-13,0,0,0,0
0,0,19,30000,penalty,0.01,15,4.863703305156274,5.178581468860475,0.10587379099999089,362,8.43769498715119e-15,0,0,0,0
0,0,19,30000,penalty,0.01,16,4.863703305156274,4.863703305156646,0.12669308299999102,346,1.7674750552032492e-13,0,0,0,0
0,0,19,30000,penalty,0.01,17,4.863703305156274,4.863703305156659,0.3118024580000201,652,1.8429702208777599e-13,0,0,0,0
0,0,19,30000,penalty,0.01,18,4.863703305156274,4.8637033051566565,0.29571875,568,1.8340884366807586e-13,0,0,0,0
0,0,19,30000,penalty,0.01,19,4.863703305156274,5.100822655218623,0.6690235420000099,1260,1.7319479184152442e-13,0,0,0,0
0,0,19,30000,penalty,0.01,20,4.863703305156274,4.8637033051566405,0.22311712499998976,485,1.745270594710746e-13,0,0,0,0
0,0,30,3000,penalty,0.01,1,6.197741070879227,6.342710588128921,1.2761319579999981,1265,1.8118839761882555e-13,0,0,0,0
0,0,30,3000,penalty,0.01,2,6.197741070879227,6.197741070879715,3.311996250000011,2319,4.263256414560601e-14,0,0,0,0
0,0,30,3000,penalty,0.01,3,6.197741070879227,6.201217270889367,2.362215750000003,1967,1.6919798895287386e-13,0,0,0,0
0,0,30,3000,penalty,0.01,4,6.197741070879227,6.201217270889362,1.5354916669999947,1375,1.6786572132332367e-13,0,0,0,0
0,0,30,3000,penalty,0.01,5,6.197741070879227,6.3863677616346335,1.187240958999988,1189,1.5498713423767185e-13,0,0,0,0
0,0,30,3000,penalty,0.01,6,6.197741070879227,6.199720437567908,1.245554541999998,1252,1.6964207816272392e-13,0,0,0,0
0,0,30,3000,penalty,0.01,7,6.197741070879227,6.199720437567897,1.8112407079999975,1840,1.6697754290362354e-13,0,0,0,0
0,0,30,3000,penalty,0.01,8,6.197741070879227,6.197741070879639,1.9012854579999985,1828,4.263256414560601e-14,0,0,0,0
0,0,30,3000,penalty,0.01,9,6.197741070879227,6.199720437567844,1.1293684589999902,1104,9.947598300641403e-14,0,0,0,0
0,0,30,3000,penalty,0.01,10,6.197741070879227,6.197741070879702,2.9152695419999946,2507,2.2648549702353193e-14,0,0,0,0
0,0,30,3000,penalty,0.01,11,6.197741070879227,6.3324993289754214,2.5699196660000014,2391,9.237055564881302e-14,0,0,0,0
0,0,30,3000,penalty,0.01,12,6.197741070879227,6.201217270889341,1.1514553329999908,1154,1.7008616737257398e-13,0,0,0,0
0,0,30,3000,penalty,0.01,13,6.197741070879227,6.386367761634626,0.9335108750000072,1038,1.6298074001497298e-13,0,0,0,0
0,0,30,3000,penalty,0.01,14,6.197741070879227,6.442191151752,0.2693986250000016,438,4.440892098500626e-15,0,0,0,0
0,0,30,3000,penalty,0.01,15,6.197741070879227,6.1977410708796885,2.6737877090000257,2352,6.17284001691587e-14,0,0,0,0
0,0,30,3000,penalty,0.01,16,6.197741070879227,6.2012172708893525,2.1321797500000104,2159,1.7186252421197423e-13,0,0,0,0
0,0,30,3000,penalty,0.01,17,6.197741070879227,6.442191151752051,0.2816802080000052,396,1.865174681370263e-14,0,0,0,0
0,0,30,3000,penalty,0.01,18,6.197741070879227,6.321160223736889,2.236440207999985,2193,4.1744385725905886e-14,0,0,0,0
0,0,30,3000,penalty,0.01,19,6.197741070879227,6.303545724206896,1.2360847080000095,1326,1.7497114868092467e-13,0,0,0,0
0,0,30,3000,penalty,0.01,20,6.197741070879227,6.199720437567901,1.5379643340000184,1754,1.7053025658242404e-13,0,0,0,0
0,4,20,30000,ls_growth,0.01,1,8.978083352860407,8.97808335282246,2.5851780419999995,3645,1.9406698470447736e-13,48248,48002,12985,52
0,4,20,30000,ls_growth,0.01,2,8.978083352860407,9.143176467213321,2.5187020829999964,3588,1.851852005074761e-13,48014,47778,12807,52
0,4,20,30000,ls_growth,0.01,3,8.978083352860407,8.978083352822447,2.5817609169999924,3647,1.7719159473017498e-13,47491,47296,12966,51
0,4,20,30000,ls_growth,0.01,4,8.978083352860407,8.97808335282245,2.7633318330000036,3418,1.865174681370263e-13,47987,47753,12972,52
0,4,20,30000,ls_growth,0.01,5,8.978083352860407,8.97808335282245,2.8857912080000094,3376,1.8429702208777599e-13,47602,47345,13065,51
0,4,20,30000,ls_growth,0.01,6,8.978083352860407,8.97808335282245,2.807144,3592,1.8740564655672642e-13,48020,47818,13440,51
0,4,20,30000,ls_growth,0.01,7,8.978083352860407,8.978083352822456,2.9985857499999984,3571,1.949551631241775e-13,47679,47475,12818,52
0,4,20,30000,ls_growth,0.01,8,8.978083352860407,8.978083352822468,2.9810106249999953,3365,1.9229062786507711e-13,47436,47176,12739,51
0,4,20,30000,ls_growth,0.01,9,8.978083352860407,8.978083352822471,3.0748420000000043,3508,1.9673151996357774e-13,47447,47186,12925,51
0,4,20,30000,ls_growth,0.01,10,8.978083352860407,8.978083352822443,2.678523917000013,3411,1.780797731498751e-13,47648,47364,12849,51
0,4,20,30000,ls_growth,0.01,11,8.978083352860407,8.978083352822445,2.5542824580000016,3513,1.8385293287792592e-13,47209,46976,12968,52
0,4,20,30000,ls_growth,0.01,12,8.978083352860407,8.978083352822473,2.6435772920000016,3614,1.9095836023552692e-13,46964,46730,12764,50
0,4,20,30000,ls_growth,0.01,13,8.978083352860407,9.143950329159624,2.7070551249999846,3604,1.9406698470447736e-13,45753,45539,12566,50
0,4,20,30000,ls_growth,0.01,14,8.978083352860407,8.97808335282246,2.573947333999997,3410,1.9451107391432743e-13,47606,47379,12767,51
0,4,20,30000,ls_growth,0.01,15,8.978083352860407,9.143176467213348,2.5347142919999897,3597,1.9051427102567686e-13,47280,47054,12630,51
0,4,20,30000,ls_growth,0.01,16,8.978083352860407,8.97808335282245,2.4074179580000052,3377,1.9406698470447736e-13,46813,46613,12842,51
0,4,20,30000,ls_growth,0.01,17,8.978083352860407,8.97808335282246,2.613020332999993,3613,1.9628743075372768e-13,48296,48066,13226,52
0,4,20,30000,ls_growth,0.01,18,8.978083352860407,8.978083352822464,2.4704509170000093,3551,1.9539925233402755e-13,47544,47320,12950,51
0,4,20,30000,ls_growth,0.01,19,8.978083352860407,8.978083352822468,2.6025818750000034,3437,1.8962609260597674e-13,48312,48066,13126,52
0,4,20,30000,ls_growth,0.01,20,8.978083352860407,8.978083352822479,2.495196834000002,3573,1.949551631241775e-13,47171,46913,12802,51
5,5,6,3000,ls_growth,0.01,1,2.61803,2.6180341628148014,6.201888292000003,1931,9.403589018575076e-14,28497,22032,17,75
5,5,6,3000,ls_growth,0.01,2,2.61803,2.6180339953441667,5.375592875000002,3000,1.1500205232550798e-9,23195,17242,21,56
5,5,6,3000,ls_growth,0.01,3,2.61803,2.618033988804368,6.4160626249999915,3000,1.4509948798036021e-11,25595,18079,18,57
5,5,6,3000,ls_growth,0.01,4,2.61803,2.8039578074746196,5.913641541999998,3000,2.0317081350640365e-14,24913,19761,14,65
5,5,6,3000,ls_growth,0.01,5,2.61803,2.6180340500174197,5.212723707999991,3000,1.999511667349907e-13,23216,16852,17,52
5,5,6,3000,ls_growth,0.01,6,2.61803,2.618034168996156,5.560906333000006,3000,6.481740033592587e-9,25567,18607,17,59
5,5,6,3000,ls_growth,0.01,7,2.61803,2.618034142432617,5.557129583000002,3000,2.6562100408078493e-8,24440,18503,20,60
5,5,6,3000,ls_growth,0.01,8,2.61803,2.6180340672881393,5.359661667000007,3000,4.597522251792441e-9,25069,17083,15,56
5,5,6,3000,ls_growth,0.01,9,2.61803,2.6180341969582264,5.455611082999996,3000,1.9961809982760315e-13,26075,18910,19,61
5,5,6,3000,ls_growth,0.01,10,2.61803,2.618034169433325,6.045166041999997,3000,2.2854326209298392e-9,27539,20097,17,64
5,5,6,3000,ls_growth,0.01,11,2.61803,2.618034003022474,7.036076165999999,3000,1.9345691715244584e-9,28610,21739,18,70
5,5,6,3000,ls_growth,0.01,12,2.61803,2.618034154004201,6.800609375,3000,7.90458121180393e-9,27798,18791,15,59
5,5,6,3000,ls_growth,0.01,13,2.61803,2.6180339914406523,6.380929417000007,3000,8.438414411671147e-10,25186,17055,17,55
5,5,6,3000,ls_growth,0.01,14,2.61803,2.6180339907579873,4.535410707999981,3000,3.3253955145085e-10,20747,14063,13,45
5,5,6,3000,ls_growth,0.01,15,2.61803,2.6180340871681986,6.123677666000003,3000,1.878308508729276e-8,27419,20506,18,66
5,5,6,3000,ls_growth,0.01,16,2.61803,2.6180340963934814,6.923957874999993,3000,1.1017294632154062e-8,26871,19440,20,61
5,5,6,3000,ls_growth,0.01,17,2.61803,2.806624475133121,5.916993415999983,3000,9.470202400052585e-14,26000,19811,17,65
5,5,6,3000,ls_growth,0.01,18,2.61803,2.6180341875948114,5.555964208999998,3000,1.999511667349907e-13,26617,18976,13,62
5,5,6,3000,ls_growth,0.01,19,2.61803,2.618034020210529,4.996031290999992,3000,1.2765416279592046e-8,24450,17033,21,58
5,5,6,3000,ls_growth,0.01,20,2.61803,2.618034374266419,5.430903583999985,3000,1.6304592120874872e-9,26240,17805,9,58
0,4,20,30000,penalty,0.01,1,8.978083352860407,8.97808335282244,0.8062673340000037,1358,1.8030021919912542e-13,0,0,0,0
0,4,20,30000,penalty,0.01,2,8.978083352860407,9.14859344917994,0.8445240000000049,1389,1.900701818158268e-13,0,0,0,0
0,4,20,30000,penalty,0.01,3,8.978083352860407,9.2478852834849,1.0703304580000113,1652,1.9229062786507711e-13,0,0,0,0
0,4,20,30000,penalty,0.01,4,8.978083352860407,9.306873805190689,0.9347736660000228,1552,1.509903313490213e-14,0,0,0,0
0,4,20,30000,penalty,0.01,5,8.978083352860407,8.978083352822468,0.41292216700001155,818,1.9584334154387761e-13,0,0,0,0
0,4,20,30000,penalty,0.01,6,8.978083352860407,9.283936011913566,0.8724002920000057,1544,1.8074430840897548e-13,0,0,0,0
0,4,20,30000,penalty,0.01,7,8.978083352860407,8.978083352822466,0.44515904100000625,717,1.9451107391432743e-13,0,0,0,0
0,4,20,30000,penalty,0.01,8,8.978083352860407,9.143950313706759,1.0723271660000027,1741,1.9273471707492718e-13,0,0,0,0
0,4,20,30000,penalty,0.01,9,8.978083352860407,8.978083352822468,0.6502265840000182,1052,1.9628743075372768e-13,0,0,0,0
0,4,20,30000,penalty,0.01,10,8.978083352860407,8.978083352822463,0.5645501249999797,1063,1.9406698470447736e-13,0,0,0,0
0,4,20,30000,penalty,0.01,11,8.978083352860407,9.398937895014326,0.5811197500000126,1069,1.9584334154387761e-13,0,0,0,0
0,4,20,30000,penalty,0.01,12,8.978083352860407,9.149180438652767,1.0687009580000013,1723,1.9673151996357774e-13,0,0,0,0
0,4,20,30000,penalty,0.01,13,8.978083352860407,8.978083352822441,0.46004199999998674,894,1.8385293287792592e-13,0,0,0,0
0,4,20,30000,penalty,0.01,14,8.978083352860407,9.436313375126955,0.7415137920000124,1244,1.9406698470447736e-13,0,0,0,0
0,4,20,30000,penalty,0.01,15,8.978083352860407,8.978083352822454,0.3828887500000128,761,1.9584334154387761e-13,0,0,0,0
0,4,20,30000,penalty,0.01,16,8.978083352860407,9.14859344917997,0.8280559999999823,1397,1.9051427102567686e-13,0,0,0,0
0,4,20,30000,penalty,0.01,17,8.978083352860407,9.29632652524442,0.7839342499999912,1301,1.949551631241775e-13,0,0,0,0
0,4,20,30000,penalty,0.01,18,8.978083352860407,8.978083352822456,0.7226970419999852,1498,1.9184653865522705e-13,0,0,0,0
0,4,20,30000,penalty,0.01,19,8.978083352860407,9.370752588260546,0.8353709999999847,1346,1.9229062786507711e-13,0,0,0,0
0,4,20,30000,penalty,0.01,20,8.978083352860407,8.978083352822473,0.4744087500000023,850,1.9539925233402755e-13,0,0,0,0
5,5,6,3000,penalty,0.01,1,2.61803,2.9985767953773306,0.38803987499998766,2529,1.9984014443252818e-13,0,0,0,0
5,5,6,3000,penalty,0.01,2,2.61803,3.4138616689533396,0.2770400420000078,2101,1.971756091734278e-13,0,0,0,0
5,5,6,3000,penalty,0.01,3,2.61803,2.6180345271976795,0.5902626670000027,3000,3.0181428467557225e-9,0,0,0,0
5,5,6,3000,penalty,0.01,4,2.61803,3.075712297835844,0.3821236670000071,3000,4.0745185003743245e-14,0,0,0,0
5,5,6,3000,penalty,0.01,5,2.61803,2.618034008394783,0.5579391249999753,3000,2.1202908317974334e-9,0,0,0,0
5,5,6,3000,penalty,0.01,6,2.61803,3.0804053540357392,0.38433454100001835,3000,7.649436639667329e-14,0,0,0,0
5,5,6,3000,penalty,0.01,7,2.61803,2.6180341252505235,0.5418296670000127,3000,1.3868337478406545e-8,0,0,0,0
5,5,6,3000,penalty,0.01,8,2.61803,3.165100273078476,0.4392096659999806,3000,4.651834473179406e-14,0,0,0,0
5,5,6,3000,penalty,0.01,9,2.61803,2.9996354902215394,0.23267795800001476,2060,-1.687538997430238e-14,0,0,0,0
5,5,6,3000,penalty,0.01,10,2.61803,3.075714194042176,0.3270156669999997,3000,4.1522341120980855e-14,0,0,0,0
5,5,6,3000,penalty,0.01,11,2.61803,2.6180340319363746,0.5866070410000103,3000,1.9984014443252818e-13,0,0,0,0
5,5,6,3000,penalty,0.01,12,2.61803,3.0757107047362258,0.1971827500000072,1679,1.7885692926711272e-13,0,0,0,0
5,5,6,3000,penalty,0.01,13,2.61803,3.1030213518261114,0.15998487499999464,1504,1.8640644583456378e-13,0,0,0,0
5,5,6,3000,penalty,0.01,14,2.61803,2.6180341381076735,0.5493034580000095,3000,1.3853119651408008e-8,0,0,0,0
5,5,6,3000,penalty,0.01,15,2.61803,2.999188825065191,0.18953287500000443,1641,2.2237767183241886e-13,0,0,0,0
5,5,6,3000,penalty,0.01,16,2.61803,2.6180341641835594,0.5452627919999941,3000,8.99035124124481e-9,0,0,0,0
5,5,6,3000,penalty,0.01,17,2.61803,3.102423544851161,0.17661341599997832,1788,1.7752466163756253e-13,0,0,0,0
5,5,6,3000,penalty,0.01,18,2.61803,2.6180340033618745,0.5172205419999955,3000,2.456491898783497e-9,0,0,0,0
5,5,6,3000,penalty,0.01,19,2.61803,2.618034002694413,0.5748685000000114,3000,2.000621890374532e-13,0,0,0,0
5,5,6,3000,penalty,0.01,20,2.61803,2.618034084215573,0.4846072080000013,3000,1.2842009677882515e-9,0,0,0,0
0,0,30,3000,ls_growth,0.001,1,6.197741070879227,6.206197071621425,4.113975999999995,2858,1.9273471707492718e-13,40752,38259,10841,0
0,0,30,3000,ls_growth,0.001,2,6.197741070879227,6.204856076128805,4.973885459000012,3000,4.440892098500626e-16,43184,40378,11458,0
0,0,30,3000,ls_growth,0.001,3,6.197741070879227,6.328440698740362,5.319071333,3000,2.5757174171303632e-14,43184,40820,11506,0
0,0,30,3000,ls_growth,0.001,4,6.197741070879227,6.203805432885019,4.9403538750000004,3000,3.552713678800501e-15,43184,40649,11447,0
0,0,30,3000,ls_growth,0.001,5,6.197741070879227,6.308553889924421,6.0189616659999885,3000,1.1102230246251565e-14,43184,40705,11371,0
0,0,30,3000,ls_growth,0.001,6,6.197741070879227,6.207442373870898,4.8625109589999775,3000,1.7763568394002505e-14,43184,40619,11429,0
0,0,30,3000,ls_growth,0.001,7,6.197741070879227,6.212507911955693,4.131842957999994,3000,1.687538997430238e-14,43184,40453,11244,0
0,0,30,3000,ls_growth,0.001,8,6.197741070879227,6.200280524148391,4.545306624999998,3000,8.881784197001252e-16,43184,40443,11483,0
0,0,30,3000,ls_growth,0.001,9,6.197741070879227,6.20027444162904,4.683994957999996,3000,3.1086244689504383e-15,43184,40524,11370,0
0,0,30,3000,ls_growth,0.001,10,6.197741070879227,6.202966242020458,5.3410092920000025,3000,5.329070518200751e-15,43184,40247,11177,0
0,0,30,3000,ls_growth,0.001,11,6.197741070879227,6.2150071037664665,4.239809208999999,2674,8.43769498715119e-15,37824,35121,9817,0
0,0,30,3000,ls_growth,0.001,12,6.197741070879227,6.202729344413773,5.281083374999987,2856,1.9317880628477724e-13,40720,37892,10686,0
0,0,30,3000,ls_growth,0.001,13,6.197741070879227,6.21504895014571,4.735165125,3000,0,43184,40431,11250,0
0,0,30,3000,ls_growth,0.001,14,6.197741070879227,6.203149818900004,5.0574974999999975,3000,6.661338147750939e-15,43184,40420,11406,0
0,0,30,3000,ls_growth,0.001,15,6.197741070879227,6.207780285387319,5.097824166999985,3000,3.1086244689504383e-15,43184,40262,11261,0
0,0,30,3000,ls_growth,0.001,16,6.197741070879227,6.26812985532905,4.5736763750000105,3000,2.220446049250313e-15,43184,40325,11197,0
0,0,30,3000,ls_growth,0.001,17,6.197741070879227,6.2479366376997545,5.026531749999995,3000,1.7763568394002505e-15,43184,40539,11304,0
0,0,30,3000,ls_growth,0.001,18,6.197741070879227,6.212858285821938,4.8976279999999965,3000,7.105427357601002e-15,43184,40673,11532,0
0,0,30,3000,ls_growth,0.001,19,6.197741070879227,6.210075900155893,4.17777800000002,3000,1.3322676295501878e-15,43184,40375,11336,0
0,0,30,3000,ls_growth,0.001,20,6.197741070879227,6.210010548239079,4.154779749999987,3000,9.769962616701378e-15,43184,40658,11483,0
0,0,19,30000,ls_growth,0.001,1,4.863703305156274,4.8637033051566645,10.248652375000004,15465,1.8385293287792592e-13,245941,242756,62910,28
0,0,19,30000,ls_growth,0.001,2,4.863703305156274,4.863703305156648,10.463556875000009,16149,1.7985612998927536e-13,256881,253540,67622,28
0,0,19,30000,ls_growth,0.001,3,4.863703305156274,4.86370330515664,6.478211125000001,10080,1.8118839761882555e-13,159778,156289,38000,16
0,0,19,30000,ls_growth,0.001,4,4.863703305156274,4.863703305156646,10.953047917000019,16321,1.7719159473017498e-13,259634,256287,67815,29
0,0,19,30000,ls_growth,0.001,5,4.863703305156274,4.863703305156648,10.360249917000008,15822,1.865174681370263e-13,251660,248326,65722,28
0,0,19,30000,ls_growth,0.001,6,4.863703305156274,4.863703305156651,8.333745250000007,13039,1.8962609260597674e-13,207136,203546,50650,23
0,0,19,30000,ls_growth,0.001,7,4.863703305156274,4.863703305156667,6.283488958000001,9667,1.8207657603852567e-13,153152,150502,40129,17
0,0,19,30000,ls_growth,0.001,8,4.863703305156274,4.863703305156653,3.5791539169999886,5681,1.8385293287792592e-13,89376,86452,21550,9
0,0,19,30000,ls_growth,0.001,9,4.863703305156274,4.863703305156665,5.267466249999997,8167,1.8207657603852567e-13,129184,125905,33381,14
0,0,19,30000,ls_growth,0.001,10,4.863703305156274,4.863703305156638,9.359923209,12452,1.7363888105137448e-13,196953,194038,49129,23
0,0,19,30000,ls_growth,0.001,11,4.863703305156274,4.863703305156675,8.100082834,11374,1.8074430840897548e-13,180496,176957,44679,20
0,0,19,30000,ls_growth,0.001,12,4.863703305156274,4.863703305156665,6.948944375000021,10626,1.8074430840897548e-13,168514,165057,39690,18
0,0,19,30000,ls_growth,0.001,13,4.863703305156274,4.863703305156663,11.278845540999988,17648,1.794120407794253e-13,280867,277425,74021,32
0,0,19,30000,ls_growth,0.001,14,4.863703305156274,4.863703305156647,10.27617525,16335,1.865174681370263e-13,259857,256229,67289,29
0,0,19,30000,ls_growth,0.001,15,4.863703305156274,4.8637033051566405,9.447558000000019,13240,1.8429702208777599e-13,210340,207155,51460,23
0,0,19,30000,ls_growth,0.001,16,4.863703305156274,4.863703305156653,9.057807040999993,14795,1.7852386235972517e-13,235227,232006,59675,25
0,0,19,30000,ls_growth,0.001,17,4.863703305156274,4.863703305156667,5.559600916999974,9283,1.8074430840897548e-13,146976,143805,37866,16
0,0,19,30000,ls_growth,0.001,18,4.863703305156274,4.863703305156649,10.66496854099998,18016,1.7363888105137448e-13,286234,283069,74734,32
0,0,19,30000,ls_growth,0.001,19,4.863703305156274,4.863703305156649,4.527078957999998,8022,1.829647544582258e-13,126864,123511,29675,12
0,0,19,30000,ls_growth,0.001,20,4.863703305156274,4.863703305156663,8.643493791999994,14608,1.8829382497642655e-13,230647,227832,58927,25
0,0,19,30000,ls_growth,0.1,1,4.863703305156274,4.863703305156662,0.3057007500000182,469,1.8385293287792592e-13,5977,5959,1611,70
0,0,19,30000,ls_growth,0.1,2,4.863703305156274,4.863703305156672,0.29895583300001455,523,1.7896795156957523e-13,6075,6054,1607,69
0,0,19,30000,ls_growth,0.1,3,4.863703305156274,4.863703305156667,0.33915358300000664,478,1.7896795156957523e-13,6150,6123,1659,71
0,0,19,30000,ls_growth,0.1,4,4.863703305156274,4.863703305156655,0.31210016700002596,467,1.8829382497642655e-13,5978,5947,1582,69
0,0,19,30000,ls_growth,0.1,5,4.863703305156274,4.8637033051566405,0.3663726659999811,477,1.8429702208777599e-13,6141,6112,1623,71
0,0,19,30000,ls_growth,0.1,6,4.863703305156274,4.8637033051566645,0.24855045799998335,476,1.8740564655672642e-13,5852,5814,1401,71
0,0,19,30000,ls_growth,0.1,7,4.863703305156274,4.863703305156666,0.3124219169999706,486,1.8074430840897548e-13,6275,6249,1627,74
0,0,19,30000,ls_growth,0.1,8,4.863703305156274,4.86370330515667,0.32040520899998953,481,1.851852005074761e-13,6194,6168,1636,72
0,0,19,30000,ls_growth,0.1,9,4.863703305156274,4.863703305156642,0.32825204200000735,507,1.780797731498751e-13,6603,6573,1776,76
0,0,19,30000,ls_growth,0.1,10,4.863703305156274,4.863703305156676,0.3356066250000149,468,1.8385293287792592e-13,5972,5951,1586,70
0,0,19,30000,ls_growth,0.1,11,4.863703305156274,4.863703305156644,0.260207584000018,469,1.8784973576657649e-13,6004,5979,1641,70
0,0,19,30000,ls_growth,0.1,12,4.863703305156274,4.863703305156649,0.3203595830000122,473,1.7497114868092467e-13,6076,6050,1617,70
0,0,19,30000,ls_growth,0.1,13,4.863703305156274,5.099682709790221,0.7121322500000242,919,1.7630341631047486e-13,6519,6483,1771,72
0,0,19,30000,ls_growth,0.1,14,4.863703305156274,4.863703305156676,0.30400933400000213,555,1.8562928971732617e-13,6604,6582,1697,75
0,0,19,30000,ls_growth,0.1,15,4.863703305156274,5.090897789666707,0.4842289589999709,699,1.7408297026122455e-13,6290,6268,1771,73
0,0,19,30000,ls_growth,0.1,16,4.863703305156274,5.125622177271205,0.5507790420000093,821,1.7719159473017498e-13,5367,5344,1431,69
0,0,19,30000,ls_growth,0.1,17,4.863703305156274,4.863703305156665,0.2311059580000001,482,1.7763568394002505e-13,6216,6192,1682,72
0,0,19,30000,ls_growth,0.1,18,4.863703305156274,4.863703305156665,0.23724708300002384,514,1.8784973576657649e-13,6197,6169,1545,72
0,0,19,30000,ls_growth,0.1,19,4.863703305156274,4.863703305156649,0.2559234169999836,530,1.745270594710746e-13,6708,6682,1621,76
0,0,19,30000,ls_growth,0.1,20,4.863703305156274,4.863703305156665,0.22844391699996777,476,1.8474111129762605e-13,6111,6084,1556,72
0,3,6,3000,ls_growth,0.01,1,7.464,7.464101615138155,0.23569612499995857,1287,1.7630341631047486e-13,19038,18604,3369,60
0,3,6,3000,ls_growth,0.01,2,7.464,7.464101615138152,0.2643656659999979,1251,1.7763568394002505e-13,18497,18209,3882,59
0,3,6,3000,ls_growth,0.01,3,7.464,7.4641016151381505,0.2504635840000119,1288,1.7541523789077473e-13,18556,18188,5674,59
0,3,6,3000,ls_growth,0.01,4,7.464,7.464101615138155,0.22412870900001144,1301,1.9984014443252818e-13,18758,18436,3210,60
0,3,6,3000,ls_growth,0.01,5,7.464,7.464101615138157,0.21810666699998546,1268,1.7275070263167436e-13,18775,18458,2976,60
0,3,6,3000,ls_growth,0.01,6,7.464,7.464101615138153,0.21073037499998462,1275,1.98507876802978e-13,18865,18535,4002,60
0,3,6,3000,ls_growth,0.01,7,7.464,7.464101615138155,0.22131287500000327,1298,1.9984014443252818e-13,18680,18387,6416,61
0,3,6,3000,ls_growth,0.01,8,7.464,7.464101615138152,0.22686579100001836,1265,1.7852386235972517e-13,18728,18390,5354,60
0,3,6,3000,ls_growth,0.01,9,7.464,7.464101615138157,0.24678658299997916,1266,1.8118839761882555e-13,18752,18346,3870,60
0,3,6,3000,ls_growth,0.01,10,7.464,7.464101615138155,0.22637241700000596,1260,1.98507876802978e-13,18607,18274,6022,60
0,3,6,3000,ls_growth,0.01,11,7.464,7.4641016151381585,0.27175741700001527,1341,2.0028423364237824e-13,18902,18509,5172,61
0,3,6,3000,ls_growth,0.01,12,7.464,7.464101615138155,0.2536013329999987,1276,1.9673151996357774e-13,18902,18513,6495,60
0,3,6,3000,ls_growth,0.01,13,7.464,7.4641016151381505,0.21043183299998056,1263,1.7541523789077473e-13,18667,18277,4142,60
0,3,6,3000,ls_growth,0.01,14,7.464,7.464101615138155,0.22178166699997381,1278,1.9984014443252818e-13,18917,18542,5231,62
0,3,6,3000,ls_growth,0.01,15,7.464,7.464101615138157,0.20952329199999803,1257,1.723066134218243e-13,18595,18243,4406,60
0,3,6,3000,ls_growth,0.01,16,7.464,7.464101615138155,0.22078287499997531,1279,1.9761969838327786e-13,18665,18271,4156,59
0,3,6,3000,ls_growth,0.01,17,7.464,7.464101615138152,0.24193062499997905,1270,1.9761969838327786e-13,18519,18196,4314,59
0,3,6,3000,ls_growth,0.01,18,7.464,7.464101615138155,0.2725059999999939,1256,1.9895196601282805e-13,18585,18292,3261,60
0,3,6,3000,ls_growth,0.01,19,7.464,7.464101615138152,0.24793187500000932,1264,1.9673151996357774e-13,18713,18347,4715,60
0,3,6,3000,ls_growth,0.01,20,7.464,7.464101615138152,0.22171516699995847,1272,1.9984014443252818e-13,18562,18213,2966,59
0,3,6,3000,penalty,0.01,1,7.464,7.464101615138152,0.017054332999978213,248,1.7763568394002505e-13,0,0,0,0
0,3,6,3000,penalty,0.01,2,7.464,7.464101615138146,0.011218333000026177,235,1.7408297026122455e-13,0,0,0,0
0,3,6,3000,penalty,0.01,3,7.464,7.464101615138157,0.010397165999980643,195,1.9984014443252818e-13,0,0,0,0
0,3,6,3000,penalty,0.01,4,7.464,7.464101615138147,0.013604625000036322,198,1.7541523789077473e-13,0,0,0,0
0,3,6,3000,penalty,0.01,5,7.464,7.4641016151381505,0.011758958999998868,208,1.745270594710746e-13,0,0,0,0
0,3,6,3000,penalty,0.01,6,7.464,7.464101615138157,0.010378000000026076,253,1.9984014443252818e-13,0,0,0,0
0,3,6,3000,penalty,0.01,7,7.464,7.464101615138155,0.008441084000049158,195,1.9939605522267811e-13,0,0,0,0
0,3,6,3000,penalty,0.01,8,7.464,7.464101615138155,0.015211790999979711,293,2.0028423364237824e-13,0,0,0,0
0,3,6,3000,penalty,0.01,9,7.464,7.4641016151381505,0.00865787499997532,204,1.6653345369377348e-13,0,0,0,0
0,3,6,3000,penalty,0.01,10,7.464,7.464101615138155,0.008787375000014435,202,1.9939605522267811e-13,0,0,0,0
0,3,6,3000,penalty,0.01,11,7.464,7.464101615138152,0.009653749999997671,194,1.9451107391432743e-13,0,0,0,0
0,3,6,3000,penalty,0.01,12,7.464,7.464101615138157,0.009465041999996175,268,1.8030021919912542e-13,0,0,0,0
0,3,6,3000,penalty,0.01,13,7.464,7.464101615138155,0.013689958999981173,248,1.9761969838327786e-13,0,0,0,0
0,3,6,3000,penalty,0.01,14,7.464,7.464101615138157,0.00984279200003948,179,2.0028423364237824e-13,0,0,0,0
0,3,6,3000,penalty,0.01,15,7.464,7.464101615138155,0.01304083300003549,225,1.9984014443252818e-13,0,0,0,0
0,3,6,3000,penalty,0.01,16,7.464,7.464101615138155,0.009606916000018827,210,1.9939605522267811e-13,0,0,0,0
0,3,6,3000,penalty,0.01,17,7.464,7.464101615138155,0.009631541999988258,248,1.9895196601282805e-13,0,0,0,0
0,3,6,3000,penalty,0.01,18,7.464,7.464101615138153,0.010147208000009414,238,1.9939605522267811e-13,0,0,0,0
0,3,6,3000,penalty,0.01,19,7.464,7.464101615138157,0.013364832999999635,256,1.9984014443252818e-13,0,0,0,0
0,3,6,3000,penalty,0.01,20,7.464,7.4641016151381505,0.009234708000032697,194,1.7674750552032492e-13,0,0,0,0
5,5,6,30000,ls_growth,0.01,1,2.61803,2.6180340725315365,5.338595582999988,4514,5.1501150677424334e-8,23990,17452,14,62
5,5,6,30000,ls_growth,0.01,2,2.61803,2.6180339887938824,6.003627792000014,4598,9.914291609902648e-14,23195,17242,21,56
5,5,6,30000,ls_growth,0.01,3,2.61803,2.618034065039885,8.252383667000016,5238,8.859579736508749e-14,29717,22191,35,70
5,5,6,30000,ls_growth,0.01,4,2.61803,2.618033988850573,6.036968792,4025,8.659739592076221e-14,25132,19990,14,66
5,5,6,30000,ls_growth,0.01,5,2.61803,2.6180339889691555,6.431494084000005,4408,3.2085445411667024e-14,23216,16852,17,52
5,5,6,30000,ls_growth,0.01,6,2.61803,2.6180339899317966,8.070655791999975,5307,5.329070518200751e-15,29031,22038,21,72
5,5,6,30000,ls_growth,0.01,7,2.61803,2.618034013513031,6.311460458000016,4308,3.455891572912151e-9,24440,18503,20,60
5,5,6,30000,ls_growth,0.01,8,2.61803,2.6180339989409576,8.497964500000002,5271,1.1080025785759062e-13,34500,26492,22,89
5,5,6,30000,ls_growth,0.01,9,2.61803,2.618034075918729,7.118366000000009,4982,2.108599350680862e-8,30328,22810,30,76
5,5,6,30000,ls_growth,0.01,10,2.61803,2.6180339888747564,6.5723763750000215,5306,4.851674617611934e-14,29410,22076,18,73
5,5,6,30000,ls_growth,0.01,11,2.61803,3.0520171714083277,7.052780625000014,4832,-2.6645352591003757e-15,28829,22373,14,69
5,5,6,30000,ls_growth,0.01,12,2.61803,2.618033988933266,13.376773709000002,6618,4.007905118896815e-14,45511,36646,28,119
5,5,6,30000,ls_growth,0.01,13,2.61803,2.618033988763116,6.635941541999986,4808,-1.4876988529977098e-14,30077,21977,30,73
5,5,6,30000,ls_growth,0.01,14,2.61803,2.618033988899726,4.119685667000012,4249,6.006306563222097e-14,20747,14063,13,45
5,5,6,30000,ls_growth,0.01,15,2.61803,2.6180339889293283,6.491034125000006,5130,8.182343691487404e-14,31013,24130,20,79
5,5,6,30000,ls_growth,0.01,16,2.61803,2.6180339888081643,6.450107957999979,5355,2.0650148258027912e-14,28498,21191,19,68
5,5,6,30000,ls_growth,0.01,17,2.61803,2.8066142850102116,5.622006457999989,4864,1.9195756095768957e-13,26357,20168,17,67
5,5,6,30000,ls_growth,0.01,18,2.61803,2.618033988912547,6.01534704199998,4766,3.319566843629218e-14,28217,20653,17,68
5,5,6,30000,ls_growth,0.01,19,2.61803,2.6180340019972412,5.560096750000026,4120,5.111790990497411e-10,25654,18361,12,62
5,5,6,30000,ls_growth,0.01,20,2.61803,2.6180340580539245,7.6064692919999946,5292,4.4853010194856324e-14,32766,24271,15,76
0,0,30,3000,ls_growth,0.1,1,6.197741070879227,6.381252565731324,3.556235875000013,860,1.865174681370263e-13,8745,8733,2440,68
0,0,30,3000,ls_growth,0.1,2,6.197741070879227,6.206723794995471,3.1581724580000157,930,1.9273471707492718e-13,9851,9837,2898,70
0,0,30,3000,ls_growth,0.1,3,6.197741070879227,6.296423748634927,2.7048948329999694,866,1.745270594710746e-13,8821,8800,2571,67
0,0,30,3000,ls_growth,0.1,4,6.197741070879227,6.3195750168619,3.961979333000025,854,1.8962609260597674e-13,8664,8646,2529,67
0,0,30,3000,ls_growth,0.1,5,6.197741070879227,6.201251017164415,3.400495959000022,954,1.7053025658242404e-13,10271,10251,2746,73
0,0,30,3000,ls_growth,0.1,6,6.197741070879227,6.203160584875219,3.0893564579999655,919,1.7008616737257398e-13,9684,9675,2560,68
0,0,30,3000,ls_growth,0.1,7,6.197741070879227,6.200063571004741,3.80493987500004,880,1.8207657603852567e-13,9084,9054,2521,68
0,0,30,3000,ls_growth,0.1,8,6.197741070879227,6.200059250190336,3.442439624999999,933,1.7763568394002505e-15,9934,9917,2903,70
0,0,30,3000,ls_growth,0.1,9,6.197741070879227,6.201138191053753,3.2833604159999523,928,1.6964207816272392e-13,9851,9834,2714,68
0,0,30,3000,ls_growth,0.1,10,6.197741070879227,6.289618877322561,3.3283528340000195,944,1.936228954946273e-13,10091,10072,2682,69
0,0,30,3000,ls_growth,0.1,11,6.197741070879227,6.199720437567892,3.1869170830000075,1476,1.709743457922741e-13,10053,10038,2647,69
0,0,30,3000,ls_growth,0.1,12,6.197741070879227,6.319632112585898,3.184857458000013,874,1.8207657603852567e-13,8981,8964,2489,67
0,0,30,3000,ls_growth,0.1,13,6.197741070879227,6.292457177172831,2.4397000830000035,909,1.7719159473017498e-13,9529,9509,2585,67
0,0,30,3000,ls_growth,0.1,14,6.197741070879227,6.206118047743768,2.4685192920000407,980,1.7674750552032492e-13,10632,10611,2747,72
0,0,30,3000,ls_growth,0.1,15,6.197741070879227,6.351983126993097,2.777562042000005,930,1.7763568394002505e-13,9874,9850,3032,70
0,0,30,3000,ls_growth,0.1,16,6.197741070879227,6.292532084543527,5.1005642080000255,962,1.745270594710746e-13,10392,10373,2731,69
0,0,30,3000,ls_growth,0.1,17,6.197741070879227,6.198559330606427,4.134130584000028,856,1.9184653865522705e-13,8698,8678,2399,67
0,0,30,3000,ls_growth,0.1,18,6.197741070879227,6.363484899224171,2.2616576669999633,922,1.7363888105137448e-13,9709,9692,2710,69
0,0,30,3000,ls_growth,0.1,19,6.197741070879227,6.306359688180729,2.591558000000019,1277,1.6964207816272392e-13,8683,8662,2404,68
0,0,30,3000,ls_growth,0.1,20,6.197741070879227,6.198358303513708,4.064292707999994,854,1.971756091734278e-13,8641,8625,2488,67
0,3,6,30000,ls_growth,0.01,1,7.464,7.464101615138155,0.24524379199999385,1287,1.7630341631047486e-13,19038,18604,3369,60
0,3,6,30000,ls_growth,0.01,2,7.464,7.464101615138152,0.21919683400000212,1251,1.7763568394002505e-13,18497,18209,3882,59
0,3,6,30000,ls_growth,0.01,3,7.464,7.4641016151381505,0.24877579200000036,1288,1.7541523789077473e-13,18556,18188,5674,59
0,3,6,30000,ls_growth,0.01,4,7.464,7.464101615138155,0.2729668330000131,1301,1.9984014443252818e-13,18758,18436,3210,60
0,3,6,30000,ls_growth,0.01,5,7.464,7.464101615138157,0.26214091600000394,1268,1.7275070263167436e-13,18775,18458,2976,60
0,3,6,30000,ls_growth,0.01,6,7.464,7.464101615138153,0.23964624999999068,1275,1.98507876802978e-13,18865,18535,4002,60
0,3,6,30000,ls_growth,0.01,7,7.464,7.464101615138155,0.2266140000000014,1298,1.9984014443252818e-13,18680,18387,6416,61
0,3,6,30000,ls_growth,0.01,8,7.464,7.464101615138152,0.23908870800002477,1265,1.7852386235972517e-13,18728,18390,5354,60
0,3,6,30000,ls_growth,0.01,9,7.464,7.464101615138157,0.23340529199998128,1266,1.8118839761882555e-13,18752,18346,3870,60
0,3,6,30000,ls_growth,0.01,10,7.464,7.464101615138155,0.28682783399999606,1260,1.98507876802978e-13,18607,18274,6022,60
0,3,6,30000,ls_growth,0.01,11,7.464,7.4641016151381585,0.2840695840000408,1341,2.0028423364237824e-13,18902,18509,5172,61
0,3,6,30000,ls_growth,0.01,12,7.464,7.464101615138155,0.25247258300002434,1276,1.9673151996357774e-13,18902,18513,6495,60
0,3,6,30000,ls_growth,0.01,13,7.464,7.4641016151381505,0.256253040999989,1263,1.7541523789077473e-13,18667,18277,4142,60
0,3,6,30000,ls_growth,0.01,14,7.464,7.464101615138155,0.24708991700003388,1278,1.9984014443252818e-13,18917,18542,5231,62
0,3,6,30000,ls_growth,0.01,15,7.464,7.464101615138157,0.23398054099996807,1257,1.723066134218243e-13,18595,18243,4406,60
0,3,6,30000,ls_growth,0.01,16,7.464,7.464101615138155,0.2235977089999942,1279,1.9761969838327786e-13,18665,18271,4156,59
0,3,6,30000,ls_growth,0.01,17,7.464,7.464101615138152,0.2269194579999894,1270,1.9761969838327786e-13,18519,18196,4314,59
0,3,6,30000,ls_growth,0.01,18,7.464,7.464101615138155,0.22928504200000316,1256,1.9895196601282805e-13,18585,18292,3261,60
0,3,6,30000,ls_growth,0.01,19,7.464,7.464101615138152,0.2656550409999909,1264,1.9673151996357774e-13,18713,18347,4715,60
0,3,6,30000,ls_growth,0.01,20,7.464,7.464101615138152,0.2679562090000254,1272,1.9984014443252818e-13,18562,18213,2966,59
0,3,6,30000,penalty,0.01,1,7.464,7.464101615138152,0.020730291999992913,248,1.7763568394002505e-13,0,0,0,0
0,3,6,30000,penalty,0.01,2,7.464,7.464101615138146,0.013203915999969467,235,1.7408297026122455e-13,0,0,0,0
0,3,6,30000,penalty,0.01,3,7.464,7.464101615138157,0.011280708000005689,195,1.9984014443252818e-13,0,0,0,0
0,3,6,30000,penalty,0.01,4,7.464,7.464101615138147,0.010620792000030634,198,1.7541523789077473e-13,0,0,0,0
0,3,6,30000,penalty,0.01,5,7.464,7.4641016151381505,0.010878792000003159,208,1.745270594710746e-13,0,0,0,0
0,3,6,30000,penalty,0.01,6,7.464,7.464101615138157,0.01012233300000662,253,1.9984014443252818e-13,0,0,0,0
0,3,6,30000,penalty,0.01,7,7.464,7.464101615138155,0.009097917000006419,195,1.9939605522267811e-13,0,0,0,0
0,3,6,30000,penalty,0.01,8,7.464,7.464101615138155,0.019568915999960156,293,2.0028423364237824e-13,0,0,0,0
0,3,6,30000,penalty,0.01,9,7.464,7.4641016151381505,0.010452166999981274,204,1.6653345369377348e-13,0,0,0,0
0,3,6,30000,penalty,0.01,10,7.464,7.464101615138155,0.008769582999986597,202,1.9939605522267811e-13,0,0,0,0
0,3,6,30000,penalty,0.01,11,7.464,7.464101615138152,0.008060792000032962,194,1.9451107391432743e-13,0,0,0,0
0,3,6,30000,penalty,0.01,12,7.464,7.464101615138157,0.008907791999983601,268,1.8030021919912542e-13,0,0,0,0
0,3,6,30000,penalty,0.01,13,7.464,7.464101615138155,0.014067291999992449,248,1.9761969838327786e-13,0,0,0,0
0,3,6,30000,penalty,0.01,14,7.464,7.464101615138157,0.007558207999973092,179,2.0028423364237824e-13,0,0,0,0
0,3,6,30000,penalty,0.01,15,7.464,7.464101615138155,0.010102917000011076,225,1.9984014443252818e-13,0,0,0,0
0,3,6,30000,penalty,0.01,16,7.464,7.464101615138155,0.010439332999987528,210,1.9939605522267811e-13,0,0,0,0
0,3,6,30000,penalty,0.01,17,7.464,7.464101615138155,0.009896583000023383,248,1.9895196601282805e-13,0,0,0,0
0,3,6,30000,penalty,0.01,18,7.464,7.464101615138153,0.009532165999989956,238,1.9939605522267811e-13,0,0,0,0
0,3,6,30000,penalty,0.01,19,7.464,7.464101615138157,0.011962042000028305,256,1.9984014443252818e-13,0,0,0,0
0,3,6,30000,penalty,0.01,20,7.464,7.4641016151381505,0.008220166000013705,194,1.7674750552032492e-13,0,0,0,0
5,5,6,30000,penalty,0.01,1,2.61803,2.9985767953773306,0.40906858299998566,2529,1.9984014443252818e-13,0,0,0,0
5,5,6,30000,penalty,0.01,2,2.61803,3.4138616689533396,0.2324037089999765,2101,1.971756091734278e-13,0,0,0,0
5,5,6,30000,penalty,0.01,3,2.61803,2.618034011121341,0.8807373749999678,4607,5.440092820663267e-15,0,0,0,0
5,5,6,30000,penalty,0.01,4,2.61803,3.075710828724196,0.41995912499999394,3119,1.7785772854495008e-13,0,0,0,0
5,5,6,30000,penalty,0.01,5,2.61803,2.6180339889690196,0.8781347909999895,4924,-9.547918011776346e-15,0,0,0,0
5,5,6,30000,penalty,0.01,6,2.61803,3.0804043685092304,0.6098775419999729,5081,1.2656542480726785e-14,0,0,0,0
5,5,6,30000,penalty,0.01,7,2.61803,2.618033988941971,0.9234879589999909,5333,5.0737192225369654e-14,0,0,0,0
5,5,6,30000,penalty,0.01,8,2.61803,3.1650684610088824,0.5655146670000395,4019,1.9040324872321435e-13,0,0,0,0
5,5,6,30000,penalty,0.01,9,2.61803,2.9996354902215394,0.2180819580000243,2060,-1.687538997430238e-14,0,0,0,0
5,5,6,30000,penalty,0.01,10,2.61803,3.075713831962279,0.624892125000013,5279,1.963984530561902e-13,0,0,0,0
5,5,6,30000,penalty,0.01,11,2.61803,2.618033988801682,0.897445875000034,4872,7.316369732279782e-14,0,0,0,0
5,5,6,30000,penalty,0.01,12,2.61803,3.0757107047362258,0.18764962500002003,1679,1.7885692926711272e-13,0,0,0,0
5,5,6,30000,penalty,0.01,13,2.61803,3.1030213518261114,0.15124266599997646,1504,1.8640644583456378e-13,0,0,0,0
5,5,6,30000,penalty,0.01,14,2.61803,2.6180339990589965,0.7769003749999683,4570,-4.440892098500626e-15,0,0,0,0
5,5,6,30000,penalty,0.01,15,2.61803,2.999188825065191,0.18188912500004517,1641,2.2237767183241886e-13,0,0,0,0
5,5,6,30000,penalty,0.01,16,2.61803,2.6180340628517467,0.9028558340000454,4775,-7.771561172376096e-15,0,0,0,0
5,5,6,30000,penalty,0.01,17,2.61803,3.102423544851161,0.18785216599999693,1788,1.7752466163756253e-13,0,0,0,0
5,5,6,30000,penalty,0.01,18,2.61803,2.6180339889611264,0.8008410830000067,4575,1.4876988529977098e-14,0,0,0,0
5,5,6,30000,penalty,0.01,19,2.61803,2.6180339889185693,0.8182766249999986,4403,-1.0547118733938987e-14,0,0,0,0
5,5,6,30000,penalty,0.01,20,2.61803,2.61803399036879,0.8273188749999972,5117,1.999511667349907e-13,0,0,0,0
6,6,7,3000,ls_growth,0.01,1,2.886,2.942073536465631,7.505902166999993,2542,2.0650148258027912e-14,24402,15993,17,48
6,6,7,3000,ls_growth,0.01,2,2.886,2.926337185009257,7.953587832999998,2428,2.0028423364237824e-13,24572,16755,11,53
6,6,7,3000,ls_growth,0.01,3,2.886,2.922099957786775,8.792507416999985,3000,2.375877272697835e-14,25550,18426,18,55
6,6,7,3000,ls_growth,0.01,4,2.886,2.891277240574834,8.455174042,3000,6.294964549624638e-14,25113,18075,16,56
6,6,7,3000,ls_growth,0.01,5,2.886,2.9257206114615406,8.613038208999992,2434,1.9562129693895258e-13,23382,16587,15,55
6,6,7,3000,ls_growth,0.01,6,2.886,2.904893163319477,8.445265332999988,3000,7.949196856316121e-14,23086,15968,12,53
6,6,7,3000,ls_growth,0.01,7,2.886,2.9369825876452293,8.487943582999986,2420,1.8063328610651297e-13,25009,17634,18,54
6,6,7,3000,ls_growth,0.01,8,2.886,2.919952132828037,7.777095625000016,1864,7.416289804496046e-14,25774,18086,19,55
6,6,7,3000,ls_growth,0.01,9,2.886,2.8959017847653294,7.247181042000011,2879,1.220135104063047e-13,23043,15877,10,52
6,6,7,3000,ls_growth,0.01,10,2.886,2.9319729981090816,8.58557358299999,3000,3.4083846855992306e-14,25808,18665,13,56
6,6,7,3000,ls_growth,0.01,11,2.886,2.937415567587276,8.824165667000022,1915,-1.2212453270876722e-14,24836,18599,15,56
6,6,7,3000,ls_growth,0.01,12,2.886,2.89953845074872,6.858334832999971,2993,1.8129941992128806e-13,22703,15366,10,48
6,6,7,3000,ls_growth,0.01,13,2.886,2.9273036093198073,7.685338374999992,2546,5.861977570020827e-14,25839,18029,24,56
6,6,7,3000,ls_growth,0.01,14,2.886,2.9259450101703943,7.119612874999992,2515,-1.1324274851176597e-14,23948,16944,14,54
6,6,7,3000,ls_growth,0.01,15,2.886,2.932820027792843,6.746487458000018,2116,-6.772360450213455e-15,23457,16809,14,54
6,6,7,3000,ls_growth,0.01,16,2.886,2.9369238961704998,7.404217874999973,2150,-7.549516567451064e-15,24867,18119,18,58
6,6,7,3000,ls_growth,0.01,17,2.886,2.8900015306829316,8.88759470799996,3000,1.510295022377761e-8,25579,18888,16,57
6,6,7,3000,ls_growth,0.01,18,2.886,2.925550441154138,7.216730832999979,2263,1.9562129693895258e-13,22807,16699,18,51
6,6,7,3000,ls_growth,0.01,19,2.886,2.9239510471406325,7.55640949999995,2671,1.9584334154387761e-13,23826,16527,21,53
6,6,7,3000,ls_growth,0.01,20,2.886,2.8971779433189484,7.653426708000014,3000,3.319566843629218e-14,25199,17517,23,52
6,6,7,3000,penalty,0.01,1,2.886,2.9321920717999186,0.3751072910000221,2167,1.8407497748285095e-13,0,0,0,0
6,6,7,3000,penalty,0.01,2,2.886,3.3151459571656297,0.25199575000000185,2105,1.887379141862766e-13,0,0,0,0
6,6,7,3000,penalty,0.01,3,2.886,2.9320597210548143,0.28200258400000167,1800,1.829647544582258e-13,0,0,0,0
6,6,7,3000,penalty,0.01,4,2.886,2.935345148556891,0.36027350000001024,2213,1.915134717478395e-13,0,0,0,0
6,6,7,3000,penalty,0.01,5,2.886,2.918141566693692,0.2468314159999718,1524,2.0128343436454088e-13,0,0,0,0
6,6,7,3000,penalty,0.01,6,2.886,2.918168141956632,0.24769383300002665,1538,1.8951507030351422e-13,0,0,0,0
6,6,7,3000,penalty,0.01,7,2.886,3.6571935647781824,0.27041566699999386,1906,8.104628079763643e-15,0,0,0,0
6,6,7,3000,penalty,0.01,8,2.886,2.9181526274732694,0.5002105420000152,2641,1.851852005074761e-13,0,0,0,0
6,6,7,3000,penalty,0.01,9,2.886,2.91814644144812,0.27630554200004553,1711,1.8707257964933888e-13,0,0,0,0
6,6,7,3000,penalty,0.01,10,2.886,3.400300230361903,0.26512008399999465,1839,1.7386092565629951e-13,0,0,0,0
6,6,7,3000,penalty,0.01,11,2.886,2.9353076906893096,0.38027737500000514,2203,1.8196555373606316e-13,0,0,0,0
6,6,7,3000,penalty,0.01,12,2.886,3.335473442198699,0.40728833399998254,2855,8.104628079763643e-15,0,0,0,0
6,6,7,3000,penalty,0.01,13,2.886,3.315039024983836,0.5000087079999502,3000,6.761258219967203e-14,0,0,0,0
6,6,7,3000,penalty,0.01,14,2.886,3.325177886953813,0.18039808399998583,1230,1.9251267247000214e-13,0,0,0,0
6,6,7,3000,penalty,0.01,15,2.886,3.400000802735679,0.19435437499999533,1525,1.8740564655672642e-13,0,0,0,0
6,6,7,3000,penalty,0.01,16,2.886,3.5000001579994193,0.6492922499999986,3000,3.5311198409715416e-10,0,0,0,0
6,6,7,3000,penalty,0.01,17,2.886,3.601707958648532,0.2347392080000136,1587,9.026113190202523e-14,0,0,0,0
6,6,7,3000,penalty,0.01,18,2.886,2.918137355200933,0.3596444580000243,2070,1.8540724511240114e-13,0,0,0,0
6,6,7,3000,penalty,0.01,19,2.886,2.918142761009269,0.4672395000000251,2482,1.8141044222375058e-13,0,0,0,0
6,6,7,3000,penalty,0.01,20,2.886,2.9181319420910143,0.5265942500000238,2933,6.605826996519681e-14,0,0,0,0
0,0,30,30000,ls_growth,0.01,1,6.197741070879227,6.197744497564272,7.621584875000001,4550,1.8207657603852567e-13,67801,67561,20015,49
0,0,30,30000,ls_growth,0.01,2,6.197741070879227,6.197741070879717,6.779622083000024,5480,3.8191672047105385e-14,66310,66059,19462,49
0,0,30,30000,ls_growth,0.01,3,6.197741070879227,6.197746860728935,8.745377875000006,6126,6.661338147750939e-15,83057,82830,24752,56
0,0,30,30000,ls_growth,0.01,4,6.197741070879227,6.197746775624101,7.820902292000014,5008,0,65008,64749,19570,48
0,0,30,30000,ls_growth,0.01,5,6.197741070879227,6.199720437567898,6.3874417090000355,5041,1.7985612998927536e-13,67919,67663,20494,49
0,0,30,30000,ls_growth,0.01,6,6.197741070879227,6.1997204375679145,8.336413792000036,4633,1.6608936448392342e-13,63050,62829,19165,47
0,0,30,30000,ls_growth,0.01,7,6.197741070879227,6.197741070879746,6.4438420000000045,5180,7.549516567451064e-14,66748,66469,19475,49
0,0,30,30000,ls_growth,0.01,8,6.197741070879227,6.197758988552277,8.973565459000005,4376,0,65033,64800,19456,48
0,0,30,30000,ls_growth,0.01,9,6.197741070879227,6.197742389525328,9.09123791700002,5555,1.8429702208777599e-13,71908,71688,21186,52
0,0,30,30000,ls_growth,0.01,10,6.197741070879227,6.197741070879764,6.805849665999995,5606,1.5631940186722204e-13,69700,69451,20867,51
0,0,30,30000,ls_growth,0.01,11,6.197741070879227,6.197743995637462,8.483722083,5289,1.9229062786507711e-13,68630,68383,20171,50
0,0,30,30000,ls_growth,0.01,12,6.197741070879227,6.19774107087975,5.771243957999977,5437,1.474376176702208e-13,71482,71223,21695,51
0,0,30,30000,ls_growth,0.01,13,6.197741070879227,6.197741070879649,6.477449792,5868,4.884981308350689e-15,70744,70491,20236,51
0,0,30,30000,ls_growth,0.01,14,6.197741070879227,6.197745096999188,6.8614332909999645,4514,9.769962616701378e-15,67240,66971,20038,49
0,0,30,30000,ls_growth,0.01,15,6.197741070879227,6.1997856182217665,6.877410583999997,4343,1.9095836023552692e-13,64476,64241,19176,48
0,0,30,30000,ls_growth,0.01,16,6.197741070879227,6.199730125959069,7.5278719170000405,4463,1.900701818158268e-13,66400,66135,20008,50
0,0,30,30000,ls_growth,0.01,17,6.197741070879227,6.199724635145351,7.192349667000002,4431,1.9184653865522705e-13,65892,65670,19986,50
0,0,30,30000,ls_growth,0.01,18,6.197741070879227,6.197741070879745,6.465310166999989,5423,1.509903313490213e-14,64220,63956,19055,48
0,0,30,30000,ls_growth,0.01,19,6.197741070879227,6.19774372407966,7.259137584000011,5132,1.8429702208777599e-13,66432,66195,20248,49
0,0,30,30000,ls_growth,0.01,20,6.197741070879227,6.199728996568942,7.295982167000009,4531,8.43769498715119e-15,67500,67255,20287,50
0,0,30,30000,penalty,0.01,1,6.197741070879227,6.342710588128921,1.081996832999983,1265,1.8118839761882555e-13,0,0,0,0
0,0,30,30000,penalty,0.01,2,6.197741070879227,6.197741070879715,2.3954425000000046,2319,4.263256414560601e-14,0,0,0,0
0,0,30,30000,penalty,0.01,3,6.197741070879227,6.201217270889367,1.5338464579999562,1967,1.6919798895287386e-13,0,0,0,0
0,0,30,30000,penalty,0.01,4,6.197741070879227,6.201217270889362,1.2126717920000083,1375,1.6786572132332367e-13,0,0,0,0
0,0,30,30000,penalty,0.01,5,6.197741070879227,6.3863677616346335,0.9266095000000205,1189,1.5498713423767185e-13,0,0,0,0
0,0,30,30000,penalty,0.01,6,6.197741070879227,6.199720437567908,1.0824386670000385,1252,1.6964207816272392e-13,0,0,0,0
0,0,30,30000,penalty,0.01,7,6.197741070879227,6.199720437567897,1.6158988750000136,1840,1.6697754290362354e-13,0,0,0,0
0,0,30,30000,penalty,0.01,8,6.197741070879227,6.197741070879639,2.8161092079999506,1828,4.263256414560601e-14,0,0,0,0
0,0,30,30000,penalty,0.01,9,6.197741070879227,6.199720437567844,2.0862540000000154,1104,9.947598300641403e-14,0,0,0,0
0,0,30,30000,penalty,0.01,10,6.197741070879227,6.197741070879702,5.722402292000013,2507,2.2648549702353193e-14,0,0,0,0
0,0,30,30000,penalty,0.01,11,6.197741070879227,6.3324993289754214,5.173176167000027,2391,9.237055564881302e-14,0,0,0,0
0,0,30,30000,penalty,0.01,12,6.197741070879227,6.201217270889341,2.7317708749999876,1154,1.7008616737257398e-13,0,0,0,0
0,0,30,30000,penalty,0.01,13,6.197741070879227,6.386367761634626,1.4177161249999772,1038,1.6298074001497298e-13,0,0,0,0
0,0,30,30000,penalty,0.01,14,6.197741070879227,6.442191151752,0.422971583000035,438,4.440892098500626e-15,0,0,0,0
0,0,30,30000,penalty,0.01,15,6.197741070879227,6.1977410708796885,3.7658364160000346,2352,6.17284001691587e-14,0,0,0,0
0,0,30,30000,penalty,0.01,16,6.197741070879227,6.2012172708893525,2.249309332999983,2159,1.7186252421197423e-13,0,0,0,0
0,0,30,30000,penalty,0.01,17,6.197741070879227,6.442191151752051,0.23440054199995938,396,1.865174681370263e-14,0,0,0,0
0,0,30,30000,penalty,0.01,18,6.197741070879227,6.321160223736889,2.156297499999986,2193,4.1744385725905886e-14,0,0,0,0
0,0,30,30000,penalty,0.01,19,6.197741070879227,6.303545724206896,1.2031076250000041,1326,1.7497114868092467e-13,0,0,0,0
0,0,30,30000,penalty,0.01,20,6.197741070879227,6.199720437567901,1.5008597919999738,1754,1.7053025658242404e-13,0,0,0,0
6,6,7,30000,ls_growth,0.01,1,2.886,2.9459833105238182,8.91526020900003,3744,1.9095836023552692e-13,28590,20205,20,62
6,6,7,30000,ls_growth,0.01,2,2.886,2.9254024050567096,8.156728332999977,3137,1.7541523789077473e-14,26214,18336,11,58
6,6,7,30000,ls_growth,0.01,3,2.886,2.9245485980098826,11.074017125000013,3192,1.7918999617450027e-13,26991,19817,19,60
6,6,7,30000,ls_growth,0.01,4,2.886,2.8926586741942644,10.281285207999987,4029,8.570921750106208e-14,27324,20327,18,61
6,6,7,30000,ls_growth,0.01,5,2.886,2.9431847471369488,8.269556749999989,2628,1.8807178037150152e-13,23098,16319,18,54
6,6,7,30000,ls_growth,0.01,6,2.886,2.9066812264067226,9.107690000000002,3422,1.9051427102567686e-13,26216,19113,15,58
6,6,7,30000,ls_growth,0.01,7,2.886,2.9369577071158814,9.432048834000016,2559,1.8962609260597674e-13,28618,21233,26,65
6,6,7,30000,ls_growth,0.01,8,2.886,2.919882290894966,8.942774666999991,3074,1.928457393773897e-13,28312,20602,34,65
6,6,7,30000,ls_growth,0.01,9,2.886,2.900553734411485,7.792137624999974,2655,1.2878587085651816e-14,26098,18905,14,58
6,6,7,30000,ls_growth,0.01,10,2.886,2.945176074357202,8.503583875000011,3698,1.0325074129013956e-14,27071,19891,16,60
6,6,7,30000,ls_growth,0.01,11,2.886,2.9428745506438405,7.7039936250000025,2026,1.928457393773897e-13,25837,19624,18,59
6,6,7,30000,ls_growth,0.01,12,2.886,2.9340069333785763,7.133947792000021,1982,2.0039525594484076e-13,24871,17558,17,55
6,6,7,30000,ls_growth,0.01,13,2.886,2.9429517613261713,8.36160954200005,3326,3.5860203695392556e-14,28136,20348,22,62
6,6,7,30000,ls_growth,0.01,14,2.886,2.9057257625968447,7.777504165999999,3241,1.532107773982716e-14,25937,18909,21,60
6,6,7,30000,ls_growth,0.01,15,2.886,2.9343727357793186,7.601122499999998,2277,2.0083934515469082e-13,26258,19557,19,61
6,6,7,30000,ls_growth,0.01,16,2.886,2.9358337264231915,7.745430958000012,2401,1.9961809982760315e-13,25850,19105,17,61
6,6,7,30000,ls_growth,0.01,17,2.886,2.8932894141179943,18.053310707999977,3982,1.9984014443252818e-13,27507,20833,24,63
6,6,7,30000,ls_growth,0.01,18,2.886,2.925550441154138,9.95862645900005,2263,1.9562129693895258e-13,22807,16699,18,51
6,6,7,30000,ls_growth,0.01,19,2.886,2.9239930627960784,8.880064542000007,2760,1.8685053504441385e-13,27754,20454,21,65
6,6,7,30000,ls_growth,0.01,20,2.886,2.898256583056806,8.879653624999976,3829,3.8191672047105385e-14,28445,20743,19,62
6,6,7,30000,penalty,0.01,1,2.886,2.9321920717999186,0.37843724999995904,2167,1.8407497748285095e-13,0,0,0,0
6,6,7,30000,penalty,0.01,2,2.886,3.3151459571656297,0.24611945800005924,2105,1.887379141862766e-13,0,0,0,0
6,6,7,30000,penalty,0.01,3,2.886,2.9320597210548143,0.2944576670000097,1800,1.829647544582258e-13,0,0,0,0
6,6,7,30000,penalty,0.01,4,2.886,2.935345148556891,0.3749965000000084,2213,1.915134717478395e-13,0,0,0,0
6,6,7,30000,penalty,0.01,5,2.886,2.918141566693692,0.2467820420000935,1524,2.0128343436454088e-13,0,0,0,0
6,6,7,30000,penalty,0.01,6,2.886,2.918168141956632,0.2416212499999674,1538,1.8951507030351422e-13,0,0,0,0
6,6,7,30000,penalty,0.01,7,2.886,3.6571935647781824,0.2545113340000389,1906,8.104628079763643e-15,0,0,0,0
6,6,7,30000,penalty,0.01,8,2.886,2.9181526274732694,0.4692782910000533,2641,1.851852005074761e-13,0,0,0,0
6,6,7,30000,penalty,0.01,9,2.886,2.91814644144812,0.276970250000013,1711,1.8707257964933888e-13,0,0,0,0
6,6,7,30000,penalty,0.01,10,2.886,3.400300230361903,0.2722958339999896,1839,1.7386092565629951e-13,0,0,0,0
6,6,7,30000,penalty,0.01,11,2.886,2.9353076906893096,0.3904436249999562,2203,1.8196555373606316e-13,0,0,0,0
6,6,7,30000,penalty,0.01,12,2.886,3.335473442198699,0.4130239999999758,2855,8.104628079763643e-15,0,0,0,0
6,6,7,30000,penalty,0.01,13,2.886,3.315037218723519,0.6215076249999693,3551,1.7286172493413687e-13,0,0,0,0
6,6,7,30000,penalty,0.01,14,2.886,3.325177886953813,0.1781231250000419,1230,1.9251267247000214e-13,0,0,0,0
6,6,7,30000,penalty,0.01,15,2.886,3.400000802735679,0.17524204200005625,1525,1.8740564655672642e-13,0,0,0,0
6,6,7,30000,penalty,0.01,16,2.886,3.500000111364899,0.9586011670000153,4692,1.944000516118649e-13,0,0,0,0
6,6,7,30000,penalty,0.01,17,2.886,3.601707958648532,0.24320395799994002,1587,9.026113190202523e-14,0,0,0,0
6,6,7,30000,penalty,0.01,18,2.886,2.918137355200933,0.3701459169998998,2070,1.8540724511240114e-13,0,0,0,0
6,6,7,30000,penalty,0.01,19,2.886,2.918142761009269,0.45826079199998637,2482,1.8141044222375058e-13,0,0,0,0
6,6,7,30000,penalty,0.01,20,2.886,2.9181319420910143,0.4784344170000404,2933,6.605826996519681e-14,0,0,0,0
0,0,30,30000,ls_growth,0.001,1,6.197741070879227,6.197757962104103,20.731364500000026,19275,4.440892098500626e-16,303414,300962,83986,21
0,0,30,30000,ls_growth,0.001,2,6.197741070879227,6.1997204375679065,12.640201957999961,13997,1.7141843500212417e-13,214377,211470,58083,15
0,0,30,30000,ls_growth,0.001,3,6.197741070879227,6.197743830582968,19.378043999999996,19021,1.7053025658242404e-13,294236,291897,81632,20
0,0,30,30000,ls_growth,0.001,4,6.197741070879227,6.199800091235348,14.200930249999976,13538,1.780797731498751e-13,211632,209044,60839,14
0,0,30,30000,ls_growth,0.001,5,6.197741070879227,6.197755079583335,20.566529958999947,20056,1.9095836023552692e-13,315906,313422,89180,22
0,0,30,30000,ls_growth,0.001,6,6.197741070879227,6.21019435059978,6.884932416999946,5316,9.325873406851315e-15,80096,77551,22788,4
0,0,30,30000,ls_growth,0.001,7,6.197741070879227,6.199862917653432,14.893669084000052,14816,1.91402449445377e-13,232080,229368,69066,15
0,0,30,30000,ls_growth,0.001,8,6.197741070879227,6.200910849790763,8.066135875000036,6975,1.9273471707492718e-13,106624,103889,29137,6
0,0,30,30000,ls_growth,0.001,9,6.197741070879227,6.197813952124082,15.653688834000029,14837,2.6645352591003757e-15,232432,229771,67612,16
0,0,30,30000,ls_growth,0.001,10,6.197741070879227,6.199932728753263,10.214267292000004,9707,1.8829382497642655e-13,150336,147348,41000,9
0,0,30,30000,ls_growth,0.001,11,6.197741070879227,6.199410336521423,10.771902291000005,9909,1.9451107391432743e-13,153568,150855,45654,10
0,0,30,30000,ls_growth,0.001,12,6.197741070879227,6.197849177768914,18.177532583000023,16708,7.105427357601002e-15,262368,259571,74043,18
0,0,30,30000,ls_growth,0.001,13,6.197741070879227,6.197746336815154,21.591789249999913,21200,1.9451107391432743e-13,323721,321001,94056,23
0,0,30,30000,ls_growth,0.001,14,6.197741070879227,6.199814274584556,10.586817833999987,10553,1.8252066524837574e-13,163872,161141,46477,10
0,0,30,30000,ls_growth,0.001,15,6.197741070879227,6.19972043756791,12.365401333999937,13706,1.7497114868092467e-13,209859,206951,56890,14
0,0,30,30000,ls_growth,0.001,16,6.197741070879227,6.197741070879748,19.497616457999918,20099,1.5765166949677223e-13,304918,302055,87196,21
0,0,30,30000,ls_growth,0.001,17,6.197741070879227,6.19774107087967,14.81423533299996,15101,9.725553695716371e-14,222699,220062,62176,14
0,0,30,30000,ls_growth,0.001,18,6.197741070879227,6.197757773019236,18.903284290999988,17713,7.549516567451064e-15,278437,275870,80396,19
0,0,30,30000,ls_growth,0.001,19,6.197741070879227,6.197819321221211,15.590380374999949,13882,1.9184653865522705e-13,217136,214284,61885,14
0,0,30,30000,ls_growth,0.001,20,6.197741070879227,6.199985995264028,13.038301790999947,13384,1.936228954946273e-13,209168,206635,60824,13
0,0,30,30000,ls_growth,0.1,1,6.197741070879227,6.381252565731324,3.0533694159999722,860,1.865174681370263e-13,8745,8733,2440,68
0,0,30,30000,ls_growth,0.1,2,6.197741070879227,6.206723794995471,2.277228833000059,930,1.9273471707492718e-13,9851,9837,2898,70
0,0,30,30000,ls_growth,0.1,3,6.197741070879227,6.296423748634927,2.259239707999979,866,1.745270594710746e-13,8821,8800,2571,67
0,0,30,30000,ls_growth,0.1,4,6.197741070879227,6.3195750168619,3.529543874999974,854,1.8962609260597674e-13,8664,8646,2529,67
0,0,30,30000,ls_growth,0.1,5,6.197741070879227,6.201251017164415,3.1054438330000265,954,1.7053025658242404e-13,10271,10251,2746,73
0,0,30,30000,ls_growth,0.1,6,6.197741070879227,6.203160584875219,2.8989150000000374,919,1.7008616737257398e-13,9684,9675,2560,68
0,0,30,30000,ls_growth,0.1,7,6.197741070879227,6.200063571004741,3.5459767500000305,880,1.8207657603852567e-13,9084,9054,2521,68
0,0,30,30000,ls_growth,0.1,8,6.197741070879227,6.200059250190336,3.2425198330000278,933,1.7763568394002505e-15,9934,9917,2903,70
0,0,30,30000,ls_growth,0.1,9,6.197741070879227,6.201138191053753,3.127057708000066,928,1.6964207816272392e-13,9851,9834,2714,68
0,0,30,30000,ls_growth,0.1,10,6.197741070879227,6.289618877322561,3.13113512500003,944,1.936228954946273e-13,10091,10072,2682,69
0,0,30,30000,ls_growth,0.1,11,6.197741070879227,6.199720437567892,3.031081833000062,1476,1.709743457922741e-13,10053,10038,2647,69
0,0,30,30000,ls_growth,0.1,12,6.197741070879227,6.319632112585898,3.0900770419999026,874,1.8207657603852567e-13,8981,8964,2489,67
0,0,30,30000,ls_growth,0.1,13,6.197741070879227,6.292457177172831,2.3653753329999745,909,1.7719159473017498e-13,9529,9509,2585,67
0,0,30,30000,ls_growth,0.1,14,6.197741070879227,6.206118047743768,2.289625457999995,980,1.7674750552032492e-13,10632,10611,2747,72
0,0,30,30000,ls_growth,0.1,15,6.197741070879227,6.351983126993097,2.7174998329998927,930,1.7763568394002505e-13,9874,9850,3032,70
0,0,30,30000,ls_growth,0.1,16,6.197741070879227,6.292532084543527,4.291038792000036,962,1.745270594710746e-13,10392,10373,2731,69
0,0,30,30000,ls_growth,0.1,17,6.197741070879227,6.198559330606427,3.694716832999955,856,1.9184653865522705e-13,8698,8678,2399,67
0,0,30,30000,ls_growth,0.1,18,6.197741070879227,6.363484899224171,2.1243950000000185,922,1.7363888105137448e-13,9709,9692,2710,69
0,0,30,30000,ls_growth,0.1,19,6.197741070879227,6.306359688180729,2.355022208000068,1277,1.6964207816272392e-13,8683,8662,2404,68
0,0,30,30000,ls_growth,0.1,20,6.197741070879227,6.198358303513708,3.576701000000001,854,1.971756091734278e-13,8641,8625,2488,67
4,4,5,3000,ls_growth,0.01,1,2.70710678118654,3.0006189434810415,2.8441408339999614,1711,-7.66053886991358e-15,25135,17019,5,69
4,4,5,3000,ls_growth,0.01,2,2.70710678118654,2.9883189785585307,3.577292250000057,3000,-6.661338147750939e-16,26509,19877,14,57
4,4,5,3000,ls_growth,0.01,3,2.70710678118654,2.828431087246571,2.750323541999911,3000,1.999511667349907e-13,24913,15225,15,55
4,4,5,3000,ls_growth,0.01,4,2.70710678118654,2.768296265764894,3.012687791000004,2676,8.393286066166183e-14,26715,17660,12,63
4,4,5,3000,ls_growth,0.01,5,2.70710678118654,2.7682477483373287,2.9657645410000115,2348,1.7386092565629951e-13,26354,16747,17,56
4,4,5,3000,ls_growth,0.01,6,2.70710678118654,2.981584771365567,3.7113612910000375,3000,2.3092638912203256e-14,29217,20487,14,58
4,4,5,3000,ls_growth,0.01,7,2.70710678118654,2.8385366495904742,2.996821708000032,1934,1.7497114868092467e-13,25595,17658,7,63
4,4,5,3000,ls_growth,0.01,8,2.70710678118654,2.707106781188775,3.0548812499999767,2381,1.871836019518014e-13,27694,18126,11,63
4,4,5,3000,ls_growth,0.01,9,2.70710678118654,3.0000001032333334,2.708271249999991,1964,4.007905118896815e-14,23369,15340,8,62
4,4,5,3000,ls_growth,0.01,10,2.70710678118654,3.0000002713415648,2.859001874999958,1839,6.261657858885883e-14,25997,16857,13,64
4,4,5,3000,ls_growth,0.01,11,2.70710678118654,3.000791865628622,3.7884743749999905,2087,2.453592884421596e-14,29441,22072,22,69
4,4,5,3000,ls_growth,0.01,12,2.70710678118654,2.779618433771208,2.474956292000017,2047,-1.021405182655144e-14,20540,14387,15,53
4,4,5,3000,ls_growth,0.01,13,2.70710678118654,2.707106781188266,2.593251166000031,1881,1.9384494009955233e-13,20830,15607,12,57
4,4,5,3000,ls_growth,0.01,14,2.70710678118654,2.978381736416748,3.2124015000000363,1884,1.8418599978531347e-13,26361,18464,14,55
4,4,5,3000,ls_growth,0.01,15,2.70710678118654,2.859046147870808,2.8228211669999874,3000,-5.329070518200751e-15,25885,16328,11,59
4,4,5,3000,ls_growth,0.01,16,2.70710678118654,3.000026572248632,3.794329083999968,2009,1.6719958750854857e-13,29681,22202,19,71
4,4,5,3000,ls_growth,0.01,17,2.70710678118654,2.974766135613977,3.9914854999999516,3000,9.947598300641403e-14,30073,22892,32,65
4,4,5,3000,ls_growth,0.01,18,2.70710678118654,2.828427347067089,2.9866751669999214,3000,4.819902255093211e-9,27086,17249,9,59
4,4,5,3000,ls_growth,0.01,19,2.70710678118654,2.828429888270767,3.107333332999959,3000,2.0017321133991572e-13,25871,17993,9,63
4,4,5,3000,ls_growth,0.01,20,2.70710678118654,2.7760946120276597,3.0744961670000337,1797,1.7685852782278744e-13,25450,18386,10,60
4,4,5,3000,penalty,0.01,1,2.70710678118654,3.0000000000009694,0.03886304199998267,426,-1.0769163338864018e-14,0,0,0,0
4,4,5,3000,penalty,0.01,2,2.70710678118654,3.0000000000006435,0.032896833000006155,406,-1.1324274851176597e-14,0,0,0,0
4,4,5,3000,penalty,0.01,3,2.70710678118654,2.7688784845431287,0.11569341700000223,1499,1.7608137170554983e-13,0,0,0,0
4,4,5,3000,penalty,0.01,4,2.70710678118654,3.000000000000431,0.02108962500002235,243,1.801891968966629e-13,0,0,0,0
4,4,5,3000,penalty,0.01,5,2.70710678118654,3.0000000000006755,0.031847125000087545,434,1.509903313490213e-14,0,0,0,0
4,4,5,3000,penalty,0.01,6,2.70710678118654,3.0000000000004996,0.0447853340000147,595,1.6975310046518644e-13,0,0,0,0
4,4,5,3000,penalty,0.01,7,2.70710678118654,3.0000000000013665,0.028633459000033328,350,1.0658141036401503e-14,0,0,0,0
4,4,5,3000,penalty,0.01,8,2.70710678118654,3.0000000000012483,0.03734037500002887,401,-1.2323475573339238e-14,0,0,0,0
4,4,5,3000,penalty,0.01,9,2.70710678118654,3.000000000000894,0.03017858399997931,345,1.942890293094024e-14,0,0,0,0
4,4,5,3000,penalty,0.01,10,2.70710678118654,3.0000000000007634,0.0398076669999864,518,5.295763827461997e-14,0,0,0,0
4,4,5,3000,penalty,0.01,11,2.70710678118654,2.942809041586721,0.1354686670000665,1595,1.936228954946273e-13,0,0,0,0
4,4,5,3000,penalty,0.01,12,2.70710678118654,2.76776755350893,0.05204137499991339,758,1.6919798895287386e-13,0,0,0,0
4,4,5,3000,penalty,0.01,13,2.70710678118654,3.000000000000402,0.03857708299998194,558,1.603162047558726e-13,0,0,0,0
4,4,5,3000,penalty,0.01,14,2.70710678118654,3.0000000000012315,0.020791291999979877,233,7.4495964952348e-14,0,0,0,0
4,4,5,3000,penalty,0.01,15,2.70710678118654,3.0000000000006604,0.027818042000057174,394,3.319566843629218e-14,0,0,0,0
4,4,5,3000,penalty,0.01,16,2.70710678118654,2.9428090415864747,0.08987487499997951,930,1.794120407794253e-13,0,0,0,0
4,4,5,3000,penalty,0.01,17,2.70710678118654,3.0000000000008176,0.04320750000001863,422,1.2878587085651816e-14,0,0,0,0
4,4,5,3000,penalty,0.01,18,2.70710678118654,3.0000000000006852,0.029289375000051222,346,9.048317650695026e-14,0,0,0,0
4,4,5,3000,penalty,0.01,19,2.70710678118654,3.000000000000604,0.03831316599994898,492,-1.6986412276764895e-14,0,0,0,0
4,4,5,3000,penalty,0.01,20,2.70710678118654,3.000000000000846,0.03888195899990387,581,7.205347429817266e-14,0,0,0,0
4,4,5,30000,ls_growth,0.01,1,2.70710678118654,3.000292113404668,3.206724167000037,1874,-4.3298697960381105e-15,28019,19846,9,84
4,4,5,30000,ls_growth,0.01,2,2.70710678118654,2.988289015802321,3.683758167000022,5383,-1.099120794378905e-14,26509,19877,14,57
4,4,5,30000,ls_growth,0.01,3,2.70710678118654,2.878553111956102,3.493451207999955,5814,1.894040480010517e-13,28583,18917,13,69
4,4,5,30000,ls_growth,0.01,4,2.70710678118654,2.7684035049902023,3.4825046660000227,5792,2.9531932455029164e-14,28689,19674,15,69
4,4,5,30000,ls_growth,0.01,5,2.70710678118654,2.7681514559302465,3.968516292000073,5300,7.993605777301127e-14,31573,22084,20,77
4,4,5,30000,ls_growth,0.01,6,2.70710678118654,2.9668458452715525,4.743082291999948,5812,1.5232259897857148e-13,34880,26150,16,74
4,4,5,30000,ls_growth,0.01,7,2.70710678118654,2.8395412002383877,3.33189858300006,1880,6.927791673660977e-14,27864,19902,13,72
4,4,5,30000,ls_growth,0.01,8,2.70710678118654,2.7071067811889686,4.057541124999989,2710,1.7896795156957523e-13,34738,24942,24,89
4,4,5,30000,ls_growth,0.01,9,2.70710678118654,2.9991601272865176,3.79816858399997,4540,1.9317880628477724e-13,29411,21476,12,83
4,4,5,30000,ls_growth,0.01,10,2.70710678118654,2.981827425548461,3.9005957079998916,2685,1.8351986597053838e-13,31526,22489,12,81
4,4,5,30000,ls_growth,0.01,11,2.70710678118654,2.707106781188936,4.025713833999936,2472,1.7552626019323725e-13,31245,23388,11,77
4,4,5,30000,ls_growth,0.01,12,2.70710678118654,2.779618433771208,2.4684000829999566,2047,-1.021405182655144e-14,20540,14387,15,53
4,4,5,30000,ls_growth,0.01,13,2.70710678118654,2.707106781188266,2.587916666999925,1881,1.9384494009955233e-13,20830,15607,12,57
4,4,5,30000,ls_growth,0.01,14,2.70710678118654,2.978381736416748,3.207544625000097,1884,1.8418599978531347e-13,26361,18464,14,55
4,4,5,30000,ls_growth,0.01,15,2.70710678118654,2.858007380423411,3.79129137500003,5882,1.9528823003156504e-13,31233,21765,26,75
4,4,5,30000,ls_growth,0.01,16,2.70710678118654,2.984959443877274,4.8695586249999465,2507,7.049916206369744e-14,36212,28880,34,88
4,4,5,30000,ls_growth,0.01,17,2.70710678118654,2.977081853042999,4.239600333999959,2526,1.3378187446733136e-13,32155,24995,26,71
4,4,5,30000,ls_growth,0.01,18,2.70710678118654,2.828427232727788,3.566818124999991,5694,1.8995915951336428e-13,29600,19775,10,64
4,4,5,30000,ls_growth,0.01,19,2.70710678118654,2.884632287714878,3.5129958750000223,5916,1.8429702208777599e-13,27409,19609,12,70
4,4,5,30000,ls_growth,0.01,20,2.70710678118654,2.7760946120276597,3.076770125000039,1797,1.7685852782278744e-13,25450,18386,10,60
4,4,5,30000,penalty,0.01,1,2.70710678118654,3.0000000000009694,0.0371739589999197,426,-1.0769163338864018e-14,0,0,0,0
4,4,5,30000,penalty,0.01,2,2.70710678118654,3.0000000000006435,0.03131462499999907,406,-1.1324274851176597e-14,0,0,0,0
4,4,5,30000,penalty,0.01,3,2.70710678118654,2.7688784845431287,0.11231912499992176,1499,1.7608137170554983e-13,0,0,0,0
4,4,5,30000,penalty,0.01,4,2.70710678118654,3.000000000000431,0.01895229200005997,243,1.801891968966629e-13,0,0,0,0
4,4,5,30000,penalty,0.01,5,2.70710678118654,3.0000000000006755,0.030280374999972992,434,1.509903313490213e-14,0,0,0,0
4,4,5,30000,penalty,0.01,6,2.70710678118654,3.0000000000004996,0.044524499999941326,595,1.6975310046518644e-13,0,0,0,0
4,4,5,30000,penalty,0.01,7,2.70710678118654,3.0000000000013665,0.026805625000037255,350,1.0658141036401503e-14,0,0,0,0
4,4,5,30000,penalty,0.01,8,2.70710678118654,3.0000000000012483,0.03204387499997392,401,-1.2323475573339238e-14,0,0,0,0
4,4,5,30000,penalty,0.01,9,2.70710678118654,3.000000000000894,0.029153374999994413,345,1.942890293094024e-14,0,0,0,0
4,4,5,30000,penalty,0.01,10,2.70710678118654,3.0000000000007634,0.0384175830000313,518,5.295763827461997e-14,0,0,0,0
4,4,5,30000,penalty,0.01,11,2.70710678118654,2.942809041586721,0.13105166699993423,1595,1.936228954946273e-13,0,0,0,0
4,4,5,30000,penalty,0.01,12,2.70710678118654,2.76776755350893,0.05144599999999627,758,1.6919798895287386e-13,0,0,0,0
4,4,5,30000,penalty,0.01,13,2.70710678118654,3.000000000000402,0.03864916700008325,558,1.603162047558726e-13,0,0,0,0
4,4,5,30000,penalty,0.01,14,2.70710678118654,3.0000000000012315,0.021967458999948578,233,7.4495964952348e-14,0,0,0,0
4,4,5,30000,penalty,0.01,15,2.70710678118654,3.0000000000006604,0.02800612499995623,394,3.319566843629218e-14,0,0,0,0
4,4,5,30000,penalty,0.01,16,2.70710678118654,2.9428090415864747,0.08864891699992586,930,1.794120407794253e-13,0,0,0,0
4,4,5,30000,penalty,0.01,17,2.70710678118654,3.0000000000008176,0.03651108399999794,422,1.2878587085651816e-14,0,0,0,0
4,4,5,30000,penalty,0.01,18,2.70710678118654,3.0000000000006852,0.02904233299999032,346,9.048317650695026e-14,0,0,0,0
4,4,5,30000,penalty,0.01,19,2.70710678118654,3.000000000000604,0.03958220899989828,492,-1.6986412276764895e-14,0,0,0,0
4,4,5,30000,penalty,0.01,20,2.70710678118654,3.000000000000846,0.04131287499994505,581,7.205347429817266e-14,0,0,0,0
```

</details>


## Independent acceptance checks (2026-10-10)

[CALC] An independent review found no code blocker. Its probe was rerun: 5,000 nonradial circular-wall event times agreed with gap bisection; 3,000 dynamics advances across 15 piece/container families and rotated walls remained feasible in scaled coordinates and unit containment. Raw division produced 24 tiny negative unit pair gaps (minimum −6.661338147750939e−16), which the method's submission repair addresses. All 600 observed method assessments had zero pair overlap and nonpositive explicit-wall depth. An initially paused run resumed after 50 ms and terminated on its 40 ms active-time budget with a valid, strict result (about 95 ms wall time in the rerun).

[CALC] Eighteen bounded fresh runs covering morph, ASC and LS across six shape pairs, including 100-sided pieces, all returned valid/strict results, stayed within 80 evaluations and were accepted by the actual in-memory server API with exactly the reported scores.

[CALC] The historical CSV structure was checked: 960 unique finite rows in 48 groups, each with seeds 1–20, no reported evaluation overruns, minimum reported pair gap −1.6986412276764895e−14. Saved poses are missing from this CSV, so those historical scores cannot be independently rescored from the preserved table alone. The full optimization, bond-order and throughput matrices were not rerun. Browser solver throughput, maximum-P latency and automatic 50-digit polish remain unverified. Polygon dynamics remain the documented sampled approximation; this check makes no new packing-record or benchmark-improvement claim.
