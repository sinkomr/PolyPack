# Shape continuation (`morph`), in every Dimension

[CALC] `morph` warms a sequence of local problems from soft to true shape on
any kernel with the capability `shape`
(`packages/methods/src/methods/morph.ts`). From a supplied arrangement, or a
short start, it packs the pieces as their inscribed disks or balls, then makes
them harder in stages, re-packing at each stage from the previous stage's
result, until they have their true shape. Each stage has a slice of what is
left of the budget, so a continuation always reaches the true shape. The
arrangement at t = 1 is repaired and offered; soft stages are not offered.
Further continuations start from fresh random starts until the budget ends,
and the framework keeps the best.

Board title: "Shape continuation". Summary: "Packs soft round versions of the
pieces first, then sharpens them into their real shapes in small steps,
re-packing after each step."

The polygon method is described in [`docs/methods/morph.md`](../morph.md).
This page covers the generic port and what differs from it.

## The method on a kernel

[CALC] The kernel's `setShape(s, t)` gives the soft pieces, from the inscribed
disk or ball at t = 0 to the true shape at t = 1, every one inside the true
piece. Each space has its own family: the polygon method's inscribed family
`tP (+) disc((1 - t) r)` on the torus, and on the surface with its round
corners replaced by chords; rounded solids for polyhedra; caps cut from the
polygons on the sphere; polygons cut by a disk of growing radius in curved
space. Disks and balls are their own inscribed shape, so `setShape` changes
nothing for them. `finish` and `validate` always use the true shape.

One continuation:

1. **Start.** The supplied arrangement for the first continuation; without
   one, one structured seed of the kernel (capability `seeds`) for the first
   continuation, and a random start (`randomStart`) otherwise.
2. **First offer.** When nothing valid is held yet, before any long work: the
   first continuation's start when it is supplied or a seed, else (or when it
   does not finish) up to two random starts relaxed apart at their roomy size
   (`harden-offers.ts`, shared with `harden`). Raw random starts rarely finish
   (none of ten on the boundary's balls or the surface's squares). A run
   stopped early returns this offer when the space's finishing accepts it;
   curved/-1/3/4/6, which has no seeds, refuses about a quarter of its relaxed
   random starts, and then the run has no result until a continuation ends.
3. **Jitter.** Every piece is moved by a seeded random amount of up to `jitter`
   steps in each variable (`jiggle`).
