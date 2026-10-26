# Monte Carlo compression (`mc_compress`) in every Dimension

**Board:** Monte Carlo compression. *Pieces jiggle at random, never overlapping, while the container keeps shrinking around them.*

This is the polygon method `mc_compress` (`docs/methods/mc_compress.md`), written once against the
kernel (`packages/methods/src/kernel.ts`), so it runs in every space. The code is
`packages/methods/src/methods/mc_compress.ts`; what it shares with `asc` is in `mc-chain.ts` next to it.

## How it works

[CALC] It is hard-particle Monte Carlo. The chain's state is always *hard*: every piece is clear at
tolerance 0 by the kernel's `clear()`. A trial that leaves a piece not clear is undone. Hardness is
the kernel's model, not validity. The method offers states, and the framework's `finish()` and
`validate()` decide what counts.

[CALC] One sweep is P single-piece trials. Each picks a random piece. With probability `jumpRate`
the piece is re-placed at a random pose (`randomPose`); otherwise it is moved by up to `moveStep`
of the kernel's steps in each of its variables (`jiggle`). The trial is kept when the piece is clear.

[CALC] Every `shrinkEvery` sweeps the chain tries to shrink by the fraction `shrinkFraction`, in up
to three trials, each kept when every piece is clear:

1. the arrangement with the container: `setSize(f size)`, which moves the centres in with the
   container while the pieces keep their size;
2. if that fails, the centres alone: `setSize`, then the old size at fixed variables;
3. then the container alone: the size times f at fixed variables.

[CALC] Trial 1 fails when a piece touches a wall, because the wall gap shrinks too. Trials 2 and 3
free such a piece; they are the kernel's form of the polygon method's centre contraction and
enclosure. They exist only in some spaces, so at the start of a run the method checks, on a
rebased copy of its state and with `toConfig` alone (no evaluations), whether trial 2 changes the
configuration and whether trial 3 differs from trial 1 (`sizeMoves` in `mc-chain.ts`):

| Kernels | A piece's variables | Trials 2 and 3 |
|---|---|---|
| reference disks, polyhedra, curved | centres about the container's centre (polyhedra), or anchors that `setSize` moves (curved) | moves of their own: used |
| torus, surface | offsets in a base frame that `setSize` scales by changing the size alone | trial 2 changes nothing, trial 3 is trial 1: left out |
| sphere, boundary | offsets from anchors that follow the size | on a rebased state the same as on the torus; between rebases they would only pull pieces towards their anchors: left out |

[CALC] An earlier version tried them everywhere. Measured on that version: on
`torus/free/3/6` all 3,489 centre trials changed nothing, at 17% of the budget; on `sphere/4/12`
and `boundary/tesseract/ball/9` the two trials took 13–17% of it.

