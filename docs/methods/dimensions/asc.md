# Adaptive shrinking container (`asc`) in every Dimension

**Board:** Adaptive shrinking container. *Pieces jiggle without overlapping while the whole container drifts, changes shape and shrinks around them.*

This is the polygon method `asc` (`docs/methods/asc.md`), after Torquato and Jiao's adaptive
shrinking cell, written once against the kernel (`packages/methods/src/kernel.ts`), so it runs in
every space. The code is `packages/methods/src/methods/asc.ts`; what it shares with `mc_compress`
is in `mc-chain.ts` next to it.

## How it works

[CALC] It is hard-particle Monte Carlo in which the container moves too. The chain's state is always
*hard*: every piece is clear at tolerance 0 by the kernel's `clear()`, and a trial that leaves a
piece not clear is undone. The method offers states; the framework's `finish()` and `validate()`
decide what counts. Starts, offers and costs are those of `mc_compress`
([mc_compress.md](mc_compress.md), "Starts and offers" and "Costs").

[CALC] One sweep is P single-piece trials (a `jiggle`, or with probability `jumpRate` a
`randomPose`), then one trial of each container and collective move. Which size moves a space has
is checked once per run, on a rebased copy of the state and with `toConfig` alone (`sizeMoves` in
`mc-chain.ts`; see [mc_compress.md](mc_compress.md), "How it works"): the reference disks,
polyhedra and curved kernels move the centres and the container apart, while in the torus,
surface, sphere and boundary kernels `setSize` is the only size move.

| Move | Kernel trial | In a container (reference disks, polyhedra, curved) | In the torus, surface, sphere and boundary kernels |
|---|---|---|---|
| drift | every piece moved by the same chart offset, uniform up to `driftStep` steps per variable | the container's translation relative to the pieces (the polygon method's container translation; in curved space only near one), for polyhedra with every piece turned by the same small rotation | torus: every centre translated, a symmetry, and every polygon turned by the same angle, which is not. Sphere: right after a rebase a rigid rotation of everything, a symmetry, and close to one between rebases. Surface and boundary: the same offset in each piece's own chart, a coherent collective move |
| strain | one random global moved uniformly by up to `strainStep` of its globalSteps, the size fixed | none: no globals | free torus: the cell's shape (t1, t2) changes and the packing deforms with it, the shape part of Torquato and Jiao's cell strain; none elsewhere |
| scale | the container alone shrinks by a, or with T > 0 one trial in five grows by a; a between half and all of `scaleStep` | the walls alone | `setSize`: the cell or surface with the packing, the volume part of the cell strain |
| radial | `setSize` by (1 - `radialStep`) | centres and walls in together (a homothety) | left out: it would be the scale |
| centres | `setSize`, then the old size at fixed variables, by (1 - `centresStep`) | the centres in, the walls staying; with the scale after it, the polygon method's radial strain | left out: it changes nothing on a rebased state |

[CALC] The amplitudes are used as the polygon method uses them: the scale between half and all of
its step, the container translation and rotation (here drift and strain) uniform up to theirs, the
radial strain (and the centre move) at its step. A trial is kept when every piece is clear and its
size passes the Metropolis rule: a smaller or equal size always, a larger one with probability
exp(-increase / T). T is `temperature` in score units, multiplied by `coolingRate` after every
sweep.

[CALC] Each move has its own step, adapted every `adaptationSweeps` sweeps by
`exp(adaptationGain * (rate - targetAcceptance))` between 1e-7 and its cap (4 steps for jiggle and
drift, 1 globalStep for strain, 0.3 for the fractions).

[CALC] A start used as given first gets `radialWarmup` compressions of the whole (radial, or the
scale where that is `setSize`) and centre moves, adapting after each. This compresses a loose
start without changing its contact pattern. A random start skips the warmup: it has no pattern to
keep, and compressing it as a whole tends to cage a piece. With the warmup on random starts, three
or more of six runs of five disks ended with one disk ringed by four (R = 3 against 2.7013);
without it none did.

[CALC] Progress is a fall of the chain's size by more than 1e-6 of itself since the last mark, or
an improvement of the run's best by more than 1e-9 of itself. After `stagnationSweeps` sweeps
without progress the method offers its state and returns, as the polygon method does. It does not
restart.

## Periodic cells and the globals