4. **Schedule.** Base stages `t_j = t0 + (1 - t0) (j / (stages - 1))^spacing`,
   j = 0 to stages - 1, the last exactly 1. With `adaptive`, a stage whose
   residual (the root of the energy after its local solve, an upper bound of
   its largest overlap, in the kernel's lengths) exceeds `residualThreshold`
   halves the next shape step, at most twice per base interval.
5. **Stage.** Set the shape t. From the second stage on, a homothety
   (`setSize`, which keeps the normalized arrangement) carries the arrangement
   to the first contact of the new shape: apart when the harder pieces
   overlap, together when none touch, by bisection on the size with the
   energy (about 25 to 45 evaluations, `morph-stage.ts`). Then squeeze:
   minimise size + mu E for mu = `initialWeight` x 10^k, k = 0 to
   `outerIterations` - 1, `innerIterations` L-BFGS iterations each, and relax
   at the size reached (`local.ts`). Soft stages may squeeze to half of the
   problem's bound, which holds for the true shapes only; the last stage keeps
   the bound.
6. **Offer** the arrangement at t = 1, repaired by the squeeze's closing
   relaxation; the framework finishes it with the space's exact finishing.

With `localMethod` = `relax`, the first and last stages squeeze as above and
the stages between keep the size and only relax the overlaps that the harder
shape creates (no homothety): the pieces harden inside the container that the
softest pieces were packed into, then the last stage squeezes the true shapes.

**Budget.** A stage's energy calls are charged (a gradient at the kernel's
`gradCost`, 8 for the surface's polygons; the homothety's bisection one each);
an offer costs `finishCost + validateCost`. Under an evaluation budget each
stage gets a slice of what is left after the continuation's offer, shared with
the stages still to come, as the polygon method does: (remaining - offer) /
(stages left, this one included). The last stage, t = 1, therefore always
runs. A slice holds the stage to it (`withAllowance`: past it the energy
refuses and L-BFGS stops at its last accepted point). The squeeze gets three
quarters of the slice; when it runs out, the rest goes to a closing
relaxation, since a squeeze cut at a low penalty weight leaves deep overlaps
that the space's finishing refuses. A stage cut by its slice causes no
subdivision. A new continuation starts only when its offer and 20 gradients
per stage fit in what is left. Continuations run until the evaluation or time
budget ends or the stop is set, or until `restarts` continuations are done
(`restarts` = 1 is the polygon method's single continuation). All randomness
comes from the run's seeded stream; a run with an evaluation budget is
reproducible from the seed.

## Design choices, with measurements

[CALC] Measured on the reference kernel and the tests' soft disks (below),
seeds 1–5, 30,000 evaluations, P = 13 to 30:

- **No homothety before the first stage.** The polygon method rescales before
  every stage. Tightening a roomy random start to its first contact before the
  first squeeze gave worse packings: median 6.3180 at P = 30 on both kernels,
  against 6.1977 to 6.2002 when the start was squeezed as it is (measured
  before the next change). The homothety between stages is kept.
- **Soft stages below the bound.** With the true-shape bound as the floor of
  every squeeze, the first soft stage could not pack the soft disks (for six
  disks of radius 0.7 it stopped at sqrt(6) = 2.449 instead of 2.1). Half the
  bound is the floor of soft stages; the results at P = 13 to 30 did not
  change beyond the five-seed noise.
- **Restarts.** A single continuation, as in the polygon method, ends long
  before 30,000 evaluations: 1,400 to 7,900 evaluations for P = 2 to 30 on
  both kernels (seeds 1–10). Further
  continuations from random starts improved the median at P = 25 and 30 on
  the reference kernel (5.7616 and 6.1999 against 5.8296 and 6.3180).

## Parameters and defaults

| Parameter         | Default | Allowed values / purpose                                                     |
| ----------------- | ------- | ---------------------------------------------------------------------------- |
| t0                | 0       | 0 to below 1; shape of the first stage (0 inscribed disk or ball)            |
| stages            | 7       | Integer 2–64, endpoints included                                             |
| spacing           | 1       | 0.25–4, schedule power                                                       |
| adaptive          | true    | Boolean, residual-based halving of the next step, at most twice per interval |
| residualThreshold | 0.02    | 0–1, in the kernel's lengths                                                 |
| localMethod       | squeeze | squeeze, relax                                                               |
| innerIterations   | 120     | Integer 1–2000, L-BFGS iterations per penalty weight and of a relaxation     |
| outerIterations   | 6       | Integer 1–30, penalty weights of a squeeze                                   |
| initialWeight     | 10      | 0.001–1e8, first penalty weight; each next one is ten times larger           |
| jitter            | 0.03    | 0–0.5, seeded move of every piece before a continuation, in steps            |
| restarts          | 0       | Integer 0–100,000; continuations, 0 = until the budget ends                  |

`stages`, `spacing`, `adaptive`, `residualThreshold`, `innerIterations`,
`outerIterations`, `initialWeight` and `jitter` keep the polygon method's
defaults and meaning. The polygon method's `path` (superellipses for squares),
`family` (the circumscribed family), `localMethod` = `mc_compress` with its
`mcSweeps`, `translationStep` and `rotationStep`, and `maxExponent` and
`vertices` have no counterpart: the kernel's soft shapes are the inscribed
family only, and hard-particle Monte Carlo is the separate method
`mc_compress`. `t0` and `restarts` are new.

## Deviations from the polygon method

[CALC]

1. The kernel's energy, soft shapes and `squeeze` instead of the shared
   polygon geometry and its augmented penalty: the penalty weights rise
   tenfold on a fixed schedule instead of fourfold when the residual stalls,
   and there are no multipliers.
2. One offer per continuation, at t = 1, instead of one assessment per
   accepted L-BFGS iteration; no duplicate suppression. A space's finishing
   can cost thousands of evaluations (2,000 for the boundary's balls).
3. The start is the supplied arrangement, a kernel seed or a random start,
   instead of a seed sub-run; the first offer is a seed or a relaxed random
   start; no homothety before the first stage.
4. Continuations repeat from random starts until the budget ends.
5. The residual is the root of the energy, an upper bound of the largest
   overlap.
6. A stage's slice keeps a quarter for a closing relaxation.

## Measurements

[CALC] Measured on 2026-10-26 on an Apple M1 Pro (eight logical CPUs), Node
v26.5.0, under heavy unrelated load, two benchmark processes at a time.
Seconds are wall times under that load; scores do not depend on it. Every
result below was checked valid at tolerance 0. No result is below a published
value.

### The reference kernel

Command (`packages/methods/scripts/bench-morph.ts`):

```sh
nice -n 10 npx tsx packages/methods/scripts/bench-morph.ts 30000 10 2,3,4,5,6,7,8,9,10,11,12 '{}' disks
nice -n 10 npx tsx packages/methods/scripts/bench-morph.ts 3000 10 2,3,4,5,6,7,8,9,10,11,12 '{}' soft
```

"Disks" is the reference kernel, where `setShape` changes nothing, so every
stage squeezes the same disks. "Soft disks" is the tests' kernel
(`packages/methods/test/soft-disks.ts`): the same problem, whose soft shape at
t is a disk of radius 1 - 0.3 (1 - t). Registered defaults, no start, seeds
1–10. Each cell is the median / the worst of score / best known - 1, with the
best known radius from `DISKS_IN_CIRCLE_BEST`.

|   P |    Disks, 3,000 |    Disks, 30,000 | Soft disks, 3,000 | Soft disks, 30,000 |
| --: | --------------: | ---------------: | ----------------: | -----------------: |
|   2 |           0 / 0 |            0 / 0 |             0 / 0 |              0 / 0 |
|   3 |           0 / 0 |            0 / 0 |             0 / 0 |              0 / 0 |
|   4 |           0 / 0 |            0 / 0 |             0 / 0 |              0 / 0 |
|   5 |           0 / 0 |            0 / 0 |             0 / 0 |              0 / 0 |
|   6 | 1.8e-5 / 1.9e-5 |       0 / 1.9e-8 |   1.8e-5 / 1.9e-5 |        0 / 1.0e-13 |
|   7 |           0 / 0 |            0 / 0 |             0 / 0 |              0 / 0 |
|   8 |     0 / 9.4e-14 |            0 / 0 |       0 / 3.8e-13 |              0 / 0 |
|   9 | 1.0e-2 / 2.1e-2 | 3.7e-13 / 1.0e-2 |   1.0e-2 / 1.0e-2 |  2.4e-13 / 1.2e-12 |
|  10 | 1.3e-7 / 1.2e-2 |  2.4e-8 / 2.4e-8 |   7.6e-3 / 1.5e-2 |    2.4e-8 / 2.4e-8 |
|  11 | 1.2e-8 / 3.3e-2 |  8.5e-9 / 1.2e-8 |   1.2e-8 / 3.3e-2 |    8.5e-9 / 8.5e-9 |
|  12 | 4.2e-9 / 4.2e-9 |  4.2e-9 / 4.2e-9 |   4.2e-9 / 4.2e-9 |    4.2e-9 / 4.2e-9 |

Runs used 2,901 to 2,996 of 3,000 evaluations and 29,940 to 29,991 of 30,000,
at most 0.17 s per run.

- At 30,000 evaluations every run for P = 2 to 12 reaches the best known
  packing to within 2.4e-8, except one seed for P = 9 on the reference
  kernel, which stays 1.0% above, at another local optimum (3.650114). At
  3,000 the medians for P = 9 (both kernels) and P = 10 (soft disks) stay in
  other local optima; for P = 6 the stages' slices leave 1.8e-5.
- The kernel's hexagonal seeds start the first continuation; for P = 12 that
  continuation alone reaches the best known packing on both kernels.
- The stored best known values for P = 8, 10 and 12 were corrected after the
  checks of the first version (see harden.md).

### Space kernels

[CALC] Six problems of the spaces, registered defaults, no start, seeds 1–5,
5,000 and 20,000 evaluations. "Record" is the stored value
(`data/<space>/records.json`, `score_cert`). "Within" counts runs at most 1e-4
relative above it.

| Problem                   | Record   | Budget | Best     | Median   | Worst    | Within 1e-4 | Results | Evaluations used |
| ------------------------- | -------- | -----: | -------- | -------- | -------- | ----------: | ------: | ---------------- |
| sphere/4/12               | 1.111808 |  5,000 | 1.122175 | 1.130452 | 1.135129 |         0/5 |     5/5 | 4,801–4,966      |
| sphere/4/12               | 1.111808 | 20,000 | 1.122190 | 1.123578 | 1.127991 |         0/5 |     5/5 | 19,663–19,899    |
| torus/sq/4/5              | 2.236068 |  5,000 | 2.236068 | 2.236068 | 2.236068 |         5/5 |     5/5 | 4,216–4,990      |
| torus/sq/4/5              | 2.236068 | 20,000 | 2.236068 | 2.236068 | 2.236068 |         5/5 |     5/5 | 19,386–19,990    |
| curved/-1/3/4/6           | 2.843790 |  5,000 | 2.843793 | 4.085882 | 5.117883 |         1/5 |     4/5 | 4,937–5,000      |
| curved/-1/3/4/6           | 2.843790 | 20,000 | 2.843790 | 2.843793 | 4.076095 |         3/5 |     5/5 | 19,825–20,000    |
| polyhedra/cubincub/9      | 2.707107 |  5,000 | 2.707107 | 2.707107 | 2.709850 |         4/5 |     5/5 | 4,926–5,000      |
| polyhedra/cubincub/9      | 2.707107 | 20,000 | 2.707107 | 2.707107 | 2.707107 |         5/5 |     5/5 | 19,225–19,911    |
| boundary/tesseract/ball/8 | 1.931852 |  5,000 | 2.000000 | 2.000000 | 2.000000 |         0/5 |     5/5 | 4,001            |
| boundary/tesseract/ball/8 | 1.931852 | 20,000 | 1.936630 | 1.936630 | 1.936630 |         0/5 |     5/5 | 15,980–18,090    |
| surface/cube/fold/4/7     | 1.216554 |  5,000 | 1.224997 | 1.246720 | 1.301993 |         0/5 |     5/5 | 4,919–4,999      |
| surface/cube/fold/4/7     | 1.216554 | 20,000 | 1.216920 | 1.236511 | 1.392626 |         0/5 |     5/5 | 19,471–19,999    |

What these runs show, and no more than that:

- Every run returned a valid configuration within its budget except one:
  curved/-1/3/4/6 at 5,000, seed 4. The space's finishing refused both its
  relaxed random first offers (curved has no seeds) and its continuation's
  end, after the two failed offers had taken 2,000 of the 5,000 evaluations.
- On the boundary's balls an offer costs 4,000, so 5,000 evaluations pay for
  the first offer (a seed, 2.000000) and one continuation's stages; it ran
  out of budget before its own offer.
- In the first version, without stage slices, the same matrix (seeds
  1–3) ended continuations before t = 1 at a gradient of 8 (the surface:
  2.60 to 2.67 at 5,000).

### Variants at larger P

[CALC] Median (best) score over seeds 1–5 at 30,000 evaluations on the
reference and soft disks, P = 13 to 30; no stored best known values. Lower is
better.

```sh
nice -n 10 npx tsx packages/methods/scripts/bench-morph.ts 30000 5 13,15,18,20,25,30 '{"stages":3}' soft
```

| Kernel     | Variant          | P = 13          | 15              | 18              | 20              | 25              | 30              |
| ---------- | ---------------- | --------------- | --------------- | --------------- | --------------- | --------------- | --------------- |
| Disks      | default          | 4.2361 (4.2361) | 4.5272 (4.5214) | 4.8637 (4.8637) | 5.1223 (5.1223) | 5.7616 (5.7529) | 6.2001 (6.1977) |
| Disks      | 3 stages         | 4.2361 (4.2361) | 4.5272 (4.5214) | 4.8637 (4.8637) | 5.1223 (5.1223) | 5.7616 (5.7529) | 6.1998 (6.1987) |
| Disks      | 13 stages        | 4.2361 (4.2361) | 4.5272 (4.5214) | 4.8637 (4.8637) | 5.1223 (5.1223) | 5.7663 (5.7529) | 6.2002 (6.1987) |
| Disks      | relax            | 4.2361 (4.2361) | 4.5214 (4.5214) | 4.8637 (4.8637) | 5.1223 (5.1223) | 5.7608 (5.7544) | 6.2014 (6.2004) |
| Disks      | one continuation | 4.2361 (4.2361) | 4.5272 (4.5272) | 4.8637 (4.8637) | 5.1223 (5.1223) | 5.8296 (5.7529) | 6.3180 (6.2001) |
| Soft disks | default          | 4.2361 (4.2361) | 4.5272 (4.5214) | 4.8637 (4.8637) | 5.1223 (5.1223) | 5.7663 (5.7608) | 6.2003 (6.2001) |
| Soft disks | 3 stages         | 4.2361 (4.2361) | 4.5272 (4.5214) | 4.8637 (4.8637) | 5.1223 (5.1223) | 5.7608 (5.7608) | 6.2004 (6.2002) |
| Soft disks | 13 stages        | 4.2361 (4.2361) | 4.5272 (4.5272) | 4.8637 (4.8637) | 5.1223 (5.1223) | 5.7767 (5.7608) | 6.2002 (6.2001) |
| Soft disks | relax            | 4.2361 (4.2361) | 4.5214 (4.5214) | 4.8637 (4.8637) | 5.1223 (5.1223) | 5.8050 (5.7736) | 6.2145 (6.1977) |
| Soft disks | one continuation | 4.2361 (4.2361) | 4.5272 (4.5272) | 4.8637 (4.8637) | 5.1223 (5.1223) | 5.8065 (5.7655) | 6.2003 (6.2002) |

These five-seed samples do not separate the stage counts or the two local
solves; the defaults were kept, not tuned on them. A single continuation, as
in the polygon method, is worse at P = 25 and 30 on the reference kernel.
`harden` at the same budget ([harden.md](harden.md)) gives similar medians.

## Fit and limitations

[SPEC] Continuation can help when sharp contacts prevent a useful
rearrangement, but it may carry the same poor topology through every stage.
On the reference kernel the shape does not change, so `morph` there is
repeated squeezing of a seed and of random starts; the soft disks change only
their radius, not their form. Where corners appear (polygons, polyhedra) the
space kernels' rows above and the polygon page's measurements are the better
guide; six problems are too few to rank methods by.

[CALC] A run can end without a result where the space's finishing refuses
every offer (curved/-1/3/4/6 refuses about a quarter of its relaxed random
starts, and its random starts are barely roomier than its optimum, since the
room of a hyperbolic square is bounded).

## Verification

[CALC] `packages/methods/test/morph.test.ts` (14 tests):

```sh
npx vitest run packages/methods/test/morph.test.ts
```

It covers the schedule from t0 to exactly 1; the homothety to first contact,
apart and together, and its refusal to move coincident pieces; the method's
registration and capability; P = 2 to 10 on the reference kernel within 2.5%
of the best known radius at 30,000 evaluations; reproducibility from the seed
and a different result for another seed; the evaluation budget, a fixed
number of continuations ending on its own, a time limit; a valid start never
worsened and one continuation from a loose start reaching the optimum;
refused parameters; on the soft disks kernel: the stages' shapes 0, 1/3, 2/3
then 1, every state handed to `finish` at t = 1 (the first offer and the end),
the adaptive halving (0, 1/3, 1/2, 7/12, 2/3, 5/6, 11/12, then 1, with
`relax`), the size kept between the first and last stages with `relax`, and
P = 2 to 10 within 2.5%. On the expensive test kernel (see harden.md): at a
gradient of 4 the continuation's own state reaches t = 1 and its result is
offered at 5,000 and 20,000 evaluations (fails without stage slices), and a
run stopped after 60 calls returns a valid result with seeds and without
(fails with a raw first offer). The tests pass under Node 26 and Node 24.
