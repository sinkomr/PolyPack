# Shrink and repair (`shrink_repair`)

Board title: **Shrink and repair**. Summary: _Makes the space a little too small so that pieces
overlap, then moves them until nothing overlaps; when that stops working, it scrambles a patch
of pieces and tries again._

[CALC] The generic port of the polygon method ([shrink_repair](../shrink_repair.md)) to the
kernel of [README.md](README.md). Code: `packages/methods/src/methods/shrink_repair.ts`, with
the repair phase, regions and ruins in `shrink-phase.ts` and the final refinement it shares
with basin_hopping in `basin-final.ts`. It needs no kernel capability; it uses `swap` and
`seeds` where the kernel has them. As in the polygon method, it separates feasibility from
size: it makes the size too small, then removes the overlaps at that fixed size.

## The repair phase

[CALC] A repair works on a state at a fixed size, with the kernel's penalty energy weighted by
one guided-local-search (GLS) weight per piece (`SpaceKernel.energy`'s `weights`: a pair term
counts `(w_i + w_j) / 2`, a wall term `w_i`).

1. **Relocate** every piece in conflict (its `pieceEnergy` above 1e-18), in seeded random
   order. For each, try `globalSamples` uniformly random poses (`randomPose`) and
   `localSamples` poses near its current pose and near the best sample so far (`jiggle` by up
   to 0.5 steps, a fifth of that half the time). Move it to the sample of least weighted
   `pieceEnergy` when that is below where it is.
2. **Relax** the whole state with the weights (`local.ts` `relax`, `descentIterations`
   L-BFGS iterations). The repair has succeeded when the weighted energy is at most 1e-18
   (overlaps of about 1e-9 piece units).
3. **Weights.** Each piece still in conflict has its weight multiplied by between
   `1 + (weightGrowth − 1)/5` (shallowest) and `weightGrowth` (deepest), in proportion to its
   depth (the square root of its energy). The weights of former conflicts decay by
   `weightDecay` towards 1. All weights go back to 1 at each new size.

[CALC] A repair relaxes once. Each _strike_ then runs iterations until `patience` of them in a
row fail to lower the least total overlap of the repair by 0.1%, and ends by going back to that
least overlapping state, keeping the weights. After `strikes` strikes, or
`4 × strikes × patience` iterations, the repair has failed.

## Offers

[CALC] An offer that improves the best costs the kernel's `finishCost` and its validate cost:
2 evaluations on the reference kernel, 35 to 60 on sphere and torus, 1,003 on curved/-1/3/4/6,
1,538 on polyhedra/tetintet/6 and 4,000 on boundary/tesseract/ball/13. The first version
offered every repaired state and spent 18,000 of 20,000 evaluations on six offers on
boundary/tesseract/ball/13, ending 1.285 times the record (measured on an earlier version). So offers
follow a policy:

- A repaired state is **offered** only when its size is below the best and offers have taken at
  most `offerShare` (a quarter) of the evaluations used, and never into the final
  refinement's reserve. An offered state is accepted by its **finished score**: it becomes the
  current packing only when it finishes below the size it shrank from. A test with a
  finishing that adds 10% checks this.
- Otherwise it is **carried**: accepted by its repaired size, the kernel's model standing in
  for the finishing. With a cheap finishing (the reference kernel, sphere, torus) every
  improvement is offered at once; with a dear one most are carried.
- The smallest carried state below the best is kept apart, **unbanked**, so that a restart
  does not lose it. It is **banked** (offered) as soon as the offer share allows, and at the
  end by the final refinement, or, when no refinement fits, by the last offer the budget
  allows. A bank that does not finish is not offered as it is again; the refinement may still
  squeeze it to a state that finishes.

## The outer loop

[CALC] **Compression.** From the current packing at size `s`, the size is set to
`max(bound, s (1 − r))` (`setSize` keeps the normalized arrangement, so overlaps appear) and
repaired with `patience`. A smaller packing (by the offer policy above) becomes the current one
and `r` grows by a quarter (at most `maxShrinkRatio`); otherwise `r` halves. The first `r` is
`shrinkRatio`.