[EST] Torquato and Jiao's adaptive shrinking cell packs pieces in a periodic cell whose lattice
vectors are variables. Their Monte Carlo moves are rigid particle moves and cell strains, with
particle centres following the cell, and compressions are favoured (Phys. Rev. E 80, 041104,
Section II, as read for the polygon method's page).

[CALC] With the kernel, a cell strain splits in two:

- **Volume.** `setSize` changes the score with the normalized arrangement kept, so the centres follow
  the cell. In the torus kernel it changes the size alone: centres and cell live in a base frame
  that the size scales. This is the scale move there.
- **Shape.** The kernel's globals are the variables of the whole packing. In the torus kernel's
  free family they are t1 and t2 of the map F = [[e^t1, t2], [0, e^-t1]] (determinant 1) from the
  base frame to the plane, so a move of one global at a fixed size is a volume-preserving strain of
  cell and centres together. This is the strain move. `rebase` folds the strain into the base.

[CALC] Whether the centres follow a change of the globals is the kernel's choice of variables;
in the torus kernel they do. The free-torus test kernel (`packages/methods/test/mc-torus-kernel.ts`)
copies that design. An earlier test kernel kept Cartesian centres, so a globals move shifted only
the images: two disks then stayed in a square-type cell (2.83 against 2.63).

[CALC] The strain moves one global at a time. At a jammed square cell any change of the aspect
shortens a lattice vector, so a joint move of aspect and shear is almost always blocked, and its
step adapted down to the floor. With one global at a time the shear moves freely, and the aspect
follows. On the real torus kernel the strain took asc within 4.5e-8 of the density bound on
`torus/free/0/5` (below).

## What changed from the polygon method

[CALC] Kept: rigid single-piece trials, a translation of the container relative to the pieces, the
container scale with Metropolis expansions, the isotropic (radial) strain, separate step
adaptation per move with one target, the radial warmup of a start used as given, the size energy
with temperature and cooling, and the return at stagnation.

[CALC] Changed:

- The jiggle moves every variable of a piece at once, with one adapted step. The polygon method
  adapted translations and rotations apart; a kernel does not say which variables are positions.
- Random re-placements (`jumpRate`) are new.
- The container translation is a drift of every piece by the same chart offset. In a flat container
  that is the same move. Where the charts are local (a sphere, a polytope's boundary) the same offset
  in each piece's chart is a coherent collective move, not a rigid motion.
- The polygon method's radial strain moved the centres in and the walls by a smaller amount, chosen
  from the piece's bounding radius so that pieces at a wall stay inside. A kernel states the piece's
  inradius, but not the gap a piece of some shape and turn needs at a wall of the space. So, where
  the space has the moves, there are two: radial (`setSize`, walls with the centres) and centres
  (the centres alone), and the scale move brings the walls after them. Elsewhere `setSize` is the
  only size move, and it is the scale.
- The radial warmup is skipped for random starts (above).
- The container rotation became the strain on the globals.

[CALC] Dropped as 2D-only:

- The balanced (area-preserving), uniaxial and sector strains of the centres need one Cartesian
  frame for all centres: an axis u, the perpendicular v, a half-plane. Kernel charts are per piece,
  so these maps have no generic form. In the polygon method's ablation they did not show a benefit:
  the radial strain took 95% of the observed score drops, and removing all collective moves (these
  three and the radial) raised the near-record count from 88 to 102 of 240 runs
  (`docs/methods/asc.md`).
- The container angle and its symmetry period, the strict-enclosure margin, the cell grid and
  the seed sub-run, as in `mc_compress`.
- The parting of starts that are valid only within the validator's tolerance. Here such a start is
  not hard, so it is relaxed and grown by 1e-9 steps until it is.
- Configuration keys against repeated assessments. Here an offer needs a kept trial since the last
  one.

## Parameters

[CALC] The schema is an object with `additionalProperties: false`; every entry has a title, a
description and a default.

| Parameter | Type, range | Default | Meaning |
|---|---|--:|---|
| `moveStep` | number, 1e-7–4 | 0.15 | Initial jiggle, in the kernel's steps. |
| `jumpRate` | number, 0–1 | 0.02 | Share of single-piece trials that re-place the piece at random. |
| `driftStep` | number, 1e-7–4 | 0.05 | Initial collective translation, in steps. |
| `strainStep` | number, 1e-7–1 | 0.05 | Initial globals strain, in globalSteps; ignored without globals. |
| `radialStep` | number, 1e-7–0.3 | 0.03 | Initial fraction of the radial move (`setSize`), where the container also moves alone. |
| `centresStep` | number, 1e-7–0.3 | 0.03 | Initial fraction of the centre contraction, where the space has it. |
| `scaleStep` | number, 1e-7–0.3 | 0.01 | Initial fraction of the scale: the container alone, else `setSize`. |
| `targetAcceptance` | number, 0.01–0.99 | 0.3 | Target of every move, each measured apart. |
| `adaptationGain` | number, 0–10 | 1 | Steps multiply by exp(gain * (rate - target)); 0 keeps them fixed. |
| `adaptationSweeps` | integer, 1–10000 | 20 | Sweeps between step updates. |
| `stagnationSweeps` | integer, 1–1000000 | 2000 | Sweeps without progress before the method returns. |
| `radialWarmup` | integer, 0–256 | 64 | Compressions of the whole and centre moves before the first sweep, for a start used as given. |
| `temperature` | number, 0–100 | 0 | Size-energy temperature, in score units; 0 forbids expansions. |
| `coolingRate` | number, 0–1 | 0.9995 | Temperature multiplier per sweep. |
| `containerMoves` | boolean | true | Drift and strain; the scale stays on. |
| `collectiveMoves` | boolean | true | Radial, centres and the radial warmup. |
| `offerShare` | number, 0.01–0.9 | 0.2 | Share of the evaluations spent on offers; the start's offer and the last ones come on top. |

## Measured results

[CALC] The same kernels and protocol as `mc_compress` ([mc_compress.md](mc_compress.md), "Measured
results"): seeds 1–20, default parameters, no start, evaluation budgets only, Node v26.5.0 on a
shared, loaded machine, 0.01–0.45 s per run. Node v24.22.1 gave the same scores for the seeds
checked (1–3; disks P = 5, 9, 10; torus P = 2). Repeat with:

```sh
nice -n 10 npx tsx packages/methods/scripts/bench-asc.ts --P 2-10 --seeds 20 --evals 30000 --torus 1-4
nice -n 10 npx tsx packages/methods/scripts/bench-asc.ts --P 2-10 --seeds 20 --evals 3000 --torus 1-4
nice -n 10 npx tsx packages/methods/scripts/bench-asc.ts --P 2-10 --seeds 20 --torus 1-4 --params '{"containerMoves":false}'
nice -n 10 npx tsx packages/methods/scripts/bench-asc.ts --P 2-10 --seeds 20 --torus 1-4 --params '{"collectiveMoves":false}'
nice -n 10 npx tsx packages/methods/scripts/bench-asc.ts --P 2-10 --seeds 20 --torus 1-4 --params '{"temperature":0.02}'
```

The last four columns count runs within 1e-3 of the best known, out of 20, at 30000 evaluations
unless marked.

| Problem | Best known | 30000: median excess | within 1e-3 | worst | median evals | 3000: within 1e-3 | no container moves | no collective moves | T = 0.02 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| disks, P=2 | 2 | 3.5e-5 | 20 | 2.000672 | 10435 | 20 | 20 | 20 | 20 |
| disks, P=3 | 2.154701 | 3.7e-9 | 20 | 2.154701 | 12962 | 20 | 20 | 20 | 20 |
| disks, P=4 | 2.414214 | 9.4e-9 | 20 | 2.414214 | 15612 | 20 | 20 | 20 | 20 |
| disks, P=5 | 2.701302 | 2.2e-8 | 13 | 3.000000 | 13058 | 10 | 17 | 16 | 17 |
| disks, P=6 | 3 | 1.3e-8 | 20 | 3.000000 | 12030 | 20 | 20 | 20 | 20 |
| disks, P=7 | 3 | 4.6e-8 | 20 | 3.000000 | 12471 | 20 | 20 | 20 | 20 |
| disks, P=8 | 3.304765 | 4.6e-8 | 20 | 3.304765 | 16372 | 19 | 20 | 20 | 20 |
| disks, P=9 | 3.613126 | 1.0e-2 | 6 | 3.720659 | 29999 | 4 | 11 | 5 | 9 |
| disks, P=10 | 3.813026 | 4.0e-3 | 5 | 3.872880 | 29999 | 3 | 3 | 2 | 13 |
| torus, P=1 | 1.861210 | 2.2e-9 | 20 | 1.861210 | 19304 | 20 | 0 | 20 | 20 |
| torus, P=2 | 2.632148 | 1.9e-8 | 17 | 2.720630 | 20274 | 17 | 0 | 17 | 20 |
| torus, P=3 | 3.223710 | 1.5e-1 | 4 | 3.826549 | 29989 | 3 | 0 | 4 | 20 |
| torus, P=4 | 3.722419 | 3.1e-2 | 2 | 3.896346 | 29994 | 2 | 0 | 2 | 19 |

[CALC] What the numbers say:

- The strain on the globals is what packs the torus. Without the container moves one disk stays in
  its square cell (2 against 1.8612) and two disks end at up to 2.92 against 2.63, in every run.
  With them one disk reaches the hexagonal packing in every run and two disks in 17 of 20, also at
  3000 evaluations; `mc_compress`, whose globals move comes every tenth sweep, gets 13 and 7 there.
- On the disks the drift does not help: without the container moves nine disks reach the optimum
  in 11 runs instead of 6, and five disks in 17 instead of 13.
- The collective moves (radial and centres) show no clear effect on random starts: 16, 5 and 2
  runs for five, nine and ten disks without them, against 13, 6 and 5 with. On the torus they do
  not exist, so those rows are the defaults'. They stay on, as in the polygon method; they are meant
  for compressing a loose start as a whole.
- A temperature of 0.02 trades precision for finding the right arrangement. Ten disks reach the
  optimum in 13 runs instead of 5, and three and four disks on the torus in 20 and 19 instead of 4
  and 2. But P = 2 to 8 end with a median excess of 3e-7 to 5e-5 instead of about 1e-8, since the
  container still breathes when the budget ends.
- Against `mc_compress` on the disks: as close for P = 3 to 8, worse for P = 9 (6 against 20 of
  20), and it cages five disks more often (7 against 0 of 20). ASC returns at stagnation, after a
  median of 10000 to 16000 evaluations; `mc_compress` restarts. On the torus it does better (two
  disks: 17 against 9).
- Three and four disks on the free torus jam in looser cells at temperature 0, as with
  `mc_compress`; `squeeze` reaches the optimum there from every random start tried.

### The space kernels

[CALC] As for `mc_compress` ([mc_compress.md](mc_compress.md), "The space kernels"): seeds 1–3,
default parameters, no start, 20000 evaluations, excess against the space's `score_cert`. All 18
results are valid by the server's rule.

| Problem | Record | Seed 1 | Seed 2 | Seed 3 | Evaluations | Offer share |
|---|--:|--:|--:|--:|--:|--:|
| `sphere/4/12` | 1.111808 | +2.3e-3 | +1.4e-2 | +1.6e-2 | 19994–19996 | 0.25 |
| `torus/free/3/6` | 1.611855 | +1.6e-1 | +1.3e-2 | +1.5e-1 | 19950–19985 | 0.20 |
| `torus/free/0/5` | 4.161791 | +4.5e-8 | +1.1e-1 | +1.0e-1 | 19984–19992 | 0.20 |
| `curved/-1/0/0/5` | 2.443354 | record | record | record | 8730–9139 (stagnation) | 0.23–0.24 |
| `polyhedra/cubincub/9` | 2.707107 | +1.1e-1 | −5.2e-8 | +7.0e-2 | 19216–19994 | 0.24–0.31 |
| `boundary/tesseract/ball/9` | 2.220596 | +1.6e-2 | +1.7e-2 | +2.0e-2 | 18066 (stagnation)–19995 | 0.40–0.44 |

[CALC] Seed 1 on `torus/free/0/5` came within 4.5e-8 of the record, which attains the density
bound, through the strain of the free cell. Seed 2 on `polyhedra/cubincub/9` ended at 2.70710678129, 1.0e-10 above
2 + 1/sqrt 2 and 1.4e-7 below the record's float score (2.70710692261). It is not certified, and
no improvement is claimed. "record" means within 1e-10 of it.

[CALC] No record or benchmark improvement is claimed.

## Limitations

- [CALC] It returns at its first lasting jam, as the polygon method does. Use `mc_compress` for
  restarts.
- [CALC] Its moves cost more evaluations per sweep than `mc_compress`'s: one for the single-piece
  trials and up to one for each collective trial, so at most five in a container (drift, radial,
  centres, scale) and four on a free torus (drift, strain, scale), with a rebase check every
  `adaptationSweeps` sweeps.
- [CALC] The strain is only as good as the kernel's globals. Where a globals change moves only the
  images, the pieces do not follow the cell (above).
- [CALC] On a torus the drift's translation is a symmetry, and on the sphere the whole drift is one
  right after a rebase. Only its turn of polygons does anything there, at up to one evaluation a
  sweep.

## References

- [EST] S. Torquato and Y. Jiao, **Dense packings of the Platonic and Archimedean solids**,
  *Nature* **460**, 876–879 (2009), [DOI 10.1038/nature08239](https://www.nature.com/articles/nature08239).
  Verified for the polygon method's page.
- [EST] S. Torquato and Y. Jiao, **Dense packings of polyhedra: Platonic and Archimedean solids**,
  *Phys. Rev. E* **80**, 041104 (2009), [DOI 10.1103/PhysRevE.80.041104](https://journals.aps.org/pre/abstract/10.1103/PhysRevE.80.041104),
  [arXiv:0909.0940](https://arxiv.org/pdf/0909.0940), Section II: particle moves, cell strain and
  expansion acceptance. Verified for the polygon method's page.