[CALC] When the kernel has globals (a free torus cell's shape), every `globalEvery` sweeps one
random global moves by up to `globalStep` of its `globalSteps` entry, kept when every piece is
clear. One global at a time: at a jammed cell most joint moves are blocked. On a square torus
lattice, for example, any change of the aspect shortens a lattice vector, while the shear is free.

[CALC] Three step sizes adapt, each to its own acceptance rate: the jiggle, the shrink fraction and
the globals step. Every `adaptationSweeps` sweeps each is multiplied by
`exp(adaptationGain * (rate - targetAcceptance))` and kept between 1e-7 and its cap (4 steps,
0.05, 1 globalStep). A shrink counts as accepted only when the size fell, so the centre trial
alone does not count. Steps reset at each restart.

[CALC] The energy is the size, as in the polygon method. At temperature 0 no kept trial raises the
size. With `initialTemperature` T > 0, one shrink interval in ten also tries the container one
fraction larger: alone where the space has that move, else with the arrangement. That trial is kept with probability exp(-increase / T). T is multiplied by
`coolingRate` after every sweep. This is an optimisation heuristic, not a sampler with detailed
balance.

[CALC] Progress is a fall of the chain's size by more than 1e-6 of itself since the last mark, or
an improvement of the run's best by more than 1e-9 of itself. After `stagnationSweeps` sweeps
without progress, the chain restarts. It grows the arrangement with the container by
`restartExpansion` (`setSize`), runs `warmupSweeps` sweeps without shrinking, and starts its steps
and temperature again. After `maxRestarts` restarts the method returns.

## Starts and offers

[CALC] A start the run was given is used as given when it is hard. It is then contracted as a whole:
bisection on the factor of `setSize`, then, where the space has them, of the centres alone and of
the container alone, each as far as every piece stays clear. That keeps a loose start's contact
pattern. The contracted state is offered. Then the container grows by `initialExpansion`, alone where the space has that move
(room for the pieces at the walls, the contacts kept), else with the arrangement. The
`warmupSweeps` sweeps that follow do not shrink.

[CALC] A start that is not hard is relaxed at its size (`relax` from `local.ts`). It is then grown
with `setSize` in steps of 1e-9, 1e-8, ... up to 25%, until it is hard. If that fails, or without a
start, the kernel's random starts are treated the same way. Such a state is offered at once.

[CALC] An offer costs `finishCost`, and `validateCost` more when it improves the best. The chain
offers its state at the end of a sweep when a kept trial changed it since the last offer, and:

- the chain has spent (1 - `offerShare`) / `offerShare` times what the last offer cost since that
  offer ended, so that offers take `offerShare` of the evaluations (default 20%); or
- the budget left is below a finish, a validation and two of the costliest sweeps seen. The
  framework refuses an offer that no longer fits, which ends the run, so this is the last offer
  that surely fits, made in time. It carries the chain's state at the end of the run.

[CALC] It also offers when it stagnates. A copy is offered, so a kernel whose `finish()` works in
place cannot disturb the chain. On top of `offerShare` come the offer of a generated start and the
last offers. With a dear finish and a small budget those dominate: on
`boundary/tesseract/ball/9` an offer and its validation cost 4,000 evaluations, so at 20,000 the
offers take half of the budget.

## Costs

[CALC] With the counted kernel, a single-piece trial is one `clear()`, 1/P of an evaluation, so a
sweep costs one evaluation. A collective trial (a shrink, an expansion, a globals move, a restart,
the check after a rebase) checks every piece, at most one evaluation. It stops at the first piece
that is not clear, starting from the piece that blocked the previous one; a jammed packing tends
to repeat its blocker. A sweep costs at most six evaluations: the single-piece trials, three
shrinks, an expansion and a globals move, with a rebase check every `adaptationSweeps` sweeps.

[CALC] Undoing a jiggle writes back the piece's `dim` numbers. Every other trial works on a clone,
a random re-placement included: the polyhedra and boundary kernels' `randomPose` sets a new anchor
in `aux`, which writing the variables back would not undo. A version that relied on writing them
back corrupted its chain on those two kernels.

## What changed from the polygon method

[CALC] Kept: single-piece hard-particle trials, the adaptive jiggle and shrink steps with one target,
the shrink interval, the free-room sweeps, the size energy with optional annealing, stagnation and
expansion restarts, and the initial contraction of a given start.

[CALC] Changed:

- The jiggle moves every variable of a piece at once, by the kernel's `jiggle`. The polygon method
  chose a translation or a rotation and adapted them apart. A kernel does not say which variables
  are positions, so there is one jiggle step.
- Random re-placements (`jumpRate`) are new. They can fill a hole that local moves cannot reach
  [SPEC]; on the small test problems their effect stayed within the spread between seeds [CALC].
- Contraction and enclosure are `setSize`, the centres alone and the container alone, the last two
  only where the space has them (see above). The kernel has no enclosure, so there is no exact
  re-centring to the tightest container. The adaptive fraction finds the walls instead.
- Container orientation trials became globals moves. A kernel has no container angle; its globals
  are the variables of the whole packing.
- Stagnation counts sweeps, not assessments, since offers are spaced by budget. Restarts are on by
  default (`maxRestarts` 20; the polygon default is 0). Without them the chain ends at its first
  jam; with them it spends the budget on new chains.
- Offers replace the polygon method's assessments, and there is no appended polish. The kernel's
  `finish()` is the space's exact finishing.

[CALC] Dropped as 2D-only: the cell grid of piece centres (the kernel's `clear()` does the
neighbour search), the strict-enclosure margin and the container-angle period, and the seed
sub-run. A method here cannot call another method, so a start that is not hard is relaxed instead
of seeded.

## Parameters

[CALC] The schema is an object with `additionalProperties: false`. Every entry has a title, a
description, a default and an inclusive range.

| Parameter | Type, range | Default | Meaning |
|---|---|--:|---|
| `moveStep` | number, 1e-7–4 | 0.15 | Initial jiggle, in the kernel's steps (one step is about an inradius). |
| `jumpRate` | number, 0–1 | 0.02 | Share of single-piece trials that re-place the piece at random. |
| `shrinkFraction` | number, 1e-7–0.05 | 0.01 | Initial fractional size decrease of a shrink attempt. |
| `targetAcceptance` | number, 0.01–0.99 | 0.3 | Target of the jiggles, shrinks and globals moves, each measured apart. |
| `adaptationGain` | number, 0–10 | 1 | Steps multiply by exp(gain * (rate - target)); 0 keeps them fixed. |
| `adaptationSweeps` | integer, 1–10000 | 20 | Sweeps per acceptance measurement. |
| `shrinkEvery` | integer, 1–1000 | 2 | Shrink interval, in sweeps. |
| `globalEvery` | integer, 1–1000 | 10 | Globals move interval, in sweeps; ignored without globals. |
| `globalStep` | number, 1e-7–1 | 0.1 | Initial globals move, in the kernel's globalSteps. |
| `initialExpansion` | number, 0–1 | 0.05 | Room the container gets after a given start's contraction, alone where the space allows. |
| `warmupSweeps` | integer, 0–1000 | 5 | Sweeps without shrinks or globals moves, at the start and after a restart. |
| `stagnationSweeps` | integer, 0–1000000 | 2000 | Sweeps without progress before a restart or the return; 0 never. |
| `maxRestarts` | integer, 0–10000 | 20 | Restarts after stagnation. |
| `restartExpansion` | number, 1–2 | 1.15 | A restart grows the arrangement with the container by this factor. |
| `initialTemperature` | number, 0–100 | 0 | Size-energy temperature, in score units; 0 is greedy. |
| `coolingRate` | number, 0–1 | 0.9995 | Temperature multiplier per sweep. |
| `offerShare` | number, 0.01–0.9 | 0.2 | Share of the evaluations spent on offers; the start's offer and the last ones come on top. |

## Measured results

[CALC] Two test kernels, default parameters, no start, seeds 1–20, evaluation budgets only:

- the reference kernel, P unit disks in a circle (`packages/methods/src/reference/disks.ts`),
  against its `DISKS_IN_CIRCLE_BEST`;
- the free-torus test kernel, P unit disks on a flat torus with a free cell
  (`packages/methods/test/mc-torus-kernel.ts`), against the hexagonal bound, which P copies of the
  hexagonal lattice attain. It has the torus space's design: offsets from a base packing, a
  `setSize` that changes the size alone, a real `rebase`, finishCost 50 and validateCost 10.

[CALC] Excess is score / best - 1. Node v26.5.0 on arm64, on a shared, loaded machine. Runs took
0.01–0.4 s each at 30000 evaluations. Node v24.22.1 gave the same scores for the seeds checked
(1–3; disks P = 5, 9, 10; torus P = 2). Repeat with:

```sh
nice -n 10 npx tsx packages/methods/scripts/bench-mc_compress.ts --P 2-10 --seeds 20 --evals 30000 --torus 1-4
nice -n 10 npx tsx packages/methods/scripts/bench-mc_compress.ts --P 2-10 --seeds 20 --evals 3000 --torus 1-4
nice -n 10 npx tsx packages/methods/scripts/bench-mc_compress.ts --P 2-10 --seeds 20 --torus 1-4 --params '{"maxRestarts":0}'
```

| Problem | Best known | 30000: median excess | within 1e-3 | worst | 3000: median excess | within 1e-3 | no restarts, 30000: within 1e-3 | median evals |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| disks, P=2 | 2 | 9.1e-7 | 20/20 | 2.000041 | 1.9e-5 | 20/20 | 20/20 | 5784 |
| disks, P=3 | 2.154701 | 3.8e-9 | 20/20 | 2.154701 | 1.7e-8 | 20/20 | 20/20 | 7931 |
| disks, P=4 | 2.414214 | 1.4e-8 | 20/20 | 2.414214 | 3.9e-8 | 20/20 | 20/20 | 7835 |
| disks, P=5 | 2.701302 | 2.6e-8 | 20/20 | 2.701302 | 8.6e-8 | 16/20 | 18/20 | 9289 |
| disks, P=6 | 3 | 1.4e-8 | 20/20 | 3.000000 | 2.5e-7 | 20/20 | 20/20 | 8913 |
| disks, P=7 | 3 | 5.6e-8 | 20/20 | 3.000000 | 6.2e-7 | 20/20 | 20/20 | 9012 |
| disks, P=8 | 3.304765 | 6.3e-8 | 20/20 | 3.304765 | 2.5e-5 | 19/20 | 20/20 | 9684 |
| disks, P=9 | 3.613126 | 8.7e-8 | 20/20 | 3.613330 | 1.0e-2 | 9/20 | 13/20 | 11764 |
| disks, P=10 | 3.813026 | 2.5e-3 | 7/20 | 3.862720 | 3.5e-3 | 3/20 | 5/20 | 29998 |
| torus, P=1 | 1.861210 | 7.0e-9 | 19/20 | 1.864009 | 4.4e-4 | 13/20 | 19/20 | 15267 |
| torus, P=2 | 2.632148 | 5.1e-3 | 9/20 | 2.721098 | 8.0e-3 | 7/20 | 9/20 | 24171 |
| torus, P=3 | 3.223710 | 1.6e-1 | 0/20 | 3.814558 | 1.6e-1 | 0/20 | 0/20 | 29994 |
| torus, P=4 | 3.722419 | 2.9e-2 | 5/20 | 4.074334 | 2.9e-2 | 4/20 | 5/20 | 29986 |

[CALC] What the numbers say:

- Where the chain finds the right arrangement it ends within about 1e-7, the precision its
  adaptive steps reach. The reference kernel's `finish()` only rescales, so nothing polishes it
  further. A space whose `finish()` polishes closes that gap (curved, below).
- Two disks jam off the diameter: both touch the wall and each other, which no shrinking
  single-piece step undoes. Restarts improve the median from 1.9e-5 to 9.1e-7.
- Five disks can cage one disk in a ring of four (R = 3), and nine disks jam at 3.650115. Restarts
  lift P = 9 from 13 to 20 of 20 runs within 1e-3.
- Ten disks reach the optimum's neighbourhood in 7 of 20 runs.
- On the free torus the globals moves take one disk to the hexagonal lattice in 19 of 20 runs and
  two disks in 9. Three and four disks jam in looser cells (P = 3 at 3.41–3.81 against 3.2237).
  The test kernel is not at fault: `squeeze` from `local.ts` reached the optimum within 1e-6 from
  20 of 20 random starts for P = 3 and for P = 4. Hard-particle moves cannot leave these jams.

### The space kernels

[CALC] The kernels of `sphere`, `torus`, `curved`, `polyhedra` and `boundary`, built by their
factories (README), seeds 1–3, default parameters, no start, 20000 evaluations. Record is the
space's `score_cert` in `data/<space>/records.json`; excess is score / record - 1. The offer share
counts every finish and validation at the kernel's costs. All 18 results are valid by the server's
rule.

| Problem | Record | Seed 1 | Seed 2 | Seed 3 | Evaluations | Offer share | finishCost + validateCost |
|---|--:|--:|--:|--:|--:|--:|--:|
| `sphere/4/12` | 1.111808 | +1.0e-2 | +1.3e-2 | +4.5e-4 | 19795–19996 | 0.23–0.25 | 500 + 200 |
| `torus/free/3/6` | 1.611855 | +1.4e-1 | +5.2e-3 | +1.5e-1 | 19955–19994 | 0.20 | 50 + 10 |
| `torus/free/0/5` | 4.161791 | +1.2e-1 | +1.2e-1 | +1.1e-1 | 19984–19994 | 0.20 | 50 + 10 |
| `curved/-1/0/0/5` | 2.443354 | record | record | record | 19993–20000 | 0.23–0.24 | 300 + 3 |
| `polyhedra/cubincub/9` | 2.707107 | +1.1e-1 | +3.2e-2 | +2.3e-2 | 19219–19994 | 0.27–0.28 | 775 + 775 |
| `boundary/tesseract/ball/9` | 2.220596 | +1.9e-2 | +1.6e-2 | +1.7e-2 | 17995–19996 | 0.40–0.56 | 2000 + 2000 |

[CALC] "record" means the score equals the record's to 1e-10; no record or improvement is claimed.
A run ends at the budget or where the framework refuses an offer that no longer fits, so
evaluations end up to a finish and a validation short of 20000. The offer share is 0.20 on the
torus and rises with the cost of an offer against the budget, as described under "Starts and
offers". The space packages depend on the methods package, not the other way round, so this
table has no script in `packages/methods`; it is `runMethod` with each factory.

[CALC] No record or benchmark improvement is claimed. The disk and test-torus problems are small
reference problems with known optima.

## Limitations

- [CALC] Hard-particle compression jams. The method finds the optimum when the jam it reaches is the
  optimum's, and restarts only try again. It has no swaps and no continuous optimisation.
- [CALC] The jiggle has one step for all of a piece's variables. Where positions and turns need
  very different steps, the kernel's `steps` must balance them.
- [CALC] A jiggle is undone by writing back the piece's variables. That relies on the rule that a
  `jiggle` changes only piece i's `dim` numbers (kernel.ts), which the space kernels keep. Their
  `randomPose` does not always keep it (polyhedra and boundary set a new anchor), so a random
  re-placement works on a clone.
- [SPEC] In spaces with very local charts (a polytope's boundary), the chain calls `rebase` every
  `adaptationSweeps` sweeps. Between those calls a piece's chart offset grows with its moves. How
  far a kernel's charts stay accurate is the kernel's matter.

## References

- [EST] N. Metropolis, A. W. Rosenbluth, M. N. Rosenbluth, A. H. Teller and E. Teller, **Equation of
  State Calculations by Fast Computing Machines**, *J. Chem. Phys.* **21**, 1087–1092 (1953),
  [DOI 10.1063/1.1699114](https://doi.org/10.1063/1.1699114): rigid-disk Monte Carlo that rejects
  overlapping trials. Verified for the polygon method's page.
- [EST] S. Kirkpatrick, C. D. Gelatt and M. P. Vecchi, **Optimization by Simulated Annealing**,
  *Science* **220**, 671–680 (1983), [DOI 10.1126/science.220.4598.671](https://doi.org/10.1126/science.220.4598.671):
  annealing background, not this cooling rate. Verified for the polygon method's page.
- [EST] J. A. Anderson, M. E. Irrgang and S. C. Glotzer, **Scalable Metropolis Monte Carlo for
  simulation of hard shapes**, *Comput. Phys. Commun.* **204**, 21–30 (2016),
  [DOI 10.1016/j.cpc.2016.02.024](https://doi.org/10.1016/j.cpc.2016.02.024): hard-shape Monte
  Carlo with box moves. Verified for the polygon method's page.