[CALC] **Polish at the floor.** When `r` falls below `minShrinkRatio`, compression has reached
the floor of the current packing's basin to within that ratio. With `polish` on, the next step
squeezes the current packing once (`local.ts` `squeeze`, its default schedule); it is offered
by the policy above, or carried when it is below the current packing by more than
`minShrinkRatio` (a squeeze ends a little below the floor by its own residual overlap, and
banking that would only re-finish the same packing). This step is not in the polygon method,
whose framework polishes every result at the end; without it, results stop about 1e-4 above
the floor of their basin.

[CALC] **Exploration.** From the floor, each repair works at `max(bound, s (1 − r))` with `r`
uniform between one and four times `minShrinkRatio`, at most 0.5, after a _ruin_ of a region of
`k` pieces, with `k` log-uniform between 1 and `maxRuin × P`. Exploring repairs use
`explorePatience`. A smaller packing returns to compression with `r` at least twice the
exploring ratio. (The clamps are new: `minShrinkRatio` may be up to 0.5, and four times it
targeted sizes at or below zero.)

[CALC] **The region, from the energy alone.** The polygon method takes the `k` pieces nearest
a random piece. The kernel exposes no positions, so neighbours are found through the energy.
In a copy of the packing shrunk by 25% (centre distances scale by 0.75), two pieces overlap
when their gap is below about a third of their contact distance (for unit disks, centres
closer than 2.67). With weight 1 for piece `c` and 0 for every other, `pieceEnergy(j)` is half
the pair term of `j` and `c` alone, so it names `c`'s neighbours, deepest (closest) first. The
region grows breadth first from a random piece, about one energy sweep per piece expanded,
and takes random pieces if it runs out of neighbours.

[CALC] **Ruins.** One kind is drawn uniformly per exploration:

- **shift**: `jiggle` every region piece by up to 1 step in each variable;
- **scatter**: `randomPose` every region piece;
- **swap** (only with the capability): exchange the orientations of `⌊k/2⌋` random pairs of
  region pieces.

The repair then puts the ruined pieces back.

