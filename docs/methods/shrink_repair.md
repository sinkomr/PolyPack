# Shrink and repair (`shrink_repair`)

[CALC] `shrink_repair` separates feasibility from size. From the best valid
packing at size `s` it sets a smaller container `s (1 - r)`, scales the piece
centres into it (overlaps appear) and runs a _repair_ at that fixed size: it
minimises a weighted sum of squared pair penetrations and wall protrusions by
global descent, relocation of conflicting pieces by sampling, and
guided-local-search weights that make persistent conflicts more expensive.
When the overlap reaches zero the arrangement is legalised strictly and
scored, and the container shrinks again. When the shrink ratio `r` has fallen
to its minimum, the method explores: it ruins a region of the packing (scatters
its pieces or turns them together as a block) and repairs just below the best
size. After repeated failure it restarts from random poses near the best size.

```ts
const result = await run({ N: 4, M: 4, P: 10 }, { method: "shrink_repair", budget: { evals: 3000 }, seed: 1 });
```

## Why

[EST] Records for pieces that tile or fit their container exactly (squares in
a square, triangles in a triangle) form a sawtooth against P: just past a
number that packs perfectly, the next regular (grid) arrangement is far from
the published value, which cuts the tooth with coordinated tilts of whole
groups of pieces. Examples from `data/records.json` (N = M = 4):
s(10) = 3 + 1/sqrt(2) = 3.707107, s(17) = 4.675530, s(26) = 5.621320,
s(37) = 6.598620, s(50) = 7.571429; the grid gives ceil(sqrt(P)).

[CALC] Tilting one square of side 1 by t from the grid widens it to
cos t + sin t, about 1 + t, so no small single-piece move from the grid leads
downhill, and a method that never allows overlap (`mc_compress`) cannot cross
that barrier. A method that accepts overlap at a smaller size and then removes
it can.

[EST] The approach is that of the strongest irregular-packing (nesting)
heuristics, which minimise overlap at a fixed strip or container size inside a
shrinking loop (Egeblad, Nielsen and Odgaard 2007; Imamichi, Yagiura and
Nagamochi 2009), and in particular `sparrow` (Gardeyn, Vanden Berghe and
Wauters 2025), which splits strip packing into a sequence of feasibility
problems, moves colliding items to the best of sampled placements (diverse
over the container and focused near the item) followed by a coordinate-descent
refinement, and weights colliding pairs by guided local search with
multipliers (2.0, 1.2, 0.95). References at the end. The implementation here
is PolyPack's [CALC]: no code from these works is used. The GLS multipliers
are sparrow's; the rest (global L-BFGS descent, ruins, block turns, restarts,
legalisation, the budgets) is PolyPack's and differs from all three.

## The repair phase

[CALC] The container is centred at the origin with a horizontal bottom edge
(phi = 0) and fixed size during a repair. The objective is

`F = sum_pairs w_ij d_ij^2 + sum_i v_i sum_walls p_ik^2`,

with `d_ij` the penetration depth of the true pieces (the separating-axis
depth of the shared `pairPenetration`; for circles `1 - distance`) and
`p_ik` the protrusion of piece i through wall k in the shared support form
(the furthest vertex per polygon wall; for a circular container the vertex
furthest from the centre). Both are zero for touching pieces, so zero overlap
here is the zero the strict verifier tests. The unweighted sum of the same
terms is the _raw overlap_. A state is feasible when no depth or protrusion
exceeds 1e-10.

[CALC] Performance kernel (`shrink_repair/kernel.ts`). The depths and their
derivatives are computed by an allocation-free copy of the shared formulas:
along edge normal k of one piece, at angle `theta + pi/2 + pi/N + k 2pi/N`, the
other piece reaches `R cos(delta)` with delta the angle to its nearest vertex
direction; consecutive normals differ by exactly the vertex spacing, so delta
is the same for all N normals of one pass and one cosine per pass replaces
one per axis, and a separating axis ends a depth-only test at once. Walls
skip any wall the piece's bounding disk cannot reach. The test file checks
the kernel against `pairPenetration` and `visitContainerProtrusions` (depths,
derivatives, protrusions, within 1e-12) and the objective's gradient against
central differences. Strict verdicts never come from the kernel:
legalisation and scoring use the shared `findOverlaps` and `evaluate`.

[CALC] One repair iteration:

1. **Relocate** every piece in conflict, in seeded random order. For each,
   `globalSamples` (48) centres uniform over the container (at least the
   piece's inradius from every wall) and `localSamples` (24) near its current
   pose and the best sample so far are scored by the piece's weighted loss
   against all others; the best is refined by up to 10 gradient steps of that
   loss, and the piece moves there if its loss falls. Sample angles: 40% an
   edge parallel to a container wall turned by a quarter of the symmetry
   period at a time (for squares 0, 22.5, 45 and 67.5 degrees from the walls),
   or facing the centre in a circular container; 20% the angle of a random
   other piece or that angle turned by pi/N (the inverted neighbour of
   triangles); 10% the piece's own angle; 30% uniform. Near samples keep the
   angle with a small Gaussian turn (0.15 rad) three times in four.
2. **Descend**: L-BFGS (memory 8, Armijo backtracking, moves capped at a
   quarter of the bounding radius and a quarter radian) on F over all poses,
   at most `descentIterations` (40) iterations, stopping when feasible.
3. **Weights** (guided local search): at the resulting local minimum, the
   weight of each pair or wall still in conflict is multiplied by between
   `1 + (weightGrowth - 1)/5` (shallowest) and `weightGrowth` (2, deepest
   conflict), in proportion to its depth; former conflicts decay by
   `weightDecay` (0.95) towards 1. With the defaults these are sparrow's
   multipliers 1.2, 2.0 and 0.95 [EST]; the wall weights and the reset to 1
   for every new container size are PolyPack's [CALC].

[CALC] A repair first descends once; then each _strike_ runs iterations until
`patience` of them in a row fail to lower the least raw overlap of the repair
by 0.1%; a strike ends by restoring that least-overlap state (keeping the
weights). After `strikes` (3) strikes, or `4 * strikes * patience`
iterations, the repair has failed.

## The outer loop

[CALC] **Compression.** From the current packing at size `s`, target
`s (1 - r)`: centres are scaled by `1 - r` about the container centre and the
state is repaired with `patience` (12). A feasible repair is legalised and
scored; if it is smaller, it becomes the current packing and `r` grows by a
quarter (at most `maxShrinkRatio`, 0.05); otherwise `r` halves. The first `r`
is `shrinkRatio` (0.01).

[CALC] **Exploration.** When `r` falls below `minShrinkRatio` (0.0002) the
search is at the floor of the current packing's basin. It then repairs from
the current packing at targets just below it, `r` uniform between one and
four times the minimum ratio, after a _ruin_: the `k` pieces nearest a random
piece, with k log-uniform between 1 and `maxRuin * P`, are either scattered
over the disk they occupied (centres uniform in it, angles drawn like
relocation angles) or turned rigidly together about their mean centre by an
angle uniform within half the symmetry period either way (any angle for
circles), which keeps the block's internal contacts and tilts it as a whole.
These repairs use `explorePatience` (24). A smaller packing returns to
compression with `r` at least twice the exploring ratio.

[CALC] **Restarts.** After `restartAfter` (40) explorations in a row without
a smaller current packing, random poses (uniform centres, uniform angles) are
repaired at a container `restartSlack` (2%) larger than the best, growing by
2% after each failed repair; the result becomes the current packing. Its
descendants replace the best only when they beat it. `restartAfter = 0`
disables restarts.

[CALC] **Legalisation.** A feasible repair still has depths up to 1e-10. The
centres are scaled about the container centre by
`f = (1 + d / (2 r - d)) (1 + 4e-12)`, with d the deepest pair penetration
found by `findOverlaps(N, pieces, 0)` and r the piece inradius (1/2 for
circles): scaling centres by f moves a penetrating pair apart along its
deepest separating axis u by `(f - 1) (c_b - c_a) . u`, and
`(c_b - c_a) . u = r + R cos(delta) - d >= 2 r - d` because a regular polygon
reaches at least its inradius in every direction. The result is checked with
`findOverlaps(..., 0)` (the margin grows sixteenfold up to three times if
rounding defeats it); deeper overlaps go to harden's bisected homothety and
the shared `restore`. Only configurations with no zero-tolerance overlap are
ever scored, so every assessed state of this method is strict.

## Starts, budgets and reproducibility

[CALC] **Starts.** With `start: "auto"` a complete supplied start is used
(the batch runner supplies the current record); otherwise the automatic seed
generators (`ctx.run("seed", { kind: "auto", poolLimit: 0 })`, at most 24
assessments). A start with any zero-tolerance overlap (including one valid
only within the evaluator's tolerance, or an overlapping one) is first
repaired at its own size, growing by 5% after each failure. With
`start: "random"` random poses in a container 30% larger than the area lower
bound are repaired the same way; a supplied start is still scored by the
framework and kept if better. When the framework holds no valid start, the
shared jitter-free grid is scored first (no seeded draw), so a stop in the
first steps still returns a strict result.

[CALC] **Accounting.** As for `harden`, the budget counts framework
assessments, not objective evaluations. Every feasible repair is assessed at
once. Between them, one legalised working state is assessed per
`evaluationWork * P` counted feature tests (default 4,000 per piece; a pair
test of N-gons counts 2N, a wall test M, a circle pair 1), so an evaluation
budget bounds the work and a run spends it all. A working state that happens
to be the smallest so far is kept like a feasible repair.

[CALC] **Checkpoints, stop and pause.** A checkpoint is taken at entry and
after every 60,000 counted feature tests, checked after every relocation and
every descent iteration; a checkpoint draws no random number and assesses
nothing, and placing them by counted work keeps a seeded run's checkpoints
identical from run to run (tested). Stop ends the method at the next check
without a further assessment; pause waits in the framework's checkpoint and
resumes to identical bits (tested).

[CALC] **Reproducibility.** All randomness comes from the context's seeded
stream; the same seed, problem, parameters, start and evaluation budget give
bit-identical results (tested, with `Math.random` disabled). Time budgets
depend on the machine and its load.

[CALC] **Board.** After every repair iteration the method offers a sketch of
the working state (true pieces, scale 1, which may overlap and protrude) in
its target container, labelled with the phase, the target size, the best size
and the raw overlap. Drawing it reads no random number (a run with and
without an observer is identical, tested).

## Parameters and defaults

[CALC] The registered schema is an object with `additionalProperties:false`;
every property has a title, a description, a default and bounds.

| Parameter           | Default | Range         | Purpose                                                       |
| ------------------- | ------- | ------------- | ------------------------------------------------------------- |
| `start`             | auto    | auto, random  | Supplied start or seed generators; or random poses            |
| `shrinkRatio`       | 0.01    | 1e-6 to 0.5   | First compression ratio r                                     |
| `minShrinkRatio`    | 0.0002  | 1e-9 to 0.5   | Below it, compression turns to exploration                    |
| `maxShrinkRatio`    | 0.05    | 1e-6 to 0.5   | Cap on the growing ratio                                      |
| `strikes`           | 3       | 1 to 1000     | Strikes of a failing repair                                   |
| `patience`          | 12      | 1 to 10000    | Iterations without a 0.1% lower raw overlap that end a strike |
| `explorePatience`   | 24      | 1 to 10000    | Patience of exploring, restart and start repairs              |
| `globalSamples`     | 48      | 0 to 10000    | Container-wide samples per relocation                         |
| `localSamples`      | 24      | 0 to 10000    | Near samples per relocation                                   |
| `weightGrowth`      | 2       | 1 to 100      | GLS multiplier of the deepest conflict                        |
| `weightDecay`       | 0.95    | 0 to 1        | GLS decay of former conflicts                                 |
| `descentIterations` | 40      | 1 to 100000   | L-BFGS iterations per descent                                 |
| `maxRuin`           | 1       | 0 to 1        | Largest ruined fraction of P                                  |
| `restartAfter`      | 40      | 0 to 100000   | Failed explorations in a row before a restart (0: never)      |
| `restartSlack`      | 0.02    | 0 to 1        | Restart container relative to the best                        |
| `evaluationWork`    | 4000    | 1 to 10000000 | Counted feature tests per assessment and piece                |

## Verification

[CALC] `packages/solver/test/shrink_repair.test.ts` (16 tests) covers: the
kernel against the shared `pairPenetration` (depth, the depth-only test and
all six derivatives) and `visitContainerProtrusions` (support form; deepest
vertex for a circular container) for circles and 3-, 4-, 5-, 6- and 12-gons
in circular, triangular, square, hexagonal and heptagonal containers, within
1e-12; the objective's gradient against central differences; strict
legalisation of squeezed contact grids (by a factor near 1 + depth when
shallow) and of random overlapping arrangements of 0-, 3-, 5-, 6-, 9- and
40-gons; registration and schema defaults; that every configuration the
method submits is complete and has no zero-tolerance overlap, for nine
problems including P = 1 and 2, N = 0, M = 0, triangles and heptagons, random
starts, a start with every piece at one point and a start valid only within
the evaluator's tolerance; exact evaluation budgets from 1 to 250; a time
budget; bit-identical repeats, a different result for another seed, no
`Math.random`, the same result with and without a sketch observer; never
worse than a valid start, including the published records for 5 and 10
squares and 7 circles; stop from inside a run with no further assessment, an
already-aborted run, pause and resume to identical bits; checkpoints placed by
counted work, identical in repeated runs; and the grid-escape regressions
below.

```sh
npx vitest run packages/solver/test/shrink_repair.test.ts
```

[CALC] Grid-escape regressions (fixed seeds and budgets, final polish on):
five squares from the plain grid start (size 3) reach `2 + 1/sqrt(2)` to
within 1e-6 for seeds 1, 2 and 3 at 1,500 evaluations; ten squares with the
automatic start reach `3 + 1/sqrt(2)` to within 1e-4 for seed 1 at 3,000
evaluations.

## Measurements

[CALC] Everything in this section was measured here on 2026-10-17/18: Apple
M1 Pro (eight logical CPUs), Darwin arm64, Node v26.5.0. The machine was
loaded by unrelated jobs (load average 30 to 110) and eight benchmark
processes ran at once, so the seconds are observed wall times under load, not
throughput claims. Scores do not depend on load: each is reproducible bits for
its seed and evaluation budget (two rows were rerun with the committed script
and matched to the last bit).

[CALC] Setup: registered defaults for every method, 20,000 evaluations, final
polish on, seeds 1, 2 and 3, no seed selected or omitted and no parameter tuned
on these problems after the defaults were fixed. (The defaults were chosen
during development from runs on 5, 10, 17, 26 and 37 squares with seeds 1 to
3; see the notes on development below.) _grid_: the plain grid start,
ceil(sqrt P) columns of edge-aligned unit squares at pitch 1 (size
ceil(sqrt P)). _scatter_: a valid start with centres uniform in
[-v, v]^2 (v the published size) and uniform angles, rejecting any piece
whose bounding disk meets one already placed, one start per seed, the same
start for every method. _default_: no start; each method's own automatic
start. "Published" is `data/records.json` (sources in `docs/RECORDS.md`).
Every one of the 225 results was checked valid and strict with no budget
overrun and a recomputed score equal to the reported one; the smallest pair
separation is -9.9e-13 (`asc`), -5.2e-13 for `shrink_repair`, within the
strict margin. Raw rows: `shrink_repair/benchmark-squares.jsonl` and
`benchmark-general.jsonl` beside the method. Reproduce from the repository
root (about an hour each with eight workers on a loaded machine):

```sh
node --import tsx packages/solver/src/methods/shrink_repair/benchmark.mjs squares squares.jsonl 8
node --import tsx packages/solver/src/methods/shrink_repair/benchmark.mjs general general.jsonl 8
node --import tsx packages/solver/src/methods/shrink_repair/benchmark.mjs report squares.jsonl general.jsonl
```

### Squares in a square: the grid basin

| N/M/P  | Start   | Published | Method        | Scores, seeds 1, 2, 3        | Best / published | Median / published | Mean s | Mean evals |
| ------ | ------- | --------- | ------------- | ---------------------------- | ---------------- | ------------------ | ------ | ---------- |
| 4/4/10 | grid    | 3.707107  | shrink_repair | 3.707107, 3.707107, 3.707107 | 1.00000          | 1.00000            | 31.1   | 18135      |
| 4/4/10 | grid    | 3.707107  | asc           | 4.000000, 4.000000, 4.000000 | 1.07901          | 1.07901            | 0.6    | 290        |
| 4/4/10 | grid    | 3.707107  | harden        | 3.707107, 3.707107, 3.707107 | 1.00000          | 1.00000            | 22.7   | 18278      |
| 4/4/10 | grid    | 3.707107  | mc_compress   | 4.000000, 4.000000, 4.000000 | 1.07901          | 1.07901            | 2.3    | 2510       |
| 4/4/10 | grid    | 3.707107  | basin_hopping | 3.707107, 3.707107, 3.707107 | 1.00000          | 1.00000            | 15.2   | 18159      |
| 4/4/10 | scatter | 3.707107  | shrink_repair | 3.707110, 3.707107, 3.707107 | 1.00000          | 1.00000            | 26.7   | 18166      |
| 4/4/10 | scatter | 3.707107  | asc           | 4.002216, 4.000002, 4.008876 | 1.07901          | 1.07961            | 5.3    | 4547       |
| 4/4/10 | scatter | 3.707107  | harden        | 3.707107, 3.707107, 3.707107 | 1.00000          | 1.00000            | 19.4   | 18300      |
| 4/4/10 | scatter | 3.707107  | mc_compress   | 4.000150, 3.707381, 4.000000 | 1.00007          | 1.07901            | 6.9    | 9886       |
| 4/4/10 | scatter | 3.707107  | basin_hopping | 3.707107, 3.707107, 3.707177 | 1.00000          | 1.00000            | 13.0   | 18164      |
| 4/4/17 | grid    | 4.675530  | shrink_repair | 4.675718, 4.707107, 4.677711 | 1.00004          | 1.00047            | 40.9   | 19535      |
| 4/4/17 | grid    | 4.675530  | asc           | 5.000000, 5.000000, 5.000000 | 1.06940          | 1.06940            | 0.5    | 291        |
| 4/4/17 | grid    | 4.675530  | harden        | 4.677651, 4.676036, 4.677651 | 1.00011          | 1.00045            | 36.1   | 19703      |
| 4/4/17 | grid    | 4.675530  | mc_compress   | 5.000000, 5.000000, 5.000000 | 1.06940          | 1.06940            | 10.1   | 8618       |
| 4/4/17 | grid    | 4.675530  | basin_hopping | 4.707145, 4.707107, 4.707528 | 1.00675          | 1.00676            | 48.1   | 18628      |
| 4/4/17 | scatter | 4.675530  | shrink_repair | 4.677652, 4.707107, 4.707116 | 1.00045          | 1.00675            | 38.3   | 18841      |
| 4/4/17 | scatter | 4.675530  | asc           | 5.003022, 4.774376, 4.755552 | 1.01712          | 1.02114            | 18.8   | 7352       |
| 4/4/17 | scatter | 4.675530  | harden        | 4.677651, 4.676036, 4.677654 | 1.00011          | 1.00045            | 35.6   | 19703      |
| 4/4/17 | scatter | 4.675530  | mc_compress   | 4.707163, 5.001116, 4.803826 | 1.00677          | 1.02744            | 5.7    | 4352       |
| 4/4/17 | scatter | 4.675530  | basin_hopping | 4.707255, 4.707107, 4.707170 | 1.00675          | 1.00677            | 49.8   | 18747      |
| 4/4/26 | grid    | 5.621320  | shrink_repair | 5.621321, 5.621373, 5.621350 | 1.00000          | 1.00001            | 68.1   | 18615      |
| 4/4/26 | grid    | 5.621320  | asc           | 6.000000, 6.000000, 6.000000 | 1.06736          | 1.06736            | 1.1    | 291        |
| 4/4/26 | grid    | 5.621320  | harden        | 5.621556, 5.621510, 5.621493 | 1.00003          | 1.00003            | 48.7   | 18132      |
| 4/4/26 | grid    | 5.621320  | mc_compress   | 6.000000, 6.000000, 6.000000 | 1.06736          | 1.06736            | 7.0    | 2693       |
| 4/4/26 | grid    | 5.621320  | basin_hopping | 5.707579, 5.707108, 5.678480 | 1.01017          | 1.01526            | 78.9   | 18373      |
| 4/4/26 | scatter | 5.621320  | shrink_repair | 5.690396, 5.621332, 5.707142 | 1.00000          | 1.01229            | 72.4   | 19419      |
| 4/4/26 | scatter | 5.621320  | asc           | 5.872729, 5.826673, 5.757031 | 1.02414          | 1.03653            | 54.8   | 8760       |
| 4/4/26 | scatter | 5.621320  | harden        | 5.621556, 5.621510, 5.621493 | 1.00003          | 1.00003            | 51.2   | 18132      |
| 4/4/26 | scatter | 5.621320  | mc_compress   | 6.006131, 6.001277, 6.000023 | 1.06737          | 1.06759            | 25.2   | 7500       |
| 4/4/26 | scatter | 5.621320  | basin_hopping | 5.707194, 5.728891, 5.717941 | 1.01528          | 1.01719            | 114.9  | 18700      |
| 4/4/37 | grid    | 6.598620  | shrink_repair | 6.598756, 6.621339, 6.621343 | 1.00002          | 1.00344            | 152.5  | 18473      |
| 4/4/37 | grid    | 6.598620  | asc           | 7.000000, 7.000000, 7.000000 | 1.06083          | 1.06083            | 2.4    | 278        |
| 4/4/37 | grid    | 6.598620  | harden        | 6.621771, 6.632616, 6.598670 | 1.00001          | 1.00351            | 107.9  | 18426      |
| 4/4/37 | grid    | 6.598620  | mc_compress   | 7.000000, 7.000000, 7.000000 | 1.06083          | 1.06083            | 11.7   | 3966       |
| 4/4/37 | grid    | 6.598620  | basin_hopping | 6.775265, 6.730156, 6.767865 | 1.01993          | 1.02565            | 135.5  | 18389      |
| 4/4/37 | scatter | 6.598620  | shrink_repair | 6.621387, 6.707126, 6.598702 | 1.00001          | 1.00345            | 128.2  | 18468      |
| 4/4/37 | scatter | 6.598620  | asc           | 6.756713, 6.827990, 6.840280 | 1.02396          | 1.03476            | 137.2  | 17968      |
| 4/4/37 | scatter | 6.598620  | harden        | 6.621771, 6.632616, 6.598670 | 1.00001          | 1.00351            | 98.1   | 18426      |
| 4/4/37 | scatter | 6.598620  | mc_compress   | 6.733304, 6.897251, 7.000001 | 1.02041          | 1.04526            | 74.4   | 10102      |
| 4/4/37 | scatter | 6.598620  | basin_hopping | 6.708056, 6.823647, 6.622076 | 1.00355          | 1.01658            | 127.6  | 18353      |
| 4/4/50 | grid    | 7.571429  | shrink_repair | 7.621622, 7.621882, 7.621427 | 1.00660          | 1.00663            | 183.2  | 18442      |
| 4/4/50 | grid    | 7.571429  | asc           | 8.000000, 8.000000, 8.000000 | 1.05660          | 1.05660            | 4.6    | 254        |
| 4/4/50 | grid    | 7.571429  | harden        | 7.622226, 7.621406, 7.655314 | 1.00660          | 1.00671            | 187.2  | 18789      |
| 4/4/50 | grid    | 7.571429  | mc_compress   | 8.000000, 8.000000, 8.000000 | 1.05660          | 1.05660            | 9.9    | 3445       |
| 4/4/50 | grid    | 7.571429  | basin_hopping | 7.707703, 7.771921, 7.707213 | 1.01793          | 1.01800            | 155.2  | 18142      |
| 4/4/50 | scatter | 7.571429  | shrink_repair | 7.621500, 7.621454, 7.659969 | 1.00661          | 1.00661            | 129.4  | 18216      |
| 4/4/50 | scatter | 7.571429  | asc           | 7.878015, 7.880809, 7.928245 | 1.04049          | 1.04086            | 201.4  | 18211      |
| 4/4/50 | scatter | 7.571429  | harden        | 7.622226, 7.621406, 7.655314 | 1.00660          | 1.00671            | 176.4  | 18789      |
| 4/4/50 | scatter | 7.571429  | mc_compress   | 8.008213, 8.000195, 7.736720 | 1.02183          | 1.05663            | 120.0  | 11820      |
| 4/4/50 | scatter | 7.571429  | basin_hopping | 7.928333, 7.663539, 7.678997 | 1.01217          | 1.01421            | 214.6  | 18300      |

### Other pieces and containers

[CALC] Each method's own start. The 19-heptagon problem has no published value in `data/records.json`.
The 17-triangle value is stored to three decimals as "4.465+" (Maurizio
Morandi, 2008), so a ratio of 1.00013 is consistent with reaching it and no
finer comparison is possible.

| N/M/P  | Start   | Published | Method        | Scores, seeds 1, 2, 3           | Best / published | Median / published | Mean s | Mean evals |
| ------ | ------- | --------- | ------------- | ------------------------------- | ---------------- | ------------------ | ------ | ---------- |
| 0/4/30 | default | 10.908568 | shrink_repair | 10.908568, 10.908568, 10.908568 | 1.00000          | 1.00000            | 141.8  | 18602      |
| 0/4/30 | default | 10.908568 | asc           | 10.908568, 10.908568, 10.908568 | 1.00000          | 1.00000            | 8.0    | 4585       |
| 0/4/30 | default | 10.908568 | harden        | 10.908568, 10.908568, 10.908568 | 1.00000          | 1.00000            | 17.2   | 18579      |
| 0/4/30 | default | 10.908568 | mc_compress   | 10.908568, 10.908568, 10.908568 | 1.00000          | 1.00000            | 2.1    | 3304       |
| 0/4/30 | default | 10.908568 | basin_hopping | 10.908568, 10.908568, 10.908568 | 1.00000          | 1.00000            | 53.1   | 18087      |
| 5/4/20 | default | 6.661350  | shrink_repair | 6.662056, 6.661839, 6.661849    | 1.00007          | 1.00007            | 54.7   | 19712      |
| 5/4/20 | default | 6.661350  | asc           | 6.738627, 6.722865, 6.718367    | 1.00856          | 1.00923            | 56.9   | 19142      |
| 5/4/20 | default | 6.661350  | harden        | 6.662607, 6.662522, 6.663056    | 1.00018          | 1.00019            | 54.2   | 18972      |
| 5/4/20 | default | 6.661350  | mc_compress   | 6.721081, 6.733945, 6.718710    | 1.00861          | 1.00897            | 28.2   | 15917      |
| 5/4/20 | default | 6.661350  | basin_hopping | 6.662028, 6.663009, 6.665976    | 1.00010          | 1.00025            | 61.9   | 18695      |
| 7/7/19 | default | none      | shrink_repair | 4.918690, 4.918698, 4.918708    | —                | —                  | 43.3   | 19950      |
| 7/7/19 | default | none      | asc           | 5.001075, 4.996043, 4.990685    | —                | —                  | 95.7   | 20000      |
| 7/7/19 | default | none      | harden        | 4.918677, 4.918670, 4.918666    | —                | —                  | 51.3   | 18661      |
| 7/7/19 | default | none      | mc_compress   | 4.990674, 4.992328, 4.987361    | —                | —                  | 34.3   | 20000      |
| 7/7/19 | default | none      | basin_hopping | 4.921086, 4.919864, 4.921834    | —                | —                  | 56.3   | 18246      |
| 3/3/17 | default | 4.465000  | shrink_repair | 4.465573, 4.465571, 4.465571    | 1.00013          | 1.00013            | 54.1   | 20000      |
| 3/3/17 | default | 4.465000  | asc           | 5.000000, 5.000000, 5.000000    | 1.11982          | 1.11982            | 0.7    | 314        |
| 3/3/17 | default | 4.465000  | harden        | 4.500001, 4.500000, 4.465572    | 1.00013          | 1.00784            | 42.3   | 20000      |
| 3/3/17 | default | 4.465000  | mc_compress   | 4.622739, 5.000000, 4.729105    | 1.03533          | 1.05915            | 18.9   | 17200      |
| 3/3/17 | default | 4.465000  | basin_hopping | 4.500265, 4.500000, 4.500174    | 1.00784          | 1.00788            | 44.7   | 19237      |
| 6/6/20 | default | 5.000000  | shrink_repair | 5.000000, 5.000000, 5.000012    | 1.00000          | 1.00000            | 41.2   | 19210      |
| 6/6/20 | default | 5.000000  | asc           | 5.000000, 5.331696, 5.331696    | 1.00000          | 1.06634            | 15.4   | 1781       |
| 6/6/20 | default | 5.000000  | harden        | 5.123899, 5.122757, 5.129118    | 1.02455          | 1.02478            | 44.6   | 18669      |
| 6/6/20 | default | 5.000000  | mc_compress   | 5.000000, 5.331696, 5.144988    | 1.00000          | 1.02900            | 32.4   | 13486      |
| 6/6/20 | default | 5.000000  | basin_hopping | 5.000000, 5.123673, 5.130074    | 1.00000          | 1.02473            | 59.2   | 18817      |

### What these runs show, and no more

[CALC] Squares, 30 runs per method (five P, two starts, three seeds):

| Method        | Below the grid | Within 1e-4 of published (relative) | Within 1e-3 | Mean score / published |
| ------------- | -------------- | ----------------------------------- | ----------- | ---------------------- |
| shrink_repair | 30/30          | 13/30                               | 15/30       | 1.00401                |
| harden        | 30/30          | 14/30                               | 20/30       | 1.00228                |
| basin_hopping | 30/30          | 6/30                                | 6/30        | 1.01319                |
| asc           | 11/30          | 0/30                                | 0/30        | 1.05590                |
| mc_compress   | 6/30           | 1/30                                | 1/30        | 1.05759                |

- From the plain grid start, `asc` and `mc_compress` end at the grid
  (ceil(sqrt P)) in all 15 of their grid-start runs each; their escapes
  counted above are all from scattered starts. `shrink_repair`, `harden` and `basin_hopping` leave
  the grid in every run.
- `shrink_repair` reaches the published 3.707107 (10 squares) in 6 of 6 runs
  (one at 3.707110) and 5.621320 (26) to within 1e-5 relative in 3 of 6
  (1e-4 in 4 of 6); it comes
  within 5e-5 relative of 4.675530 (17: 4.675718) and of 6.598620 (37:
  6.598702, 6.598756) in one or two runs each. Its other runs stop in the
  `k + 1/sqrt(2)` basin (4.707107 for 17, 5.707142 for 26, 6.707126 for 37)
  or just above the record (5.690 for 26, 6.6213 for 37).
- `basin_hopping` mostly stops in the `k + 1/sqrt(2)` basin or above it.
- `harden` is as strong on squares: better medians for 17 squares (4.6777
  from both starts, against 4.6777 and 4.7071) and for scattered 26 squares
  (5.6215 against 5.6904); worse for 26 squares from the grid (5.62151
  against 5.62135); level on 37 and 50 squares. `harden`'s grid and scattered
  rows are identical for 26, 37 and 50 squares: its best result came from a
  later random run, not from the supplied start.
- Nobody comes near the published 50-square packing (7.571429, sixteen
  squares at arctan(4/3)): the best runs of `shrink_repair` and `harden` are
  0.66% above it.

[CALC] Other pieces: `shrink_repair` has the best median on pentagons in a
square (6.661849; published 6.66135, stored to five decimals), triangles in a
triangle (4.465571 in 3 of 3; `harden` 1 of 3, the rest 4.5 or worse) and
hexagons in a hexagon (5.000000 in 2 of 3 and 5.000012; the published 5 is
proven; `asc`, `mc_compress` and `basin_hopping` reach it in 1 of 3, `harden`
in none). Every method reaches the published 10.908568 for 30 circles in a
square, `shrink_repair` in about eight times `harden`'s wall time. On 19
heptagons `harden` is ahead by 3e-5 (4.918670 against 4.918698, medians).

[CALC] Cost. Mean wall time per counted evaluation over all 225 runs:
`mc_compress` 3.2 ms, `harden` 3.5 ms, `shrink_repair` 4.3 ms,
`basin_hopping` 4.4 ms, `asc` 5.5 ms; `asc` and `mc_compress` often stop
early by their stagnation rules. For circle pieces `shrink_repair` is
relatively slow (7.6 ms per evaluation for 30 circles, `harden` 0.9 ms): a
circle pair test counts one unit of work against 2N for an N-gon, so an
evaluation buys more pair tests.

These are three seeds per cell on ten problems. They are not a benchmark
study, they do not show that `shrink_repair` is better than `harden` in
general, and nothing here is a packing record: no result is below its
published value.

## Fit and limitations

[CALC]

- Strengths: pieces that tile or nearly tile the container, where the grid
  or lattice basin traps methods that never allow overlap (hexagons in a
  hexagon and triangles in a triangle above), and the first teeth of the
  square sawtooth (10 and 26 squares) at this budget.
- 17 squares: a third to a half of the runs stay in the 4.707107 basin. In
  development a single repair at 4.70 from that basin never became feasible
  in 20,000 iterations, nor from random poses in 15,000, while random poses
  at 4.72 became feasible in 650 to 2,800 iterations. Escaping that basin is
  left to luck in the exploration.
- Large P: 50 squares end 0.66% above the published packing; the repair cost
  grows with P and a ruin is a smaller share of the packing.
- Restarts: at 20,000 evaluations, restarts after 40 failed explorations were
  neither clearly better nor worse than no restarts on 17 and 26 squares
  (three seeds each); restarting after 15 lost one 26-square seed.
- Precision: a feasible repair may keep depths up to 1e-10 and the legalised
  result keeps that slack; the framework's final polish removes it only
  within its allowance (3.707110 for one 10-square run).
- Circles are slow per evaluation (above).
- Browser throughput was not measured separately; the figures are from Node.

## Development notes

[CALC] Recorded so that the defaults can be judged; all at 20,000
evaluations, automatic start, seeds 1 to 3.

- First version (compression, then uniform disruption of two random pieces
  instead of region ruins): always below the grid, but 26 squares stopped at
  5.7071 in 3 of 3 runs and 37 squares at 6.7072 in 2 of 3.
- Region ruins with rigid block turns: 26 squares 5.621352, 5.621320,
  5.621333; 37 squares 6.6214, 6.6213, 6.6213. A trace of one 26-square run
  shows the record basin opened by a turn of a 20-piece block after about
  twenty failed explorations.
- Exploration patience 8 instead of 24, or restarts after 15 instead of 40:
  within seed noise on 17 and 26 squares; the defaults were kept.
- Restoring the least-overlap state at each strike (as sparrow does) pulls a
  repair that starts from a uniformly shrunk basin back into it, because that
  state has the least raw overlap; region ruins start the repair elsewhere.

## References

[EST] Read on 2026-10-17:

- J. Gardeyn, G. Vanden Berghe and T. Wauters, _An open-source heuristic to
  reboot 2D nesting research_, arXiv:2509.13329 (v1 5 September 2025, v3
  11 February 2026), <https://arxiv.org/abs/2509.13329>. Used here: the
  decomposition into feasibility problems, sampled placement of colliding
  items (diverse and focused samples, then coordinate-descent refinement),
  the guided-local-search weights (multipliers 2.0, 1.2 and 0.95, weights at
  least 1) and strikes (limit 3 when exploring). Read in the HTML version
  (v3), which does not state the sample counts.
- J. Egeblad, B. K. Nielsen and A. Odgaard, _Fast neighborhood search for
  two- and three-dimensional nesting problems_, European Journal of
  Operational Research 183(3), 1249–1266 (2007),
  doi:10.1016/j.ejor.2005.11.063 (bibliographic record checked; full text not
  read).
- T. Imamichi, M. Yagiura and H. Nagamochi, _An iterated local search
  algorithm based on nonlinear programming for the irregular strip packing
  problem_, Discrete Optimization 6(4), 345–361 (2009) (bibliographic record
  and abstract checked: overlap separation by nonlinear programming and a
  swap move inside iterated local search; full text not read).
- Published values: `data/records.json` (sources in `docs/RECORDS.md`).
