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
heuristics: a fixed-size overlap minimisation inside a strip- or
container-shrinking loop with guided local search (Egeblad, Nielsen and
Odgaard 2007; Imamichi, Yagiura and Nagamochi 2009; Umetani et al.), and in
particular Gardeyn and Wauters' `sparrow`, whose separator moves every
colliding item to the best of many sampled placements under adaptive
collision weights (references at the end). The implementation here is
PolyPack's [CALC]: none of their code is used, and their weight constants are
only the starting point of the defaults below.

## The repair phase

[CALC] The container is centred at the origin with a horizontal bottom edge
(phi = 0) and fixed size during a repair. The objective is

`F = sum_pairs w_ij d_ij^2 + sum_i v_i sum_walls p_ik^2`,

with `d_ij` the penetration depth of the true pieces (the separating-axis
depth of the shared `pairPenetration`; for circles `2 - distance`) and
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
   `weightDecay` (0.95) towards 1. Weights start at 1 for every new
   container size.

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
found by `findOverlaps(N, pieces, 0)` and r the piece inradius (1 for
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

| Parameter           | Default | Range          | Purpose                                                          |
| ------------------- | ------- | -------------- | ---------------------------------------------------------------- |
| `start`             | auto    | auto, random   | Supplied start or seed generators; or random poses               |
| `shrinkRatio`       | 0.01    | 1e-6 to 0.5    | First compression ratio r                                        |
| `minShrinkRatio`    | 0.0002  | 1e-9 to 0.5    | Below it, compression turns to exploration                       |
| `maxShrinkRatio`    | 0.05    | 1e-6 to 0.5    | Cap on the growing ratio                                         |
| `strikes`           | 3       | 1 to 1000      | Strikes of a failing repair                                      |
| `patience`          | 12      | 1 to 10000     | Iterations without a 0.1% lower raw overlap that end a strike    |
| `explorePatience`   | 24      | 1 to 10000     | Patience of exploring, restart and start repairs                 |
| `globalSamples`     | 48      | 0 to 10000     | Container-wide samples per relocation                            |
| `localSamples`      | 24      | 0 to 10000     | Near samples per relocation                                      |
| `weightGrowth`      | 2       | 1 to 100       | GLS multiplier of the deepest conflict                           |
| `weightDecay`       | 0.95    | 0 to 1         | GLS decay of former conflicts                                    |
| `descentIterations` | 40      | 1 to 100000    | L-BFGS iterations per descent                                    |
| `maxRuin`           | 1       | 0 to 1         | Largest ruined fraction of P                                     |
| `restartAfter`      | 40      | 0 to 100000    | Failed explorations in a row before a restart (0: never)         |
| `restartSlack`      | 0.02    | 0 to 1         | Restart container relative to the best                           |
| `evaluationWork`    | 4000    | 1 to 10000000  | Counted feature tests per assessment and piece                   |
