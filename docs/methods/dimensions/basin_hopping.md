# Basin hopping (`basin_hopping`)

Board title: **Basin hopping**. Summary: _Shakes the packing up a little, lets it settle tight
again, and keeps the result when it is better, or now and then when it is only slightly worse._

[CALC] The generic port of the polygon method ([basin_hopping](../basin_hopping.md)) to the
kernel of [README.md](README.md). Code: `packages/methods/src/methods/basin_hopping.ts`, with
the operators in `basin-operators.ts` and the start and final refinement it shares with
shrink_repair in `basin-final.ts`. It needs no kernel capability; it uses `swap` and `seeds`
where the kernel has them.

## The loop

[CALC] Each hop perturbs a copy of the current packing with one operator, squeezes it
(`local.ts` `squeeze`: size plus mu times the penalty energy, mu from 10 to 1e6, then a relax),
offers it, and accepts the finished score by a Metropolis rule. The polygon method calls the
penalty method for its local solve; the framework does not let one method call another, so
the squeeze is the local solve here. The framework keeps the best and checks it with the
server's rule, so a hop never decides validity.

- **Start.** Without a valid supplied start, the first candidate (the supplied start, else the
  first of the kernel's structured starts, `seeds`, four; else random poses) is squeezed and
  offered at once, until one finishes, so that the run has a result as early as the budget
  allows. Then the other candidates are squeezed, fitted together to what is left, and offered
  smallest first while they could beat the current packing, until one finishes. Structured
  starts squeeze to very different sizes (polyhedra/tetintet/6: 2.67, 3.00, 2.30 and 2.30 for
  the four tetrahedra seeds of seed 1), so all are squeezed. A valid supplied start that this
  first solve does not beat stays the current packing.
- **Squeezes fitted to the budget.** A squeeze takes `localIterations` L-BFGS iterations per
  solve (seven solves: six penalty weights and a relax), or fewer so that its solves and one
  offer fit in what is left (`fitIterations` of `seed-starts.ts`, as penalty and seed do; an
  iteration counts 1.5 gradients). A run's first squeeze takes at most half of what the offer
  leaves, and stops outright where the budget leaves the offer, so a run returns a result
  wherever one finish fits. Squeezing every structured start in full before the first offer,
  as earlier versions did, returned nothing below about 25,000 evaluations on the polygon
  fold problems of 2D on 3D, where a gradient costs 9 evaluations (below).
- **The current packing** is the squeezed state, not its finished configuration: the next hop
  perturbs the local minimum of the penalty, and the finished score decides acceptance. On
  polyhedra/tetintet/6 and 12 and cubincub/10 (seeds 1 to 6, 20,000 evaluations), carrying the
  finished configuration instead made no measurable difference (measured on an earlier version).
- **Acceptance.** A strict improvement is always accepted. A worse finished score `s'` is
  accepted with probability `exp(-(s' - s) / (T s))`, with `T` the temperature _relative to
  the current score_ `s`. The polygon method's temperature is in score units. Here the score
  is a container side, a sphere's rho or a polytope's edge, so a relative temperature means
  the same in every space. Scores within a relative 1e-9 are ties, and a tie is accepted at
  `T > 0`. The finished score decides, never the squeezed size: a test with a finishing that
  adds 20% to half the packings checks it.
- **Redraws.** A perturbation that leaves the configuration unchanged is redrawn without a
  solve. After eight redraws in a row a kick is forced.
- **Final refinement** (`basin-final.ts`, shared with shrink_repair). With an evaluation
  budget, the best packing gets a tight squeeze (penalty weights 1e5, 1e7 and 1e9, 400
  iterations each) at the end and is offered; the hops then go on with what is left. Its
  reserve is its squeeze, estimated at 1.25 times the largest squeeze the run has made and
  at most `refinementEvals`, plus one offer (the finish and the server's check). It runs only
  when that reserve fits in a quarter of the budget, it starts before the hop that could cut
  into the reserve (a hop being as dear as the dearest so far), and its squeeze stops where
  the budget leaves one offer and one evaluation. A time-only run has no refinement: it has no
  known end.

[CALC] Why the refinement is planned this way. With `min(3000, budget / 6)` kept back, as in
the first version, the refinement never completed on polyhedra and boundary (measured
then): their squeezes cost about 3,000 to 4,600 evaluations there and an offer 1,538 and
4,000, more than the reserve. Three weights instead of six halved its cost (polyhedra/tetintet/6:
2,586 against 4,616 evaluations; boundary/tesseract/ball/13: 2,091 against 3,911) for nearly
the same gain. With a third of the budget it ran on boundary/tesseract/ball/13 at 20,000
evaluations and took about two of the four hops a run gets there: seeds 1 and 2 ended at
2.4368 and 2.4060, against 2.4093 and 2.4024 with a quarter, which skips it there (seed 3:
2.533 both ways).

## Operators

[CALC] The operator is drawn with weight `base × (weightFloor + q)`, with `q` an exponential
moving average (rate `adaptationRate`) of the operator's improvements of the current score.
A zero base weight disables an operator, and all zero falls back to kicks.

| Operator | What it does, by kernel calls only                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------- |
| kick     | `jiggle` `max(1, ceil(kickFraction P))` distinct pieces by up to the adaptive kick size, in steps.                        |
| swap     | `swap` two random pieces' orientations. Weight 0 where the kernel lacks the capability.                                   |
| reinsert | Pick a piece in the way, then move it to the best of `reinsertionTrials` `randomPose` samples by its `pieceEnergy`.       |
| restart  | A structured or supplied start, every piece jiggled by `restartStrength` times the kick size; without any, `randomStart`. |

[CALC] **The piece to reinsert.** The polygon method takes the piece whose removal shrinks the
enclosing container most. The kernel has no enclosure, so here the piece is drawn with
probability proportional to its `pieceEnergy` in a copy of the packing shrunk by 2%. In that
copy every contact is an overlap, and a piece's energy is what removing it would take off the
shrunk packing's energy: the pieces most in the way of a smaller size are the likeliest.
Drawing rather than taking the largest keeps one stuck piece from being picked every time.

[CALC] **The adaptive kick size.** After every kick, the size `a` becomes
`clamp(a exp(rate (I − targetAcceptance)), 0.001, 10)`, where `I` is 1 when the hop was
accepted _or came back to the same minimum_ (a tie). The polygon method leaves the size alone
after a tie. On the reference kernel, nearly every kick from a deep minimum came back to it
(P = 9, seed 1: 43 of 44 kicks), so the size never grew and the run stayed in the 3.650114
basin (best known 3.613126). Counting a return as an acceptance grows the kick until hops
leave the basin. P = 9, seeds 1 to 20, 30,000 evaluations: 14 of 20 runs within 1% of the
best known before, 20 of 20 after (reproduced in a separate check).

## Differences from the polygon method

[CALC]

- **Left out: cluster rotation, peel and cleave.** Each needs the pieces' positions in a
  common frame: a cluster's centroid and a rigid turn about it, a container wall's normal and
  the outermost layer along it, a vertex of another piece and a cross-shaped gap. The kernel
  exposes none of these. Its charts are local to each piece and may be curved, so no kernel
  call alone moves a group of pieces rigidly. They stay polygon-only.
- **No `rotationMagnitude`.** A kick jiggles every variable of a piece, its turn included, by
  up to the same number of steps; the kernel's `steps` set what a step of each variable is.
- **Reinsertion samples** are uniformly random poses only. The polygon method's anchors (the
  container's centre and the removed piece's centre) and its aligned angles (neighbours'
  angles, wall directions) need positions and angles the kernel does not expose.
- **The no-op check** compares the configurations exactly (their JSON). The polygon method
  compares angles modulo the piece's symmetry, so an exchange of two orientations that differ
  by a symmetry is a redraw there and a (wasted) hop here.
- **No time reserve.** The polygon method keeps a sixth of a finite time for its refinement;
  here only an evaluation budget has one.
- **Also left out:** the restricted, wall-aligned refinement (polygon-specific), the pool of
  local optima (the framework has no emission channel), and the seed slice (the kernel's
  `seeds` take its place).
- **Globals** (variables of the whole packing, such as a free torus lattice's shear): no
  operator moves them; the squeeze optimises them with the pieces (`local.ts` scales them by
  `globalSteps`).

## Budget

[CALC] Everything is charged through the counted kernel: a squeeze is its energy calls
(about 200 to 600 evaluations per hop on the reference kernel for P = 8 to 12; about 500
to 3,300 from a random start on the space kernels below). Picking the piece to reinsert costs one sweep (P `pieceEnergy`
calls). Each reinsertion sample costs 1/P, four structured starts cost 4, and a `randomStart`
costs 1. Each offer costs the kernel's `finishCost`, plus its validate cost when it improves
the best: 2 on the reference kernel, 35 to 60 on sphere and torus, 1,003 on curved/-1/3/4/6,
1,538 on polyhedra/tetintet/6 and 4,000 on boundary/tesseract/ball/13. The framework ends a
run rather than start an offer that would overrun the budget, so a run may end up to one
offer short. A run is reproducible from its seed with an evaluation budget.

## Parameters

[CALC] The schema is an object with `additionalProperties: false`. Every property has a
title, a description, a default and bounds.

| Parameter           | Default                                 | Range          | Meaning                                                                                   |
| ------------------- | --------------------------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| `temperature`       | 0.01                                    | 0 to 10        | Relative to the current score; 0 accepts strict improvements only                         |
| `kickMagnitude`     | 0.35                                    | 0.001 to 10    | First kick size, in steps; adapted within [0.001, 10]                                     |
| `kickFraction`      | 0.4                                     | 0 to 1         | Fraction of the pieces a kick moves, at least one                                         |
| `reinsertionTrials` | 48                                      | 1 to 4096      | Random poses tried for a reinserted piece                                                 |
| `restartStrength`   | 3                                       | 1 to 100       | Kick size multiple for a restart from a structured or supplied start                      |
| `targetAcceptance`  | 0.5                                     | 0 to 1         | Kick acceptance (returns included) that the kick size aims at                             |
| `adaptationRate`    | 0.15                                    | 0 to 1         | Rate of the operator averages and the kick adaptation; 0 disables both                    |
| `weightFloor`       | 0.2                                     | 0.001 to 1     | Exploration floor of the operator weights                                                 |
| `weights`           | kick 4, swap 1, reinsert 2, restart 0.3 | each 0 to 1000 | Base weights; swap only where the kernel can swap                                         |
| `localIterations`   | 200                                     | 1 to 100,000   | L-BFGS iterations per penalty weight of a hop's squeeze                                   |
| `refinementEvals`   | 3000                                    | 0 to 1,000,000 | Most evaluations of the final refinement's squeeze; it runs only when it fits (see above) |

[CALC] The operator defaults are the polygon method's. The temperature 0.01 is about the
polygon default (0.04 at sizes near 3 to 4) made relative. In a sweep on P = 5 to 20,
temperatures 0.003 to 0.03 and other kick fractions and weights were within seed noise, so
nothing else was tuned. For a hop from a kicked optimum (P = 8, 10, 12; 20 kicks each), the
default squeeze schedule found the best results of the schedules tried (first weight 10, 100
or 1000; 50 or 200 iterations per weight), at about the lowest cost.

## Measurements

### The space kernels

[CALC] Defaults, no start, seeds 1 to 3, 20,000 evaluations, with the early first offer. The
record is the problem's `score_cert` in `data/<space>/records.json`; ratios are score over it,
in brackets. Every result was checked with the kernel's server rule. Node v26.5.0, Apple M1
Pro, load average near 150.

| Problem                    | Record (score_cert) | basin_hopping: seeds 1, 2, 3                               | shrink_repair: seeds 1, 2, 3                               |
| -------------------------- | ------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| sphere/0/13                | 2.005568            | 2.005568 (1.00000), 2.005568 (1.00000), 2.005568 (1.00000) | 2.005568 (1.00000), 2.005568 (1.00000), 2.005568 (1.00000) |
| torus/hex/5/8              | 4.416365            | 4.447300 (1.00700), 4.449288 (1.00745), 4.447298 (1.00700) | 4.447493 (1.00705), 4.447485 (1.00705), 4.442754 (1.00598) |
| curved/-1/3/4/6            | 2.843790            | 2.843790 (1.00000), 2.843790 (1.00000), 2.843790 (1.00000) | 2.843790 (1.00000), 2.843790 (1.00000), 2.843790 (1.00000) |
| polyhedra/tetintet/6       | 2.290995            | 2.290994 (1.00000), 2.290994 (1.00000), 2.290994 (1.00000) | 2.290994 (1.00000), 2.290995 (1.00000), 2.290996 (1.00000) |
| boundary/tesseract/ball/13 | 2.397495            | 2.397781 (1.00012), 2.397624 (1.00005), 2.467637 (1.02926) | 2.410206 (1.00530), 2.397797 (1.00013), 2.399736 (1.00093) |

[CALC] Notes on the table:

- polyhedra/tetintet/6: four of the six results (basin_hopping, seeds 1 to 3; shrink_repair,
  seed 1) are 2.290994449 to 2.290994452, accepted by the kernel's finishing at tolerance 0 and
  by the server rule, up to 3.2e-7 below the record's float score 2.2909947650 (1.4e-7 relative).
  This is not verified or certified, and no record is claimed; it needs the space's
  certification first.
- boundary/tesseract/ball/13: an offer costs 4,000 evaluations, so a run makes about four
  hops, and its result depends on those few hops (seed 3).
- curved/-1/3/4/6 is a landscape of deep local optima: squeezed random starts reach the
  record about one time in eight. Over seeds 1 to 6, all 6 runs of each method reach the
  record with the current kernels.
- The version that squeezed every structured start before its first offer gives identical
  results on these five problems with the same kernels (seeds 1 to 3; torus seeds 1 to 6):
  at 20,000 evaluations the early first offer changes only the order of the starts' offers.
- On curved/1/4/4/5 and curved/-1/4/4/8 neither method finds any valid configuration in
  20,000 evaluations (seeds 1 and 2): the squeeze there ends with a large energy (K = 1
  collapses to the lower bound; K = -1 with P = 8 ends near 1.3), and the curved finishing,
  an SLP polish of 40 iterations, gives up. That is a property of the kernel's energy and
  finishing, not of these methods.

### Polygon fold problems (2D on 3D)

[CALC] The surface kernel's polygon fold problems difference their gradient: one costs 9
evaluations, and an offer 242 (the cube) or 202 (the rhombic dodecahedron). The board sizes a
generic round there from 5,000 evaluations up. Scores, seeds 1, 2, 3; "none" is a run that
returned no valid configuration; data/surface/records.json has 1.216554 for the cube problem
and no record for the rhombic dodecahedron one.

| Problem                               | Evaluations | Every start squeezed first | Early first offer         |
| ------------------------------------- | ----------- | -------------------------- | ------------------------- |
| surface/cube/fold/4/7                 | 1,000       | —                          | 1.86860, 1.68258, 1.80393 |
| surface/cube/fold/4/7                 | 5,000       | none, none, none           | 1.41422, 1.41662, 1.27647 |
| surface/cube/fold/4/7                 | 10,000      | none, none, none           | 1.41422, 1.41421, 1.27494 |
| surface/cube/fold/4/7                 | 25,000      | 1.25000, 1.25177, 1.25000  | 1.25000, 1.25177, 1.25000 |
| surface/rhombic_dodecahedron/fold/4/5 | 5,000       | none, none, none           | 1.04193, 1.09322, 1.04951 |
| surface/rhombic_dodecahedron/fold/4/5 | 10,000      | none, none, none           | 1.03851, 1.08866, 1.03851 |
| surface/rhombic_dodecahedron/fold/4/5 | 25,000      | 1.03851, 1.03851, 1.03851  | 1.03851, 1.03851, 1.03851 |

[CALC] On the cube problem every budget tried from 250 evaluations (one offer and the four
structured starts: 250, 300, 500, 1,000, 2,000, 5,000 and up) returns a valid configuration.

### The reference kernel

[CALC] P unit disks in a circle (`packages/methods/src/reference/disks.ts`), defaults, no
start, seeds 1 to 5, evaluation budgets only. "Best known" is `data/records.json` for circles
in a circle (N = M = 0; Erich Friedman's Packing Center and Eckard Specht's Packomania, as
cited there). Ratios are score over best known. Every result was checked with `validateDisks`
at tolerance 0. Node v26.5.0, Apple M1 Pro, load average near 150, so the seconds are observed
wall times, not throughput claims. Scores are reproducible from seed and budget.

```sh
nice -n 10 npx tsx packages/methods/scripts/bench-basin_hopping.ts 2-30 5 30000
nice -n 10 npx tsx packages/methods/scripts/bench-basin_hopping.ts 2-30 5 10000
```

| P   | Best known | 10,000: mean | 10,000: worst | 30,000: mean | 30,000: worst | 30,000: best − known | Seconds per run (30,000) |
| --- | ---------- | ------------ | ------------- | ------------ | ------------- | -------------------- | ------------------------ |
| 2   | 2.000000   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | -2.2e-16             | 0.02                     |
| 3   | 2.154701   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 0.0e+0               | 0.01                     |
| 4   | 2.414214   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 0.0e+0               | 0.02                     |
| 5   | 2.701302   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 8.9e-16              | 0.02                     |
| 6   | 3.000000   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 3.6e-15              | 0.03                     |
| 7   | 3.000000   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 0.0e+0               | 0.03                     |
| 8   | 3.304765   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 2.2e-15              | 0.04                     |
| 9   | 3.613126   | 1.00409      | 1.01024       | 1.00000      | 1.00000       | 4.4e-15              | 0.05                     |
| 10  | 3.813026   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 8.9e-11              | 0.06                     |
| 11  | 3.923804   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 3.3e-11              | 0.06                     |
| 12  | 4.029602   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 1.7e-11              | 0.07                     |
| 13  | 4.236068   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 2.5e-14              | 0.08                     |
| 14  | 4.328429   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 7.1e-11              | 0.09                     |
| 15  | 4.521357   | 1.00130      | 1.00130       | 1.00000      | 1.00000       | 2.5e-11              | 0.10                     |
| 16  | 4.615426   | 1.01832      | 1.02405       | 1.00000      | 1.00000       | 7.0e-11              | 0.11                     |
| 17  | 4.792034   | 1.00926      | 1.01496       | 1.00000      | 1.00000       | 2.8e-11              | 0.13                     |
| 18  | 4.863703   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 1.8e-11              | 0.14                     |
| 19  | 4.863703   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 7.4e-12              | 0.14                     |
| 20  | 5.122321   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 5.1e-11              | 0.16                     |
| 21  | 5.252317   | 1.00408      | 1.02039       | 1.00000      | 1.00000       | 4.1e-11              | 0.17                     |
| 22  | 5.439719   | 1.00199      | 1.00346       | 1.00007      | 1.00016       | 6.7e-11              | 0.18                     |
| 23  | 5.545204   | 1.00583      | 1.00995       | 1.00006      | 1.00032       | 8.6e-11              | 0.20                     |
| 24  | 5.651661   | 1.00331      | 1.00331       | 1.00277      | 1.00331       | 8.1e-3               | 0.21                     |
| 25  | 5.752824   | 1.00463      | 1.00631       | 1.00134      | 1.00436       | 6.2e-9               | 0.22                     |
| 26  | 5.828177   | 1.00600      | 1.01500       | 1.00300      | 1.01500       | 6.3e-11              | 0.24                     |
| 27  | 5.906398   | 1.01161      | 1.01630       | 1.00000      | 1.00000       | 1.3e-5               | 0.25                     |
| 28  | 6.014938   | 1.01344      | 1.01732       | 1.00362      | 1.00893       | 5.4e-9               | 0.26                     |
| 29  | 6.138598   | 1.00094      | 1.00113       | 1.00002      | 1.00010       | 1.2e-10              | 0.28                     |
| 30  | 6.197741   | 1.00279      | 1.01393       | 1.00279      | 1.01393       | 6.8e-11              | 0.30                     |

[CALC] Of 145 runs, 143 are within 1% of the best known at 30,000 evaluations (mean ratio
1.00047) and 125 at 10,000 (mean 1.00302). At 30,000, 133 runs are within 0.1%. The final
refinement brings the best runs to within about 1e-10 of the best known. The negative
difference for P = 2 (−2.2e-16) is float rounding in the reference kernel's finishing, not a
better packing. P = 27 ends 1.3e-5 above the stated value in all five runs. Seeds 1 to 20 at
P = 2 to 10, 30,000 evaluations: 180 of 180 within 1%.

[CALC] A dear finishing that fails on every other call (reference kernel, P = 10, finishCost
2,000, so 4,000 an improving offer; seeds 1 to 5, 40,000 evaluations): ratios 1.00000,
1.01117, 1.00000, 1.01531, 1.01531. With finishCost 5,000 at P = 8 (the same check as
for shrink_repair), 3.304765, the best known, at 20,000 evaluations.

[CALC] Tests: `packages/methods/test/basin_hopping.test.ts`. They cover:

- registration;
- within 1% of the best known for P = 2 to 10 at 30,000 evaluations (seed 1; seeds 1 to 20
  all pass);
- seeded reproducibility;
- the evaluation budget, from 1 to 5,000;
- a valid start never worsened, a loose start improved and a heap of disks repaired;
- refused parameters;
- swap used only with the capability, and the fallback to kicks;
- the kick growing in a deep basin;
- acceptance by the finished score (a finishing that adds 20% to half the packings; a
  Metropolis rule on the squeezed size fails it);
- a dear finishing that fails half the time, with the refinement run; the refinement skipped
  when it does not fit; a finishing that gives up on loose states;
- a result at 300, 1,000 and 3,000 evaluations when a gradient costs 9 and an offer 242 (the
  earlier versions return none);
- the Metropolis rule, the operator draw and the reinsertion into a hole.

## Limitations

- [CALC] On problems whose kernel squeeze does not reach a state its finishing accepts
  (curved/1/4/4/5, curved/-1/4/4/8), basin_hopping returns nothing.
- [CALC] With a dear finishing every hop pays for an offer: boundary/tesseract/ball/13 makes
  about four hops in 20,000 evaluations.
- [SPEC] The relative temperature assumes that scores of one problem differ by a few percent
  at most. A space whose score is far from proportional to the packing's scale may need
  another temperature.
- [CALC] Reinsertion samples uniformly random poses and keeps the least overlap. It cannot find
  an exactly piece-sized hole except by chance (the centre space of such a hole has zero
  area), and the squeeze that follows has to close the rest.

## References

[EST] Wales and Doye (1997) and Lourenço, Martin and Stützle (2003), as verified on the
polygon method's page ([basin_hopping.md](../basin_hopping.md#verified-references)).