[CALC] **Restarts.** After `restartAfter` explorations in a row without a smaller packing, a
`randomStart` is set to `max(bound, (1 + restartSlack) × min(best, current))` and repaired with
`explorePatience`; when that repair fails it is squeezed instead (growing the size barely
spreads curved space's centres). Its result becomes the current packing even when it is worse;
it is offered only when it could beat the best.

[CALC] **Start.** `start: "auto"` uses a valid supplied start as the current packing.
Otherwise it relaxes the supplied start, or the kernel's structured starts (four), at their own
sizes, and offers them smallest first; then random poses, relaxed. A start the finishing
refuses (curved space's polish gives up on loose layouts) is squeezed and offered again. The
first offer that finishes is the counterpart of the polygon method's insurance (a valid grid
scored first): a result as early as possible. `start: "random"` starts from random poses; a
valid supplied start is still kept by the framework if it is better. When offers are so dear
that fewer than four fit the budget, the starts are squeezed instead of relaxed: the start's
offer may then be the only one (finishCost 5,000 on the reference kernel at P = 8 and 20,000
evaluations: 4.031089 relaxed, 3.304765, the best known, squeezed). Relaxed starts leave the
work to compression, as in the polygon method; squeezed starts sit at the floor of their basin
and did worse (seeds 1 to 6, 20,000 evaluations: mean ratio about 1.0036 against 1.0075 on
torus/hex/5/8, 1.0074 against 1.0166 on boundary/tesseract/ball/13; equal on sphere/0/13 and
curved/-1/3/4/6; 4 of 6 against 5 of 6 at the record on polyhedra/tetintet/6). The first
version repaired the start at its own size, grew it by 5% after each failure and offered
every attempt; on curved/-1/3/4/6 that returned nothing in 3 of 6 runs (measured on an earlier version).

[CALC] **Final refinement** (`basin-final.ts`): as in [basin_hopping](basin_hopping.md), a
tight squeeze (penalty weights 1e5, 1e7 and 1e9) at the end, offered, with a reserve sized from
the run's own squeezes and the kernel's offer cost, run only when it fits in a quarter of the
budget. Here it squeezes the unbanked state when there is one, else the best. A time-only run
has no refinement; its carried progress is banked only by the offer share.

## Differences from the polygon method

[CALC]

- **Weights per piece.** The polygon weights each pair and wall. The kernel's weights are per
  piece, so a persistent conflict raises the weight of the pieces in it, and with it every
  term they are in.
- **No gradient refinement of a relocation.** The polygon method refines the best sample by
  ten gradient steps of the piece's loss. The kernel has no one-piece gradient, so the relax
  that follows does that work.
- **Sample angles.** The polygon method draws relocation angles from wall-parallel, neighbour
  and interlocking (turned by π/N) directions; here a sample is the kernel's own
  `randomPose` or `jiggle`.
- **Ruins.** The polygon method scatters a region's pieces over the disk they occupied; the
  scatter here covers the whole container (`randomPose`). The shift and swap ruins are new.
  The polygon method's rigid turn of a block about its mean centre is left out: it needs
  positions in a common frame, which the kernel does not expose.
- **Validity, accounting and starts.** The polygon method legalises and scores repaired poses
  itself, meters its work in feature tests (`evaluationWork`) with periodic assessments of the
  working state, and starts from the seed method's result after scoring a grid. Here the
  kernel's `finish` and the framework decide validity, the counted kernel charges every call,
  offers follow the policy above, and the start is described above.
- **Globals** (variables of the whole packing): relocations and ruins move only pieces; the
  relaxations and squeezes optimise the globals with them, and `setSize` keeps them.

## Budget

[CALC] The counted kernel charges every call: a relaxation is its energy calls, a relocation
sample `1/P`, a region expansion about one sweep and an offer the kernel's `finishCost` (plus
its validate cost when it improves the best). A failed repair costs a few hundred evaluations
on the reference kernel (P = 6: about 500). This is why the defaults below are much shorter
than the polygon method's. The framework ends a run rather than start an offer that would
overrun the budget. A run is reproducible from its seed with an evaluation budget.

[CALC] `pieceEnergy` is charged 1/P of an evaluation. Its share of the kernel's wall time
(profile of seed 1, 20,000 evaluations, kernel calls only) against its share of the charges:
sphere/0/13 57% against 32%, torus/hex/5/8 31% against 14%, polyhedra/tetintet/6 25% against
8%, curved/-1/3/4/6 6% against 7%. On sphere, torus and polyhedra a `pieceEnergy` call costs
two to four times its 1/P share of an energy sweep: that is the kernel's constant, not the
number of calls (relocation samples, one sweep per repair iteration and per region
expansion). One sweep per failed repair that nobody read was removed.

## Parameters

[CALC] The schema is an object with `additionalProperties: false`. Every property has a title,
a description, a default and bounds.

| Parameter           | Default (polygon) | Range          | Meaning                                                                 |
| ------------------- | ----------------- | -------------- | ----------------------------------------------------------------------- |
| `start`             | auto              | auto, random   | Supplied or structured starts, relaxed, or random poses                 |
| `shrinkRatio`       | 0.01              | 1e-6 to 0.5    | First shrink ratio `r`                                                  |
| `minShrinkRatio`    | 0.0002            | 1e-9 to 0.5    | Below it, polish and explore                                            |
| `maxShrinkRatio`    | 0.05              | 1e-6 to 0.5    | Cap on the growing ratio                                                |
| `strikes`           | 1 (3)             | 1 to 1000      | Strikes of a failing repair                                             |
| `patience`          | 2 (12)            | 1 to 10,000    | Iterations without 0.1% less overlap that end a strike of a compression |
| `explorePatience`   | 4 (24)            | 1 to 10,000    | The same for exploring and restart repairs                              |
| `globalSamples`     | 16 (48)           | 0 to 10,000    | Random poses per relocated piece                                        |
| `localSamples`      | 8 (24)            | 0 to 10,000    | Near poses per relocated piece                                          |
| `weightGrowth`      | 2                 | 1 to 100       | GLS multiplier of the deepest conflict                                  |
| `weightDecay`       | 0.95              | 0 to 1         | GLS decay of a former conflict                                          |
| `descentIterations` | 40                | 1 to 100,000   | L-BFGS iterations per relaxation                                        |
| `maxRuin`           | 0.5 (1)           | 0 to 1         | Largest ruined fraction of P                                            |
| `restartAfter`      | 40                | 0 to 100,000   | Failed explorations in a row before a restart; 0 never                  |
| `restartSlack`      | 0.02              | 0 to 1         | Restart size above the best                                             |
| `polish`            | true (new)        | true, false    | Squeeze the current packing at each basin floor                         |
| `refinementEvals`   | 3000 (new)        | 0 to 1,000,000 | Most evaluations of the final refinement's squeeze                      |
| `offerShare`        | 0.25 (new)        | 0 to 1         | Largest share of the evaluations used that offers may take              |

