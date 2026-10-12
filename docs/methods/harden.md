# Soft-to-rigid hardening (`harden`)

[CALC] `harden` runs soft-to-rigid hardening, after Yohei Nakajima. Each run
starts every piece as its inscribed disk at a random pose in a roomy
container, compresses the disks under inward pressure, hardens them step by
step into the true polygons while the container keeps pushing, and settles
with the true shape. Only legalised true-shape arrangements with no
zero-tolerance overlap are scored through `ctx.evaluate`; a soft or rounded
state is never submitted. The method keeps the best of independent seeded
runs and leaves the final tightening to the framework's automatic polish.

## Acknowledgement

Soft-to-rigid hardening is the work of **Yohei Nakajima**. The idea, the shape
family, the paths, the three-phase schedule, the energy, the momentum update,
the default pressure, noise, softness, scale, step counts and start area used
here, and all the published findings quoted on this page are his. He published the method, the paper, the code, the pre-registered
experiments (including the ones that went against the method) and replays of
the runs openly under the MIT licence. This implementation exists because of
that openness. Thank you.

- Site: <https://yoheinakajima.github.io/soft-to-rigid/>
- Repository: <https://github.com/yoheinakajima/soft-to-rigid>
- Paper: Yohei Nakajima, _Soft-to-Rigid: Shape Continuation as an Alternative
  Search for Packing Congruent Shapes_,
  [paper/main.pdf](https://github.com/yoheinakajima/soft-to-rigid/blob/main/paper/main.pdf)
  in the repository ([web version](https://yoheinakajima.github.io/soft-to-rigid/paper.html)).

What is whose on this page:

| Part                                                                                                                                      | Whose          | Label                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------ |
| The method: shape family, paths, energy, momentum dynamics, schedule, legalisation rule                                                   | Yohei Nakajima | [EST], from the paper and `engine2d.js`    |
| Default pressure, noise, softness, scale, step counts and start area; tuned settings                                                      | Yohei Nakajima | [EST], paper appendix and `methods/*.json` |
| Reported results about where hardening helps and where it does not                                                                        | Yohei Nakajima | [EST], repository README and paper         |
| Generalisation to every regular N-gon or circle in every regular M-gon or circle                                                          | PolyPack       | [CALC]                                     |
| Mapping of evaluation and time budgets onto the schedule (`evaluationInterval`, `restarts`); start handling                               | PolyPack       | [CALC]                                     |
| Rescaling of pressure and noise by the inscribed diameter; grid-based implementation of his legalisation rule, extended to scale together | PolyPack       | [CALC]                                     |
| Every number measured in this repository (tables below)                                                                                   | PolyPack       | [CALC]                                     |

No result on this page is a packing record or a benchmark-improvement claim.

## The method

[EST] Sources: the paper's Method section (`paper/sections/method.tex`) and the
reference 2D engine (`engine/engine2d.js`), both read on 2026-10-11.

**Shape family.** A piece is a regular polygon P with inradius rho. Its shape
state is `piece(gamma, tau) = gamma * [(1 - tau) P (+) tau rho D]`: the polygon
scaled about its incentre by `1 - tau`, dilated by a disk of radius `tau rho`,
all scaled by `gamma`. `tau = 1` is the inscribed disk, `tau = 0` the polygon,
and for `gamma <= 1` every state lies inside the polygon. Its area at
`gamma = 1` is `A - (A - pi rho^2) tau^2`, so a hardening piece gains the area
outside its inscribed disk: 21% of a square, 9% of a hexagon, 40% of a
triangle.

**Paths**, with u running from 0 to 1 over the middle phase:

| Path        | gamma                                    | tau                |
| ----------- | ---------------------------------------- | ------------------ |
| `harden`    | 1                                        | `tau0 (1 - u)`     |
| `grow`      | `gamma0 + (1 - gamma0) u`                | 0                  |
| `rigid`     | 1                                        | 0                  |
| `snap`      | 1                                        | 1 at u = 0, then 0 |
| `grow-area` | `sqrt(1 - (1 - pi rho^2 / A) (1 - u)^2)` | 0                  |

`snap` and `grow-area` are the paper's ablations: disks switched to polygons at
once, and rigid polygons grown along hardening's area schedule.

**Energy.** With `r = gamma tau rho` and `sd_ij` the signed distance between
the cores (exact distance when apart, minus the separating-axis penetration
depth when overlapping),
`E = sum_pairs (2r - sd_ij)_+^2 + sum_i sum_core-vertices (wall violation + r)_+^2 + mu L`,
where L is the container size, a free variable under inward pressure mu.

**Dynamics.** Momentum gradient descent: `v <- 0.85 v - 0.04 grad E` for x, y
and theta; `v_L <- 0.85 v_L - 0.02 (mu + dE/dL)`. A translation step is capped
at `0.03 sqrt(2) R` (R the circumradius), a rotation step at 0.03 rad and the
container step by the translation cap. Gaussian noise follows each step:
positional sigma `0.015 nu (1 - u)` while compressing and `0.004 nu (1 - u)`
along the path, angular noise 1.5 times the positional value. The rotation
gradient is zeroed while `tau >= 0.9999`. Where the paper and the engine
differ in the last digits, the constants here follow the paper: the
translation cap uses `sqrt(2)`, where the engine divides by 0.7071 (a
relative difference of 1e-5).

**One run.** Random poses in a container of area 3.2 times the total piece
area; then 2,500 B steps of compression at pressure `3 mu` with the path's
starting shape; 7,500 B steps along the path at pressure mu; 1,500 B settling
steps with the final shape, no noise, pressure `mu * 10^(-4 s / n_S)`. Then
legalise: scale the centres apart about their mean until no pair overlaps,
and measure the smallest container.

**Tuned settings.** Best-of-runs tuning (the paper's lowest-point tuning):
harden mu = 0.16, nu = 8; grow mu = 0.08, gamma0 = 0.1; rigid mu = 0.16,
nu = 8. Median tuning: harden mu = 0.08, nu = 8; grow mu = 0.04, gamma0 = 0.2;
rigid mu = 0.04, nu = 2. The engine's own defaults are mu = 0.02, nu = 1.

**Reported results** (repository README, campaign C07 and following; 32 runs
per method and instance): hardening is "not a better default": rigid starts
reach the lowest container on 155 of 188 instances, hardening on 142. It is "a
different search": on squares in a square hardening is lowest on 27 of 28
instances and the only search that low on 5, including n = 11 and n = 19. It
is lowest less often than rigid starts on both triangle families (14 vs 22,
18 vs 26) and "has a cost": on four held-out families it is lower than rigid
starts on 3 instances and higher on 17. The reference's pieces
are unit-side triangles, squares, pentagons, hexagons and octagons and
unit-**diameter** circles; its containers are a square, an equilateral
triangle and a circle.

## PolyPack's generalisation

[CALC] Everything in this section and the next two is PolyPack's adaptation.

**Geometry.** The reference's separating-axis code is not ported. The shape
state is exactly the disk-offset core that the shared penalty geometry already
supports (morph's inscribed family): core `scale = gamma (1 - tau)` and
`padding = gamma tau rho`. Pair terms use `pairPenetration`, whose `depth` is
`2r - sd`; wall terms use `visitContainerProtrusions` in its full
vertex-by-wall mode, as in the reference. Circle pieces are disks of radius
`gamma`. A pure inscribed disk (`tau = 1`) of a polygon meets each wall once
with its radius, like the reference. Any regular N-gon (3 to 100 sides) or
circle piece, in any regular M-gon or circular container, is handled by the
same code with the repository's conventions: polygon pieces have side 1 and a
vertex up at theta = 0, circle pieces have radius 1, and the moving container
is centred at the origin with a horizontal bottom edge (phi = 0). The final
container always comes from the repository's own evaluation: assessments use
`ctx.evaluate` at `container_phi = 0`, and the framework auto-orients and
polishes the best result.

**Circle pieces (N = 0).** A circle has no softer shape inside it, so there is
no shape path: `harden`, `snap` and `grow-area` are exactly the `rigid` path
for circles. Only `grow` changes a circle.

**Piece length unit.** The reference states mu and the noise in absolute
units for unit-side polygons and unit-diameter circles. Here both are
multiplied by the piece's inscribed diameter `2 rho` (2 for PolyPack's
radius-1 circles). This reproduces the reference exactly for unit squares
(inscribed diameter 1) and, by similarity, for circles (every length doubles).
For other polygons it is a deviation: the reference's absolute constants are
rescaled by 0.577 for triangles, 1.376 for pentagons, 1.732 for hexagons and
2.414 for octagons. It keeps pressure and noise proportionate for large N,
where a unit-side polygon is many units across. The step caps already scale
with the circumradius in the reference. Angular noise stays in radians.

**Container size variable.** The reference moves the side of a square or
triangle and the radius of a circle. A polygon's side per unit of apothem
shrinks as 1/M, which would make the same update ever stiffer for many-sided
containers. Here L is PolyPack's size (side) while the apothem per unit side
is at most 1 (M <= 6), and the apothem from M = 7 on, whose limit is the
reference's circle. M = 3, M = 4 and the circle are exactly the reference.

**Neighbour cut-off.** A pair is skipped when its centres are further apart
than twice the reach of the current soft shape, `2 (scale R + padding)`; no
such pair can touch. Up to 32 pieces every pair is distance-tested; above
that the shared cell grid (`nearbyPairs`) lists the candidates. A piece whose
reach stays inside the container's inscribed circle skips its wall terms.

## Budgets, evaluation accounting and restarts

[CALC] **Accounting rule.** As for `penalty`, `morph` and `basin_hopping`,
the budget counts framework geometry assessments (`ctx.evaluate`), not
analytic objective or gradient evaluations: those methods submit one restored
candidate per accepted L-BFGS iteration and do not count line-search calls;
`ls_growth` submits one per 16 events. `harden` submits one legalised
true-shape arrangement every `evaluationInterval` momentum steps (default 32)
and at the end of each run. An evaluation budget of E therefore buys exactly
`E * evaluationInterval` momentum steps, each of which is one energy gradient.
The interval of 32 was chosen for cost, not for quality: it puts the wall
time per counted evaluation in the range of the methods it is compared with
(table under Measurements). A five-seed preliminary run at 64 had been seen
when it was chosen; no quality comparison between intervals was made.

**Budget to steps.** The reference's budget is a step count. Here a
full-length run is `compressSteps + morphSteps + settleSteps` = 11,500 steps,
which costs `ceil(11500 / 32) = 360` assessments. With an evaluation
allowance A (what the framework leaves the method after its polish reserve of
one tenth):

- runs = `max(1, floor(A / 360))`, or `restarts` if that is positive, never
  more than A;
- each run receives `floor(remaining / runs left)` assessments and performs
  exactly that many times 32 steps;
- the steps are split in the full-length proportion (reference
  2500 : 7500 : 1500), the path phase taking the rounding remainder and at
  least one step.

So a run is never truncated mid-path under an evaluation budget: a small
budget shortens all three phases together (at the default interval the
shortest run is 32 steps: 7 compressing, 21 on the path, 4 settling at the
true shape); a large budget gives more independent runs, each of full length
to within one assessment's steps. Examples: 200 evaluations leave 180, one
run of 5,728 steps; 3,000 leave 2,700, seven runs of 12,320 to 12,352 steps;
30,000 leave 27,000, 75 runs of 11,488 to 11,520 steps. The reference's strength is best-of-many (32 runs per
instance), so more budget goes to more runs, not longer ones, unless
`restarts` fixes the count. The evaluation budget is exact and never
exceeded; it is a ceiling: an exact duplicate arrangement is not scored
twice. Scored arrangements are remembered as 64-bit hashes of their float64
pose values, the most recent 16,384 of them (at most 15 characters each,
under a megabyte in all, whatever P is; full-text signatures would need
about 29,000 characters each at P = 500). A hash collision between different
arrangements could only skip one re-assessment, never admit an invalid
submission, and it is the only way the hash could change a seeded result
compared with exact signatures.

**Time budgets.** Time is cooperative, through the framework's checkpoints.
With a time-only budget every run is full-length, runs follow each other
until the time expires, and the last run is cut where it is; its most recent
legalised state (at most 32 steps old) has been scored. No decision depends
on the clock when an evaluation budget is present, so a combined budget whose
time does not bind returns the evaluation-only result.

**Reproducibility.** All randomness (start poses, noise, coincident-centre
repair) comes from the framework's seeded stream; Gaussian draws are
Box–Muller from two stream draws, as in the reference. The same seed, problem,
parameters, start and evaluation budget give bit-identical results.

**Checkpoints, stop and pause.** A checkpoint is taken at entry, before each
run, and whenever 60,000 counted feature tests have accumulated (pair axes
and vertex-edge distances, wall tests, grid work and legalisation scans). The
gradient is assembled in parts no larger than a quarter of that, or one pair,
so a single gradient at P = 500 contains several checkpoints. Counting work
instead of reading a clock keeps the checkpoints of a seeded run identical
from run to run; a checkpoint draws no random number. Stop ends the method at
the next checkpoint or assessment without a further assessment; pause waits
in the framework's checkpoint and resumes to identical bits.

## Starts, legalisation, previews

[CALC] **Legalisation.** The current poses, read as true shapes, are scaled
about their mean centre to first contact: apart when true pieces overlap (the
reference's rule), together when none touch (a free improvement that cannot
create an overlap). The search is the bisection used by morph's shared
`rescale`, with the shared cell grid instead of an all-pairs scan
(`harden/legalise.ts`), which cut one assessment at P = 500 from about 92 ms
to about 17 ms. The result then passes the shared `restore("expand")`, which
also gives coincident centres a seeded separating move, and is submitted only
if `findOverlaps(..., 0)` is empty. Nothing with a zero-tolerance overlap is
ever submitted, so a result of this method is strict; the framework's rule
that a strict configuration always replaces a tolerance-only one is untouched.

**Supplied start.** A complete supplied arrangement replaces the random
start of the first run: its enclosing container at the stored orientation
becomes the moving container and all poses are expressed in that container's
frame (a rigid motion). That run has no compression phase; those steps go to
the path. Later runs restart at random. The framework has already scored the
start, so a valid start is never made worse. Hardening forgets orientations
by design (disks carry none and angular noise acts throughout); to refine an
existing packing rather than search from it, use the `rigid` path with a
small `noise`, or another method. An incomplete start is ignored.

**First assessment.** When the framework holds no valid start and the first
run has at least two assessments, one arrangement is scored before the
dynamics begin: the legalised supplied start if there is one, otherwise the
shared jitter-free grid (`scatter` with every draw 0.5, no seeded draw). A
stop or an expired time budget in the first steps then still returns a strict
result. This reads no clock.

**Previews.** Every assessment is an ordinary framework frame, so the Solve
panel's live preview shows only true-shape, valid arrangements. Mid-run
frames are the legalised current poses: during compression and early
hardening the true pieces overlap deeply and their legalisation is a loose,
scaled-apart arrangement that tightens as the pieces harden.

## Parameters and defaults

[CALC] The registered schema is an object with `additionalProperties:false`;
every node has a title and description and every property a default and
bounds. Defaults are the reference's best-of-runs tuning for `harden`.

| Parameter          | Default | Allowed values / purpose                                                               |
| ------------------ | ------- | -------------------------------------------------------------------------------------- |
| path               | harden  | harden, grow, rigid, snap, grow-area                                                   |
| pressure           | 0.16    | 0.0001–4; mu per inscribed diameter. Reference: 0.16 harden/rigid, 0.08 grow (best-of) |
| noise              | 8       | 0–64; noise multiplier nu. Reference: 8 harden/rigid (best-of), 2 rigid (median)       |
| tau0               | 1       | 0–1; starting softness of the harden path (reference ablations: 0.5, 0.25)             |
| gamma0             | 0.1     | 0.01–1; starting scale of the grow path (reference: 0.1 best-of, 0.2 median)           |
| compressSteps      | 2500    | Integer 0–1,000,000; compression steps of a full-length run                            |
| morphSteps         | 7500    | Integer 1–1,000,000; path steps of a full-length run                                   |
| settleSteps        | 1500    | Integer 0–1,000,000; settling steps of a full-length run                               |
| fill               | 3.2     | 1.05–50; starting container area over total piece area                                 |
| restarts           | 0       | Integer 0–100,000; number of runs, 0 = as many full-length runs as the budget allows   |
| evaluationInterval | 32      | Integer 1–100,000; momentum steps per counted assessment                               |

To run another reference setting, set its values: for example
`{"path":"grow","pressure":0.08,"noise":1,"gamma0":0.1}` or
`{"path":"rigid","pressure":0.04,"noise":2}`. The paper's appendix lists no
noise multiplier for grow; 1 is the engine's default. The Solve panel entry reads
"Soft-to-rigid hardening, after Yohei Nakajima".

## Fit and limitations

[EST] By the originator's own controlled study, hardening is not a better
default than rigid starts; it is a different search that reaches some
packings other searches miss (notably squares in a square) and loses on
triangles and on held-out families. Use it beside the other methods.

[CALC] Limits of this implementation:

- The measurements below cover seven problems and are small; they do not
  reproduce the reference's 188-instance study.
- Under a time budget that is shorter than one run (large P), the run is cut
  mid-path and the returned result is the best legalised state so far, at
  worst the starting grid. Shorten the three step counts for large problems
  under a time limit.
- Padded polygon pairs cost about N^2 vertex-edge distances each, so the
  harden path is slow for pieces with many sides (N = 64: about 0.4 ms per
  step for six pieces). Such pieces are nearly round and gain little from
  hardening.
- A run that diverges (non-finite or out-of-range pose) ends without a
  further assessment and the next run starts afresh.
- The legalised state after settling keeps a slack of order 1e-6 to 1e-5,
  which the framework's float64 polish removes only if its own allowance
  suffices (see the triangle rows below).
- A no-start run whose method allowance is zero (a one-evaluation budget is
  the polish reserve), an already-aborted run or a zero time budget returns
  no configuration; these are framework behaviours.
- Browser throughput was not measured separately; the P = 500 figures below
  are from Node.

## Deviations from the reference

[CALC]

1. Shared PolyPack geometry instead of the reference's separating-axis code;
   the neighbour cut-off uses the exact reach of the soft shape rather than
   `2 gamma R` (it drops only pairs that cannot touch).
2. Pressure and noise are in units of the inscribed diameter (exact for
   squares and circles, rescaled for other polygons); the size variable is
   the apothem for M >= 7.
3. Arbitrary N and M, with PolyPack's orientation conventions and radius-1
   circles.
4. The budget is an evaluation count mapped to steps, with one legalised
   assessment every 32 steps; the reference legalises once, at the end.
5. Legalisation also scales together when nothing touches, and its result
   must have zero overlap at tolerance 0 (the reference allows 1e-12).
6. Restarts share one seeded stream instead of one seed per run; the start
   placement draws from the container's bounding square of half-width equal
   to its circumradius, and a piece that finds no place clear of the walls
   in 200 trials is placed anywhere inside.
7. A supplied start, the first-assessment insurance and duplicate
   suppression have no counterpart in the reference.
8. The reference's separate tightening (SLSQP) and exact certification are
   not part of this method; the framework's float64 contact polish follows.
   The reference's `sa` and `pc` baselines and 3D engine are not implemented.

## Measurements

[CALC] Everything in this section was measured here, on this implementation,
on 2026-10-11: Apple M1 Pro, eight logical CPUs, Darwin arm64, Node v26.5.0.
The machine was heavily loaded by unrelated jobs (load average 40 to 80) and
five to seven benchmark processes ran at once, so every time below is an
observed wall time under load, not a throughput claim. Scores do not depend on
load: they are reproducible bits for a seed and an evaluation budget.

### Quality at an equal evaluation budget

[CALC] No supplied start, registered defaults, framework final polish enabled,
the same evaluation budget for every method, seeds 1 to 10 at 3,000
evaluations and 1 to 5 at 30,000. No seed was selected or omitted and no
parameter was tuned on these problems. "harden, rigid path" is this method
with `{"path":"rigid"}` (true pieces throughout, same schedule and
constants), the reference's own control. Every result was checked valid and
strict, with no evaluation overrun and a recomputed score within 1e-12; the
smallest pair separation over all 380 results is -8.09e-13 (19 squares,
harden path), inside the strict margin. "Published" is the
value stored in `data/records.json`: `2 + 1/sqrt(2)`, `3 + 1/sqrt(2)`,
3.877084 (11 squares), 4.885618 (19 squares), 3 (7 circles in a circle and
7 triangles in a triangle) and 3.879 (12 triangles, stored to three decimals,
so no hit counts are given). "Within" counts runs at most that far above the
published value. Seconds and evaluations are means per run.

#### 3,000 evaluations, seeds 1–10

| N/M/P  | Published | Method             | Seeds | Within 1e-4 | Within 1e-9 | Best     | Median   | Worst    | Mean seconds | Mean evals |
| ------ | --------- | ------------------ | ----- | ----------- | ----------- | -------- | -------- | -------- | ------------ | ---------- |
| 4/4/5  | 2.707107  | harden             | 1–10  | 9/10        | 9/10        | 2.707107 | 2.707107 | 2.767768 | 2.82         | 2962       |
| 4/4/5  | 2.707107  | harden, rigid path | 1–10  | 10/10       | 10/10       | 2.707107 | 2.707107 | 2.707107 | 2.91         | 2975       |
| 4/4/5  | 2.707107  | basin_hopping      | 1–10  | 2/10        | 2/10        | 2.707107 | 2.768167 | 2.828427 | 1.42         | 2874       |
| 4/4/5  | 2.707107  | morph              | 1–10  | 0/10        | 0/10        | 2.828427 | 2.828427 | 2.828427 | 1.90         | 1592       |
| 4/4/10 | 3.707107  | harden             | 1–10  | 10/10       | 2/10        | 3.707107 | 3.707107 | 3.707107 | 7.46         | 2985       |
| 4/4/10 | 3.707107  | harden, rigid path | 1–10  | 10/10       | 2/10        | 3.707107 | 3.707107 | 3.707107 | 6.54         | 2899       |
| 4/4/10 | 3.707107  | basin_hopping      | 1–10  | 0/10        | 0/10        | 3.707497 | 3.768827 | 4.000000 | 4.74         | 2937       |
| 4/4/10 | 3.707107  | morph              | 1–10  | 10/10       | 9/10        | 3.707107 | 3.707107 | 3.707172 | 1.92         | 2985       |
| 4/4/11 | 3.877084  | harden             | 1–10  | 3/10        | 0/10        | 3.877089 | 3.888495 | 3.890356 | 9.10         | 3000       |
| 4/4/11 | 3.877084  | harden, rigid path | 1–10  | 0/10        | 0/10        | 3.890393 | 3.890451 | 4.000001 | 7.40         | 2956       |
| 4/4/11 | 3.877084  | basin_hopping      | 1–10  | 0/10        | 0/10        | 3.924706 | 4.000000 | 4.000000 | 3.41         | 2810       |
| 4/4/11 | 3.877084  | morph              | 1–10  | 0/10        | 0/10        | 4.000000 | 4.000000 | 4.000000 | 1.77         | 2789       |
| 0/0/7  | 3.000000  | harden             | 1–10  | 10/10       | 10/10       | 3.000000 | 3.000000 | 3.000000 | 1.19         | 2801       |
| 0/0/7  | 3.000000  | harden, rigid path | 1–10  | 10/10       | 10/10       | 3.000000 | 3.000000 | 3.000000 | 2.44         | 2801       |
| 0/0/7  | 3.000000  | basin_hopping      | 1–10  | 10/10       | 10/10       | 3.000000 | 3.000000 | 3.000000 | 1.42         | 2789       |
| 0/0/7  | 3.000000  | morph              | 1–10  | 10/10       | 10/10       | 3.000000 | 3.000000 | 3.000000 | 0.04         | 146        |
| 3/3/7  | 3.000000  | harden             | 1–10  | 10/10       | 0/10        | 3.000000 | 3.000001 | 3.000002 | 4.98         | 3000       |
| 3/3/7  | 3.000000  | harden, rigid path | 1–10  | 10/10       | 0/10        | 3.000001 | 3.000002 | 3.000002 | 5.45         | 3000       |
| 3/3/7  | 3.000000  | basin_hopping      | 1–10  | 10/10       | 10/10       | 3.000000 | 3.000000 | 3.000000 | 2.62         | 2789       |
| 3/3/7  | 3.000000  | morph              | 1–10  | 10/10       | 10/10       | 3.000000 | 3.000000 | 3.000000 | 3.68         | 2789       |
| 3/3/12 | 3.879     | harden             | 1–10  | —           | —           | 3.879392 | 3.957261 | 3.998141 | 4.99         | 2958       |
| 3/3/12 | 3.879     | harden, rigid path | 1–10  | —           | —           | 3.879389 | 3.879392 | 3.916096 | 4.12         | 2899       |
| 3/3/12 | 3.879     | basin_hopping      | 1–10  | —           | —           | 3.942951 | 4.000000 | 4.000000 | 4.83         | 2852       |
| 3/3/12 | 3.879     | morph              | 1–10  | —           | —           | 4.000000 | 4.000000 | 4.000000 | 3.28         | 2789       |
| 4/4/19 | 4.885618  | harden             | 1–10  | 0/10        | 0/10        | 4.885924 | 4.887945 | 4.893468 | 8.60         | 2836       |
| 4/4/19 | 4.885618  | harden, rigid path | 1–10  | 0/10        | 0/10        | 5.000000 | 5.000001 | 5.000002 | 7.14         | 2887       |
| 4/4/19 | 4.885618  | basin_hopping      | 1–10  | 0/10        | 0/10        | 5.000000 | 5.000000 | 5.000000 | 12.89        | 2789       |
| 4/4/19 | 4.885618  | morph              | 1–10  | 0/10        | 0/10        | 4.912804 | 5.000000 | 5.000000 | 5.43         | 2852       |

#### 30,000 evaluations, seeds 1–5

| N/M/P  | Published | Method             | Seeds | Within 1e-4 | Within 1e-9 | Best     | Median   | Worst    | Mean seconds | Mean evals |
| ------ | --------- | ------------------ | ----- | ----------- | ----------- | -------- | -------- | -------- | ------------ | ---------- |
| 4/4/5  | 2.707107  | harden             | 1–5   | 5/5         | 5/5         | 2.707107 | 2.707107 | 2.707107 | 15.02        | 27285      |
| 4/4/5  | 2.707107  | harden, rigid path | 1–5   | 5/5         | 5/5         | 2.707107 | 2.707107 | 2.707107 | 11.80        | 27293      |
| 4/4/5  | 2.707107  | basin_hopping      | 1–5   | 5/5         | 5/5         | 2.707107 | 2.707107 | 2.707107 | 5.90         | 27089      |
| 4/4/5  | 2.707107  | morph              | 1–5   | 0/5         | 0/5         | 2.828427 | 2.828427 | 2.828427 | 0.65         | 1568       |
| 4/4/10 | 3.707107  | harden             | 1–5   | 5/5         | 2/5         | 3.707107 | 3.707107 | 3.707107 | 32.04        | 27362      |
| 4/4/10 | 3.707107  | harden, rigid path | 1–5   | 5/5         | 1/5         | 3.707107 | 3.707107 | 3.707107 | 28.95        | 27397      |
| 4/4/10 | 3.707107  | basin_hopping      | 1–5   | 5/5         | 5/5         | 3.707107 | 3.707107 | 3.707107 | 17.91        | 27172      |
| 4/4/10 | 3.707107  | morph              | 1–5   | 5/5         | 4/5         | 3.707107 | 3.707107 | 3.707119 | 4.10         | 5082       |
| 4/4/11 | 3.877084  | harden             | 1–5   | 5/5         | 0/5         | 3.877089 | 3.877089 | 3.877090 | 38.38        | 30000      |
| 4/4/11 | 3.877084  | harden, rigid path | 1–5   | 0/5         | 0/5         | 3.889938 | 3.890274 | 3.890428 | 32.23        | 29336      |
| 4/4/11 | 3.877084  | basin_hopping      | 1–5   | 0/5         | 0/5         | 3.887343 | 3.931134 | 4.000000 | 22.64        | 28215      |
| 4/4/11 | 3.877084  | morph              | 1–5   | 0/5         | 0/5         | 4.000000 | 4.000000 | 4.000000 | 3.48         | 4544       |
| 0/0/7  | 3.000000  | harden             | 1–5   | 5/5         | 5/5         | 3.000000 | 3.000000 | 3.000000 | 12.96        | 27091      |
| 0/0/7  | 3.000000  | harden, rigid path | 1–5   | 5/5         | 5/5         | 3.000000 | 3.000000 | 3.000000 | 12.83        | 27091      |
| 0/0/7  | 3.000000  | basin_hopping      | 1–5   | 5/5         | 5/5         | 3.000000 | 3.000000 | 3.000000 | 12.36        | 27089      |
| 0/0/7  | 3.000000  | morph              | 1–5   | 5/5         | 5/5         | 3.000000 | 3.000000 | 3.000000 | 0.04         | 146        |
| 3/3/7  | 3.000000  | harden             | 1–5   | 5/5         | 0/5         | 3.000000 | 3.000000 | 3.000002 | 23.83        | 29524      |
| 3/3/7  | 3.000000  | harden, rigid path | 1–5   | 5/5         | 1/5         | 3.000000 | 3.000000 | 3.000000 | 24.34        | 29985      |
| 3/3/7  | 3.000000  | basin_hopping      | 1–5   | 5/5         | 5/5         | 3.000000 | 3.000000 | 3.000000 | 14.08        | 27089      |
| 3/3/7  | 3.000000  | morph              | 1–5   | 5/5         | 5/5         | 3.000000 | 3.000000 | 3.000000 | 2.07         | 4345       |

[CALC] What these runs show, and no more than that:

- Squares in a square. Both hardening paths reach `2 + 1/sqrt(2)` and
  `3 + 1/sqrt(2)` to within 1e-4 in 19 of 20 and 20 of 20 runs at 3,000
  evaluations; `basin_hopping` does so in 2 of 20 and `morph` in 10 of 20
  (none for five squares). For 11 squares the harden path comes within 1e-4
  of the published 3.877084 in 3 of 10 runs at 3,000 evaluations and 5 of 5
  at 30,000 (best 3.877089, about 5e-6 above it); the rigid path,
  `basin_hopping` and `morph` do not in any run at either budget. For 19
  squares at 3,000 evaluations the harden path's best is 4.885924 (published
  4.885618) and its worst 4.893468, while the other three end between
  4.9128 and 5.000002.
  This agrees in direction with the originator's finding that hardening is a
  different search on squares in a square.
- Seven circles in a circle: all methods reach 3; for circles harden is the
  rigid path, and the two rows are identical.
- Triangles in a triangle. For 7 triangles hardening reaches 3 only to
  about 1e-6 (0 of 20 runs within 1e-9 at 3,000 evaluations), while
  `basin_hopping` and `morph` reach it to 1e-9 in every run: the legalised
  state keeps a slack that the float64 polish did not remove within its
  allowance. For 12 triangles the harden path's median is 3.957, clearly
  worse than the rigid path's 3.8794, as the originator reports for
  triangles (hardening loses there); both `basin_hopping` and `morph` are
  worse still at this budget.
- Precision. Hardening results often stop 1e-7 to 5e-6 above the published
  value even when they are the right packing (within 1e-9 in only 2 of 10
  runs for 10 squares, where `morph` has 9 of 10). Run `polish` or `penalty`
  from a hardening result when the last digits matter.
- Cost. At an equal evaluation count hardening took between 0.7 and 2.7
  times the wall time of `basin_hopping` in these loaded runs, about twice
  on most of the square and triangle problems. Where it is slower, an
  equal-evaluation comparison gives it more compute. `morph` often converges
  early and spends far fewer evaluations.

These are small samples on seven problems. They are not a benchmark study,
they do not establish that hardening is the better method in general (the
originator's 188-instance study says it is not), and nothing here is a
packing record: no result is below its published value.

The command below reproduces both tables from the repository root and prints
one JSON summary with all scores per group. It runs the groups one after
another, about 45 minutes at the loaded speeds measured here; the tables were
produced by the same calls split over parallel processes.

```bash
node --import tsx --input-type=module - <<'JS'
import { run, strictTolerance } from './packages/solver/src/index.ts';
import { evaluate, findOverlaps, pieceSeparation } from './packages/geometry/src/index.ts';
const published = { '4/4/5': 2 + Math.SQRT1_2, '4/4/10': 3 + Math.SQRT1_2, '4/4/11': 3.87708359002281, '0/0/7': 3, '3/3/7': 3, '3/3/12': 3.879, '4/4/19': 4.88561808316412 };
const variants = [['harden', 'harden', {}], ['harden, rigid path', 'harden', { path: 'rigid' }], ['basin_hopping', 'basin_hopping', {}], ['morph', 'morph', {}]];
const groups = [[3000, 10, Object.keys(published)], [30000, 5, ['4/4/5', '4/4/10', '4/4/11', '0/0/7', '3/3/7']]];
for (const [evals, seeds, problems] of groups) {
  for (const problem of problems) {
    const [N, M, P] = problem.split('/').map(Number);
    for (const [label, method, params] of variants) {
      const rows = [];
      for (let seed = 1; seed <= seeds; seed++) {
        const r = await run({ N, M, P }, { method, params, seed, budget: { evals }, finalPolish: true });
        if (!r.valid || !r.strict || r.evaluations > evals) throw new Error(`invalid result: ${problem} ${label} seed ${seed}`);
        if (findOverlaps(N, r.best.pieces, strictTolerance(r.best)).length) throw new Error('overlap');
        if (Math.abs(evaluate(r.best, { autoOrient: true }).score - r.score) > 1e-12) throw new Error('score mismatch');
        let gap = Infinity;
        for (let i = 0; i < P; i++) for (let j = 0; j < i; j++) gap = Math.min(gap, pieceSeparation(N, r.best.pieces[i], r.best.pieces[j]).sep);
        rows.push({ seed, score: r.score, evaluations: r.evaluations, seconds: r.wallTime, gap });
      }
      const scores = rows.map((r) => r.score).sort((a, b) => a - b);
      const mean = (key) => rows.reduce((sum, r) => sum + r[key], 0) / rows.length;
      console.log(JSON.stringify({
        problem, evals, method: label, seeds,
        within1e4: scores.filter((s) => s <= published[problem] + 1e-4).length,
        within1e9: scores.filter((s) => s <= published[problem] + 1e-9).length,
        best: scores[0], median: (scores[Math.floor((seeds - 1) / 2)] + scores[Math.ceil((seeds - 1) / 2)]) / 2, worst: scores.at(-1),
        meanSeconds: mean('seconds'), meanEvaluations: mean('evaluations'), minimumPairSeparation: Math.min(...rows.map((r) => r.gap)),
        scores: rows.map((r) => r.score),
      }));
    }
  }
}
JS
```

### Cost per evaluation and large problems

[CALC] Wall time per counted evaluation, final polish disabled, seeds 1–3,
measured in one process under the load described above:

| Problem           | Budget | basin_hopping | morph   | harden, interval 16 | harden, interval 32 (default) | harden, interval 64 |
| ----------------- | ------ | ------------- | ------- | ------------------- | ----------------------------- | ------------------- |
| 10 squares, N=M=4 | 2,700  | 0.64 ms       | 0.59 ms | 0.68 ms             | 0.95 ms                       | 1.50 ms             |
| 30 squares, N=M=4 | 1,000  | 5.40 ms       | 2.32 ms | 2.60 ms             | 3.42 ms                       | 5.47 ms             |

[CALC] Split of one run between momentum steps and assessments (legalisation,
restoration check and the framework's evaluation), harden path, default
interval, method called directly with an instrumented context:

| Problem                 | ms per step | ms per assessment | Steps equal to one assessment |
| ----------------------- | ----------- | ----------------- | ----------------------------- |
| 10 squares in a square  | 0.015       | 0.27              | 18                            |
| 30 squares in a square  | 0.054       | 0.96              | 18                            |
| 200 squares in a square | 0.30        | 7.7               | 25                            |
| 500 squares in a square | 0.63        | 17.4              | 28                            |
| 500 circles in a circle | 0.38        | 14.9              | 39                            |

The 200- and 500-piece rows cover only the first 3,200 and 1,600 steps of a
run (compression of disks), where pairs are fewest; later steps cost more.

[CALC] Longest stretch between two cooperative checkpoints at P = 500, same
instrumented context, first 32 to 608 steps and their assessments:

| Problem      | Checkpoints | Longest stretch | 99th percentile | Largest counted work |
| ------------ | ----------- | --------------- | --------------- | -------------------- |
| N=4, M=4     | 216         | 10.3 ms         | 7.0 ms          | 71,952               |
| N=0, M=0     | 151         | 10.3 ms         | 4.5 ms          | 66,146               |
| N=12, M=0    | 98          | 9.3 ms          | 5.9 ms          | 86,352               |
| N=100, M=100 | 1,152       | 16.8 ms         | 4.2 ms          | 77,600               |

The longest stretches include the synchronous tail of an assessment (shared
restoration check, zero-tolerance overlap scan and the framework's own
evaluation, 1 to 20 ms at P = 500 depending on M), which the method cannot
subdivide.

## Independent confirmation

[CALC] 2026-10-11, independent review, Apple Silicon, registered defaults,
no start, final polish. A sample of the table above was rerun independently
and confirmed:

| Problem                   | Evaluations, seeds | Within 1e-4 | Within 1e-9 | Above the published value |
| ------------------------- | ------------------ | ----------- | ----------- | ------------------------- |
| 5 squares in a square     | 3,000, 1–5         | 5/5         | 5/5         |                           |
| 10 squares in a square    | 3,000, 1–5         | 5/5         | 0/5         | 2.5e-8 to 1.6e-7          |
| 11 squares in a square    | 30,000, 1–3        | 3/3         | not given   | 5.6e-6 to 6.1e-6          |
| 7 triangles in a triangle | 3,000, 1–3         | 3/3         | not given   | 1.2e-6 to 1.9e-6          |
| 7 circles in a circle     | 3,000, 1–2         | 2/2         | 2/2         |                           |

Nothing was below a published value. The review also confirmed the
gradients, the legalisation, the budgets and the reproducibility, and led to
the changes listed under Verification.

## Verification

[CALC] The method's tests are `packages/solver/test/harden.test.ts` (39
tests) and the end-to-end case "harden runs from scratch in a worker and
preserves the board" in `e2e/solve.spec.ts`:

```sh
npx vitest run packages/solver/test/harden.test.ts
npx playwright test e2e/solve.spec.ts
```

[CALC] `packages/solver/test/harden.test.ts` covers: shape-path endpoints and
schedules for every path (the end state compared with `toBe`, not a
tolerance), containment of soft states, circle pieces; energies and gradients
worked out by hand for circles and axis-aligned squares, rigid, half-hardened
and pure-disk, against each other and against a wall; the analytic gradient
including dE/dL against central differences, and the method's assembly,
cut-off and wall prefilter against an unpruned sum over the shared
constraint functions, for circles, triangles and squares in circular,
triangular, square and 12-sided containers; the cell-grid branch above 32
pieces; the momentum step, its caps, the direction of the container update
and seeded noise; adoption of a start as a rigid motion; legalisation; the
phase plan and run count; exact budgets from 1 to 400 evaluations with an
instrumented count of assessments and steps; that every run completes its
path; that only complete, distinct, zero-overlap true-shape arrangements are
scored; bit-identical repeats, a different result for a different seed, no
`Math.random`; stop with no further assessment and a strict result; pause
and resume to identical bits; checkpoints placed by counted work at
identical places in repeated runs, up to P = 500; valid and strict results
for 16 piece/container pairs including P = 1, N = 0, M = 0, N or M = 3, 12
and 64, with no start, a loose start, a coincident start and an incomplete
start; start handling; restarts; full-length restarts and the grid-first
assessment without an evaluation budget, by counted events; the bounded
duplicate memory (40,000 arrangements of 500 pieces retained in at most
16,384 keys of 15 characters); and the five-square and seven-circle optima
as the best of several seeds. No assertion depends on elapsed time.

[CALC] Review follow-up. Duplicate suppression changed from full-text pose
signatures to the bounded hashes described above, and `legalise` gained a
stated precondition; neither changes a result unless two different
arrangements collide in the 64-bit hash. Checked: 80 seeded
evaluation-budget runs (ten piece/container pairs, two seeds, four parameter
sets including a supplied start) gave bit-identical best configurations,
scores, traces and evaluation counts before and after, 80 of 80; and 1.5
million near-identical test arrangements gave no hash collision.

[CALC] Before the follow-up, eleven deliberate defects were introduced one at
a time into the method (wrong pair-gradient factor, wrong dE/dL, torque on
pure disks, an over-eager wall prefilter, a short pair cut-off, an inexact
path endpoint, no legalisation, `Math.random` noise, no checkpoints, a wrong
run length, and removal of the final zero-overlap gate). The test file
failed for ten of them. It did not fail for the removed zero-overlap gate,
because the shared restoration before it already returns only separated
arrangements; the gate is a second line of defence.

[CALC] Not yet done: a measurement in the browser, and the 50-digit Python
polish, which this method does not invoke.

## References

[EST] Read on 2026-10-11:

- Yohei Nakajima, _Soft-to-Rigid: Shape Continuation as an Alternative
  Search for Packing Congruent Shapes_, with code, pre-registered campaigns
  and replays. [Repository](https://github.com/yoheinakajima/soft-to-rigid)
  (MIT licence), [site](https://yoheinakajima.github.io/soft-to-rigid/),
  [paper](https://github.com/yoheinakajima/soft-to-rigid/blob/main/paper/main.pdf).
  Used here: `engine/engine2d.js` (shape state, `gradient`, `step`,
  `runPath`, `legalize`, defaults), `paper/sections/method.tex` (definitions,
  schedule, step details), the paper's appendix and `methods/*.json` (tuned
  settings) and `README.md` (headline results). The repository credits Claude
  (Anthropic) with assisting the author on code, experiments and verification.
- Published values quoted in the tables come from this repository's
  `data/records.json` (sources in `docs/RECORDS.md`).