[CALC] How the defaults were chosen, on the reference kernel, on the first version (before the
offer policy and the new start; the reference kernel's finishing is cheap, so every
improvement was and is offered there). Each comparison changes one thing, with the seeds and
budgets given; the rest are the polygon's values.

- **Samples.** P = 13 to 28 (every other P above 20), seeds 1 to 3, 30,000 evaluations: 48/24
  samples gave mean ratio 1.00053, 24/12 1.00042, 16/8 1.00032. P = 5 to 20, 10,000
  evaluations: 42, 44 and 48 of 48 runs within 1%.
- **Patience.** With 16/8 samples: strikes, patience and exploration patience (2, 3, 6) gave
  mean 1.00032 and 1.00057 in the two sets above, (1, 3, 6) 1.00005 and 1.00044, (2, 2, 4)
  1.00002 and 1.00049, and (1, 2, 4) 1.00003 and 1.00004, with 48 of 48 within 1% at 10,000.
  Twenty relaxation iterations instead of 40 was worse (1.00059 and 1.00199).
- **Polish.** P = 5 to 12, seeds 1 to 5, 30,000: mean 1.00000 with the polish, 1.00008
  without. A tight polish (mu 1e4 to 1e9) at every floor cost too much search: P = 20 to 30
  (even P), seeds 1 to 4, 30,000 gave mean 1.00056 against 1.00010 with the default schedule.
  So the tight squeeze is done once, as the final refinement.
- **Offering failed repairs** (the finishing can legalise a near miss a little above its
  target). P = 9 to 20, seeds 1 to 8, 10,000 evaluations: 92 of 96 runs within 1% (mean
  1.00115) when every compression and exploration was offered, 95 of 96 (mean 1.00035) when
  only repaired ones were. So only repaired states are offered.
- `maxRuin` 1 was within seed noise of 0.5.
- `offerShare` 0.25 was set by reasoning, not tuned: with cheap finishings it never binds,
  and with a 4,000-evaluation offer it allows one offer per 16,000 evaluations used, besides
  the start and the end.

## Measurements

### The space kernels

[CALC] The setup and the table of [basin_hopping](basin_hopping.md#the-space-kernels): defaults,
no start, seeds 1 to 3, 20,000 evaluations, records from `data/<space>/records.json`. Every
result is valid, on all five problems. In the first version, shrink_repair returned nothing
on curved/-1/3/4/6 seed 2 (and on seeds 4 and 6 of 6), and 3.08 (1.285 times the record) on
every seed of boundary/tesseract/ball/13.

| Problem                    | Record (score_cert) | basin_hopping: seeds 1, 2, 3                               | shrink_repair: seeds 1, 2, 3                               |
| -------------------------- | ------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| sphere/0/13                | 2.005568            | 2.005568 (1.00000), 2.005568 (1.00000), 2.005568 (1.00000) | 2.005568 (1.00000), 2.005568 (1.00000), 2.005568 (1.00000) |
| torus/hex/5/8              | 4.416365            | 4.447300 (1.00700), 4.449288 (1.00745), 4.416389 (1.00001) | 4.447493 (1.00705), 4.447485 (1.00705), 4.442754 (1.00598) |
| curved/-1/3/4/6            | 2.843790            | 4.076095 (1.43333), 2.843790 (1.00000), 2.843790 (1.00000) | 3.771049 (1.32606), 2.843790 (1.00000), 2.843790 (1.00000) |
| polyhedra/tetintet/6       | 2.290995            | 2.290994 (1.00000), 2.291694 (1.00031), 2.290994 (1.00000) | 2.290994 (1.00000), 2.291005 (1.00000), 2.290994 (1.00000) |
| boundary/tesseract/ball/13 | 2.397495            | 2.409259 (1.00491), 2.402442 (1.00206), 2.532910 (1.05648) | 2.407408 (1.00413), 2.397830 (1.00014), 2.401765 (1.00178) |

[CALC] Over seeds 1 to 6 on curved/-1/3/4/6, 4 of 6 runs reach the record (seeds 1 and 4 end
at 1.326 and 1.473: squeezed random starts there reach the record about one time in eight).
On curved/1/4/4/5 and curved/-1/4/4/8 neither method finds a valid configuration (see
[basin_hopping](basin_hopping.md#the-space-kernels)).

[CALC] A dear finishing that fails on every other call (reference kernel, finishCost 2,000,
seeds 1 to 5, 40,000 evaluations): P = 10, 11 and 12 all reach the best known in 5 of 5 runs.
In the first version, P = 10 ended at 1.029 in 4 of 5. With finishCost 5,000 at P = 8
(a separate check), 3.304765, the best known, at 20,000 evaluations (4.031 before);
with a finishing that fails 9 calls in 10, 3.304765 (4.17 before).

### The reference kernel

[CALC] The setup of [basin_hopping](basin_hopping.md#the-reference-kernel): reference kernel,
defaults, no start, seeds 1 to 5, best known from `data/records.json`, every result valid at
tolerance 0. Node v26.5.0, Apple M1 Pro, load average near 150.

```sh
nice -n 10 npx tsx packages/methods/scripts/bench-shrink_repair.ts 2-30 5 30000
nice -n 10 npx tsx packages/methods/scripts/bench-shrink_repair.ts 2-30 5 10000
```

| P   | Best known | 10,000: mean | 10,000: worst | 30,000: mean | 30,000: worst | 30,000: best − known | Seconds per run (30,000) |
| --- | ---------- | ------------ | ------------- | ------------ | ------------- | -------------------- | ------------------------ |
| 2   | 2.000000   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | -2.2e-16             | 0.02                     |
| 3   | 2.154701   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 0.0e+0               | 0.01                     |
| 4   | 2.414214   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 0.0e+0               | 0.02                     |
| 5   | 2.701302   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 1.8e-15              | 0.03                     |
| 6   | 3.000000   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 5.5e-11              | 0.03                     |
| 7   | 3.000000   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 0.0e+0               | 0.04                     |
| 8   | 3.304765   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 1.3e-15              | 0.05                     |
| 9   | 3.613126   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 1.9e-14              | 0.06                     |
| 10  | 3.813026   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 8.9e-11              | 0.06                     |
| 11  | 3.923804   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 4.8e-11              | 0.08                     |
| 12  | 4.029602   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 1.7e-11              | 0.09                     |
| 13  | 4.236068   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 1.8e-14              | 0.10                     |
| 14  | 4.328429   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 6.9e-11              | 0.11                     |
| 15  | 4.521357   | 1.00078      | 1.00130       | 1.00026      | 1.00130       | 2.5e-11              | 0.12                     |
| 16  | 4.615426   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 7.0e-11              | 0.16                     |
| 17  | 4.792034   | 1.00040      | 1.00197       | 1.00000      | 1.00000       | 2.6e-11              | 0.16                     |
| 18  | 4.863703   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 1.9e-11              | 0.16                     |
| 19  | 4.863703   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 7.4e-12              | 0.18                     |
| 20  | 5.122321   | 1.00000      | 1.00000       | 1.00000      | 1.00000       | 5.0e-11              | 0.20                     |
| 21  | 5.252317   | 1.00190      | 1.00943       | 1.00000      | 1.00000       | 5.4e-11              | 0.21                     |
| 22  | 5.439719   | 1.00538      | 1.01090       | 1.00016      | 1.00016       | 8.9e-4               | 0.22                     |
| 23  | 5.545204   | 1.00168      | 1.00335       | 1.00002      | 1.00010       | 1.1e-10              | 0.25                     |
| 24  | 5.651661   | 1.00327      | 1.00383       | 1.00031      | 1.00143       | 1.5e-10              | 0.25                     |
| 25  | 5.752824   | 1.00269      | 1.01076       | 1.00000      | 1.00000       | 2.8e-9               | 0.28                     |
| 26  | 5.828177   | 1.00083      | 1.00307       | 1.00000      | 1.00000       | 1.6e-10              | 0.32                     |
| 27  | 5.906398   | 1.00023      | 1.00089       | 1.00000      | 1.00000       | 1.3e-5               | 0.37                     |
| 28  | 6.014938   | 1.01123      | 1.01521       | 1.00007      | 1.00023       | 3.4e-11              | 0.45                     |
| 29  | 6.138598   | 1.00093      | 1.00335       | 1.00005      | 1.00013       | 4.4e-10              | 0.40                     |
| 30  | 6.197741   | 1.00051      | 1.00254       | 1.00000      | 1.00000       | 3.6e-11              | 0.41                     |

[CALC] All 145 runs are within 1% of the best known at 30,000 evaluations (mean ratio 1.00003;
143 within 0.1%), and 140 at 10,000 (mean 1.00103). Seeds 1 to 20 at P = 2 to 10, 30,000
evaluations: 180 of 180 within 1%. The negative difference for P = 2 is float rounding in the
reference finishing, not a better packing. No result here is a record. P = 22 ends at 5.440613
in all five runs at 30,000 (best known 5.439719). P = 27 ends 1.3e-5 above the stated value,
as with basin_hopping.

[CALC] Tests: `packages/methods/test/shrink_repair.test.ts`. They cover:

- registration;
- within 1% of the best known for P = 2 to 10 at 30,000 evaluations (seed 1; seeds 1 to 20
  all pass);
- seeded reproducibility;
- the evaluation budget, from 1 to 5,000;
- a valid start never worsened, from both start modes;
- a loose start shrunk and a heap of disks repaired;
- refused parameters;
- the phases of a run: compression, polish, exploration with ruins of 1 to `maxRuin P`
  pieces, and restarts;
- acceptance of an offered state by its finished score (a finishing that adds 10%; acceptance
  by the repaired size fails it);
- a dear finishing that fails half the time: offers rationed, progress banked, the best known
  reached; a finishing that gives up on loose states; targets never below the lower bound;
- the repair phase on its own: it succeeds where a packing exists and fails below the optimum
  with raised weights;
- regions of consecutive disks in a row;
- the three ruin kinds, of which swap appears only with the capability.

## Limitations

- [CALC] torus/hex/5/8 ends 0.6% to 0.7% above the record on seeds 1 to 3, where
  basin_hopping reaches it on one seed.
- [CALC] Disks have no orientation, so the sawtooth that motivates the polygon method
  (squeezed square grids that need coordinated tilts) is not tested on the reference kernel.
- [SPEC] Without a rigid block turn, a tilt of a whole group of pieces must come from the
  repair itself, or from swaps where the kernel has them. That may make the square-like
  sawtooth harder in the spaces than for the polygon method.
- [CALC] The region probe shrinks the packing by 25%. In a sparse packing (rattlers, loose
  starts) a region may run out of neighbours and is then filled with random pieces.
- [CALC] A time-only run banks carried progress only through the offer share; a stop can lose
  what was carried since the last bank.

## References

[EST] Gardeyn, Vanden Berghe and Wauters (sparrow, arXiv:2509.13329), Egeblad, Nielsen and
Odgaard (2007) and Imamichi, Yagiura and Nagamochi (2009), as read and cited on the polygon
method's page ([shrink_repair.md](../shrink_repair.md#references)). The GLS multipliers 2.0,
1.2 and 0.95 are sparrow's; the rest is PolyPack's.
