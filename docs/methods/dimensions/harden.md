# Soft-to-rigid hardening (`harden`), in every Dimension

[CALC] `harden` runs soft-to-rigid hardening, after Yohei Nakajima, on any
kernel with the capability `shape` (`packages/methods/src/methods/harden.ts`).
Each run starts every piece as its inscribed disk or ball at a roomy size,
compresses the pieces under inward pressure, hardens them step by step into
the true shapes while the container keeps pushing, and settles with the true
shape. Only true-shape states are offered; a soft state is never offered. The
framework finishes each offer with the space's exact finishing and keeps the
best of independent seeded runs.

Board title: "Soft-to-rigid hardening". Summary: "Squeezes the pieces
together as soft round blobs, then hardens them bit by bit into their real
shapes while the walls keep pressing in."

The polygon method is described in [`docs/methods/harden.md`](../harden.md).
This page covers the generic port and what differs from it.

## Acknowledgement

Soft-to-rigid hardening is the work of **Yohei Nakajima**. The idea, the
three-phase schedule, the energy, the momentum update, the default pressure,
noise, softness and step counts used here, the shape family of rounded
polygons (a polygon scaled about its centre and dilated by a disk) and all the
published findings quoted on this page are his. He published the method, the
paper, the code, the pre-registered experiments (including the ones that went
against the method) and replays of the runs openly under the MIT licence. This
implementation exists because of that openness. Thank you.

- Site: <https://yoheinakajima.github.io/soft-to-rigid/>
- Repository: <https://github.com/yoheinakajima/soft-to-rigid>
- Paper: Yohei Nakajima, _Soft-to-Rigid: Shape Continuation as an Alternative
  Search for Packing Congruent Shapes_,
  [paper/main.pdf](https://github.com/yoheinakajima/soft-to-rigid/blob/main/paper/main.pdf)
  in the repository ([web version](https://yoheinakajima.github.io/soft-to-rigid/paper.html)).

What is whose on this page:

| Part                                                                                                                                                                                  | Whose                                                    | Label                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| The method: paths, energy, momentum dynamics, three-phase schedule; the rounded-polygon family                                                                                        | Yohei Nakajima                                           | [EST], from the paper and `engine2d.js`                  |
| Default pressure, noise, softness and step counts                                                                                                                                     | Yohei Nakajima                                           | [EST], paper appendix and `methods/*.json`               |
| Reported results about where hardening helps and where it does not                                                                                                                    | Yohei Nakajima                                           | [EST], repository README and paper, see the polygon page |
| The polyhedra kernel's rounded solids (a solid scaled and dilated by a ball) and their energy                                                                                         | Yohei Nakajima and Alejandro Zarzuelo (platonic-packing) | [EST], see `docs/spaces/POLYHEDRA.md`                    |
| The other spaces' soft shapes: caps cut from the polygons on the sphere, polygons cut by a growing disk in curved space, chorded corners on the surface                               | PolyPack (each space's kernel)                           | [CALC]                                                   |
| Port to the generic kernel: units of the variables, of pressure and noise, the size in units of room, the size floor, the budget plan, the first offer, restarts, the closing squeeze | PolyPack                                                 | [CALC]                                                   |
| Every number measured in this repository (tables below)                                                                                                                               | PolyPack                                                 | [CALC]                                                   |

No result on this page is a packing record or a benchmark-improvement claim.

## The method on a kernel

[EST] The reference method is described on the polygon page, from the paper's
Method section and `engine/engine2d.js`, read on 2026-10-11.

[CALC] The port maps it onto the kernel (`packages/methods/src/kernel.ts`):

- **Shape family.** The kernel's `setShape(s, t)` gives the soft pieces, from
  the inscribed disk or ball at t = 0 to the true shape at t = 1, every one
  inside the true piece. Each space has its own family: rounded polygons (the
  reference's, softness tau = 1 - t) on the torus, and on the surface with
  their round corners replaced by chords, rounded solids for polyhedra, caps cut from the polygons on the sphere, polygons cut
  by a disk of growing radius in curved space; disks and balls are their own
  inscribed shape, so `setShape` changes nothing for them. `finish` and
  `validate` always use the true shape.
- **Paths.** `harden` (t rises from 1 - tau0 to 1 along the path phase),
  `rigid` (t = 1 throughout) and `snap` (t = 0 through compression and the first
  path step, then 1). The reference's `grow` and `grow-area` paths scale the
  pieces, which a kernel's soft shapes do not, so they are not ported.
- **Energy.** The kernel's penalty energy E (overlaps squared, at the current
  shape) plus an inward pressure mu on the size, the problem's score itself.
  The size moves as a free variable with the pieces' variables fixed, as in
  `squeeze`.
- **Dynamics** (`harden-dynamics.ts`). One step is one energy evaluation with
  its gradient (the kernel's `gradCost`), then the reference's update
  `v <- 0.85 v - 0.04 dE/dz` on every piece variable z and
  `v_L <- 0.85 v_L - 0.02 (mu + dE/dL)` on the size, in the units below, with
  capped steps and Gaussian noise.
- **Schedule.** Compression at pressure 3 mu with noise 0.015 nu falling to 0,
  at the path's starting shape; the path at pressure mu with noise
  0.004 nu (1 - u); settling at t = 1 without noise, pressure
  `mu * 10^(-4 s / n_S)`. Full-length run 2,500 + 7,500 + 1,500 steps.

**Units of the variables.** A kernel's variables need not be lengths: the
surface's (u, v) are coordinates on the unit solid, and the sphere's spin turns
a piece by x / rho. A kernel's `steps` say what moves a piece by about its
inradius (`kernel.inradius`, in the units of the size). So each variable x_j
is read as the length z_j = x_j inradius / steps_j, and the update in x is the
reference's scaled by (steps_j / inradius)^2. That is exactly the reference
for a variable that is a length with a step of one inradius, and the same
mobility in piece units for a turn. Noise is `2 * 0.015 nu` (then
`2 * 0.004 nu`) steps on every piece variable, that is 0.015 nu inscribed
diameters; a piece's whole move is capped at 0.03 sqrt(dim) steps.

**The size in units of room.** The reference moves the radius of a circle (a
unit of size moves the wall by a unit of length) or the side of a polygon (a
square's side moves its walls by half as much). In other spaces a unit of size
moves the contacts by very different lengths: the side of a hyperbolic square
buys ever less room (its inradius stays below asinh 1, about 0.88), and on a
closed surface the size spreads the pairs instead of moving walls. With the
reference's update on the raw size, curved/-1/3/4/6 pressed its pieces about
ten times too hard (overlaps of 75% of the inradius at the end of the path),
and when the pressure faded while settling the side ran away from 2.6 to 4.8.
So the dynamics measures the size's unit, the length by which a unit of size
moves the contacts: every 16 steps one more gradient at size L + h with the
pieces fixed. Only the size-dependent terms change between the two, so
d2E/dL2 = sum 2 (dd/dL)^2 and each piece's gradient changes by
sum 2 (dd/dL) grad d; their ratio is a mean of |dd/dL|. It is exactly 1 for
disks in a circle and 0.5 for a square's side (both tested); measured, about
0.5 for the cube container of polyhedra, 0.06 for the hyperbolic square at
side 3.6, about 0.5 on the torus near its optimum. The size then moves in room
a = unit * size: `v_a <- 0.85 v_a - 0.02 (mu + dE/dL / unit)`,
`L += v_a / unit`, with the step capped at 0.03 sqrt(2) inradii of room and at
2% of the size (the unit is measured a few steps behind and changes fast on a
closed surface).

**Pressure.** Stated per inscribed diameter and, as in the reference's main
container, per unit of a square's side, so twice that per unit of room:
mu = 2 * pressure * 2 * inradius. For the reference kernel (unit disks in a
circle, steps 1, inradius 1, unit 1) this is pressure 0.64 per unit of radius,
where the polygon port's circles have 0.32; the measurements below compare the
two.

**Charts.** The kernel's charts are folded into their anchors every 64 steps;
a piece moves by at most 0.03 sqrt(dim) inradii a step, so a chart's offset
stays within a few inradii, as in a local solve. A velocity is a direction in
its piece's chart, and the generic method cannot carry it into another chart
(another face, cell or anchor), so a piece whose variables rebase changes
starts again from rest; pieces it leaves alone keep their velocity.

**Floor and ceiling of the size.** The problem's lower bound holds for the
true shapes. Soft pieces pack below it (inscribed disks fill 60% of a
triangle, inscribed balls 30% of a tetrahedron), so the size is kept above
half of the bound. An earlier version kept it above the bound itself; on the
reference kernel that stopped compression at sqrt(P) and gave worse results at
P = 25 and 30. The size is also kept at most at the run's start size: by the
kernel's rule `randomStart` is roomy enough that a short relaxation separates
the pieces, and a supplied start has its own. Where the room saturates, a
jammed arrangement would otherwise push the size out without end, since a unit
of size buys ever less room (on curved/-1/3/4/6 from 3.9 to 11 while settling,
in units of room and with the 2% cap).

## Budget, offers and restarts

[CALC] The budget counts energy evaluations. A step costs the kernel's
`gradCost` (8 for the surface's polygons), a measurement of the size's unit one
more step every 16, an offer `finishCost + validateCost` (a finish, and the
validation of an improvement): from 1 + 1 for the reference kernel to 2,000 +
2,000 for the boundary's balls.

- **First offer.** Before any long work, when nothing valid is held, the
  method offers a state that the space's finishing can take: the supplied
  start, else one structured seed (`seeds`), else a random start relaxed apart
  at its roomy size (100 L-BFGS iterations). Raw random starts rarely finish:
  none of ten on the boundary's balls or the surface's squares. So a run that
  is stopped early returns this first offer, when the space's finishing
  accepts it (in every measured case below and in the tests); a stop before it
  returns nothing.
- **Offers inside a run** come only while settling, every `offerInterval`
  settling steps (default 1,000), and at the end. Earlier states are soft and
  overlap deeply, and their finish fails or is poor.
- **Closing squeeze** (`polish`, default on). After settling, the true-shape
  state is squeezed (`squeeze` with penalty weights 1e4, 1e5, 1e6, 100
  iterations each) and offered again. It is held to an allowance of 500
  gradients (`harden-offers.ts` withAllowance: past it the energy refuses and
  L-BFGS stops at its last accepted point), which the plan reserves with its
  offer; a run whose share is below four times that skips it. A settled state
  at or below the bound (squeeze keeps the size above the bound) is first set
  just above it, 1e-6 relative.
- **Runs.** Under an evaluation budget, as many full-length runs as fit
  (`restarts` = 0), at least one and never so many that a run would be shorter
  than 32 steps. Each run takes an equal share of what is left and the longest
  step count whose steps, measurements, offers and squeeze fit in it (a
  bisection), split in the reference's proportion. So a run is never cut before
  it settles and offers. Under a time budget or a stop alone, runs have full
  length and follow each other until the run ends.
- **Supplied start.** It replaces the random start of the first run, which then
  has no compression phase; those steps go to the path. The pieces become soft
  at the path's start, so hardening forgets the start's orientations, as in the
  reference. The framework already holds a valid start as its first best, so a
  run never returns worse than it.
- **Divergence.** A run whose energy, variables or size stop being finite ends
  without an offer; the next run starts afresh.

All randomness comes from the run's seeded stream (Box–Muller from two draws,
as in the reference); a run with an evaluation budget is reproducible from the
seed.

## Parameters and defaults

| Parameter     | Default | Allowed values / purpose                                                                                       |
| ------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| path          | harden  | harden, rigid, snap                                                                                            |
| pressure      | 0.16    | 0.0001–4; mu per inscribed diameter and per unit of a square's side (reference best-of-runs tuning for harden) |
| noise         | 8       | 0–64; noise multiplier nu (reference tuning for harden)                                                        |
| tau0          | 1       | 0–1; starting softness of the harden path (1 disk or ball, 0 true shape)                                       |
| compressSteps | 2500    | Integer 0–1,000,000; compression steps of a full-length run                                                    |
| morphSteps    | 7500    | Integer 1–1,000,000; path steps of a full-length run                                                           |
| settleSteps   | 1500    | Integer 0–1,000,000; settling steps of a full-length run                                                       |
| restarts      | 0       | Integer 0–100,000; number of runs, 0 = as many full-length runs as the budget allows                           |
| offerInterval | 1000    | Integer 0–1,000,000; settling steps between offers inside a run, 0 = only at the end                           |
| polish        | true    | Boolean; the closing squeeze                                                                                   |

The polygon method's `gamma0` (grow path), `fill` (start area) and
`evaluationInterval` (its budget unit) have no counterpart here: the start is
the kernel's own `randomStart`, roomy by the kernel's rule, and the budget unit
is the energy evaluation.

## Deviations from the reference and from the polygon port

[CALC]

1. The kernel's energy and soft shapes instead of the shared polygon geometry;
   only the paths along t (harden, rigid, snap).
2. The size moves in units of room, measured from the gradient, with the
   pressure per unit of a square's side, and stays between half the bound and
   the run's start size; the polygon port moves the side (M <= 6) or the
   apothem (M >= 7) with the pressure per unit of either.
3. Every variable's update is scaled by (steps / inradius)^2; the cap bounds a
   piece's whole move in steps rather than its translation and rotation
   separately.
4. The start is the kernel's `randomStart`, not 3.2 times the piece area with
   pieces clear of the walls; the first offer is a seed or a relaxed start.
5. The budget is counted in energy evaluations at the kernel's costs; offers
   only while settling and at the end, instead of an assessment every 32 steps.
6. The legalisation is the space's `finish`; the closing squeeze is PolyPack's
   addition (the polygon framework has its own final polish instead).
7. Velocities are dropped where a chart changes.

## Measurements

[CALC] Measured on 2026-10-26 on an Apple M1 Pro (eight logical CPUs), Node
v26.5.0, under heavy unrelated load, two benchmark processes at a time.
Seconds are wall times under that load; scores do not depend on it. Every
result below was checked valid at tolerance 0. No result is below a published
value.

### The reference kernel

Command (`packages/methods/scripts/bench-harden.ts`):

```sh
nice -n 10 npx tsx packages/methods/scripts/bench-harden.ts 30000 10 2,3,4,5,6,7,8,9,10,11,12 '{}' disks
nice -n 10 npx tsx packages/methods/scripts/bench-harden.ts 3000 10 2,3,4,5,6,7,8,9,10,11,12 '{}' soft
```

"Disks" is the reference kernel, where `setShape` changes nothing, so the run
is pressure compression of the true disks. "Soft disks" is the tests' kernel
(`packages/methods/test/soft-disks.ts`): the same problem, whose soft shape at
t is a disk of radius 1 - 0.3 (1 - t), so the runs really harden from radius
0.7. Registered defaults, no start, seeds 1–10. Each cell is the median / the
worst of score / best known - 1, with the best known radius from
`DISKS_IN_CIRCLE_BEST`.

|   P |      Disks, 3,000 |   Disks, 30,000 | Soft disks, 3,000 | Soft disks, 30,000 |
| --: | ----------------: | --------------: | ----------------: | -----------------: |
|   2 |             0 / 0 |           0 / 0 |             0 / 0 |              0 / 0 |
|   3 |             0 / 0 |           0 / 0 |             0 / 0 |              0 / 0 |
|   4 |             0 / 0 |           0 / 0 |             0 / 0 |              0 / 0 |
|   5 |             0 / 0 |           0 / 0 |             0 / 0 |              0 / 0 |
|   6 |   7.3e-9 / 1.4e-8 | 1.7e-8 / 1.7e-8 |   2.7e-9 / 1.3e-8 |    1.7e-8 / 1.7e-8 |
|   7 |             0 / 0 |           0 / 0 |             0 / 0 |              0 / 0 |
|   8 | 1.2e-14 / 1.9e-14 |           0 / 0 | 1.1e-14 / 1.7e-14 |              0 / 0 |
|   9 |   5.1e-3 / 1.0e-2 |           0 / 0 |  1.1e-14 / 1.0e-2 |              0 / 0 |
|  10 |   6.6e-4 / 2.9e-2 | 2.4e-8 / 2.4e-8 |   5.5e-4 / 3.8e-3 |    2.4e-8 / 2.4e-8 |
|  11 |   1.2e-8 / 1.2e-8 | 1.2e-8 / 1.2e-8 |   1.2e-8 / 1.5e-2 |    1.2e-8 / 1.2e-8 |
|  12 |   2.7e-4 / 6.3e-3 | 4.2e-9 / 4.2e-9 |   2.9e-4 / 7.8e-4 |    4.2e-9 / 4.2e-9 |

Runs used 2,601 to 3,000 of 3,000 evaluations and 29,594 to 29,756 of 30,000
(the rest is the closing squeeze's unused allowance), at most 0.08 s per run.

- At 30,000 evaluations every run for P = 2 to 12 on both kernels reaches the
  best known packing to within 2.4e-8. At 3,000 (one shortened run) most do;
  the worst runs stay in other local optima, up to 2.9% above.
- Checks of the first version found that three stored values of
  `DISKS_IN_CIRCLE_BEST` were off: for P = 8 (the optimum is
  `1 + 1/sin(pi/7)` [EST], Wikipedia, "Circle packing in a circle", proved by
  Pirl, 1969), P = 10 and P = 12, where every run at 30,000 ended at
  R = 4.0296019, 9.3e-5 below the stored value, and the configuration checked
  at 50 digits had its closest pair 2 - 5.6e-18 apart and every disk inside
  [CALC]. They have been corrected; the table uses the corrected values.

### Space kernels

[CALC] Six problems of the spaces, registered defaults, no start, seeds 1–5,
5,000 and 20,000 evaluations. "Record" is the stored value
(`data/<space>/records.json`, `score_cert`). "Within" counts runs at most 1e-4
relative above it.

| Problem                   | Record   | Budget | Best     | Median   | Worst    | Within 1e-4 | Results | Evaluations used |
| ------------------------- | -------- | -----: | -------- | -------- | -------- | ----------: | ------: | ---------------- |
| sphere/4/12               | 1.111808 |  5,000 | 1.122196 | 1.126815 | 1.130862 |         0/5 |     5/5 | 5,000            |
| sphere/4/12               | 1.111808 | 20,000 | 1.121131 | 1.121132 | 1.122159 |         0/5 |     5/5 | 19,521–19,598    |
| torus/sq/4/5              | 2.236068 |  5,000 | 2.236081 | 2.236086 | 2.236088 |         5/5 |     5/5 | 4,851–4,936      |
| torus/sq/4/5              | 2.236068 | 20,000 | 2.236069 | 2.236069 | 2.236069 |         5/5 |     5/5 | 19,670–19,808    |
| curved/-1/3/4/6           | 2.843790 |  5,000 | 2.843793 | 3.959548 | 5.172432 |         2/5 |     5/5 | 4,997–5,000      |
| curved/-1/3/4/6           | 2.843790 | 20,000 | 2.843790 | 4.100224 | 4.873025 |         2/5 |     4/5 | 19,929–20,000    |
| polyhedra/cubincub/9      | 2.707107 |  5,000 | 2.767767 | 2.773471 | 2.828438 |         0/5 |     5/5 | 5,000            |
| polyhedra/cubincub/9      | 2.707107 | 20,000 | 2.707107 | 2.707107 | 2.767770 |         3/5 |     5/5 | 18,450–20,000    |
| boundary/tesseract/ball/8 | 1.931852 |  5,000 | 2.000000 | 2.000000 | 2.000000 |         0/5 |     5/5 | 4,002            |
| boundary/tesseract/ball/8 | 1.931852 | 20,000 | 1.931856 | 1.936691 | 1.936691 |         1/5 |     5/5 | 16,152           |
| surface/cube/fold/4/7     | 1.216554 |  5,000 | 1.229883 | 1.252153 | 1.327908 |         0/5 |     5/5 | 4,996            |
| surface/cube/fold/4/7     | 1.216554 | 20,000 | 1.241987 | 1.250000 | 1.258321 |         0/5 |     5/5 | 17,961–19,929    |

What these runs show, and no more than that:

- Every run ended on its own ("done"), within its budget, and returned a
  valid configuration except one: curved/-1/3/4/6 at 20,000, seed 4. Its
  arrangement jammed with overlaps that no size of the hyperbolic square
  relieves (its room is bounded), and the space's finishing refused all five
  of its offers, the two relaxed random starts included. The size stayed at
  most at the start's (see Floor and ceiling of the size).
- On the boundary's balls a finish costs 2,000 and a validation 2,000, so
  5,000 evaluations pay for the first offer (a seed, 2.000000) and too few
  steps for a run; 20,000 pay for one run.
- In the first version, with one evaluation per step, raw random first
  offers and the size in units of size, the same matrix (seeds 1–3) returned
  nothing on the surface at both budgets and on the boundary at 5,000, and on
  curved every run at 20,000 ended 33% to 55% above the record (3.77 to 4.40).

[CALC] The `pressure` parameter at 20,000 evaluations, seeds 1–6, runs
within 1e-4 of the record (measured before the size was capped at the
start's):

| pressure       | curved/-1/3/4/6 | polyhedra/cubincub/9 |
| -------------- | --------------: | -------------------: |
| 0.08           |             5/6 |                  2/6 |
| 0.16 (default) |             3/6 |                  5/6 |
| 0.32           |             1/6 |                  6/6 |

The default, the reference's tuning per unit of a square's side, is the
middle of this trade-off; on sphere, boundary and surface (seeds 1–3) it was
as good as 0.08 or better, and on the reference disks 0.08 is better at
P = 20 and 30 (Variants, below). A problem that prefers another value can
pass `pressure`.

### Variants at larger P

[CALC] Median (best) score over seeds 1–5 at 30,000 evaluations on the
reference and soft disks, P = 13 to 30, where there are no stored best known
values; lower is better.

```sh
nice -n 10 npx tsx packages/methods/scripts/bench-harden.ts 30000 5 13,15,18,20,25,30 '{"path":"rigid"}' soft
```

| Kernel     | Variant                                    | P = 13          | 15              | 18              | 20              | 25              | 30              |
| ---------- | ------------------------------------------ | --------------- | --------------- | --------------- | --------------- | --------------- | --------------- |
| Disks      | default (pressure 0.16)                    | 4.2361 (4.2361) | 4.5276 (4.5272) | 4.8637 (4.8637) | 5.1786 (5.1223) | 5.7529 (5.7529) | 6.2162 (6.2162) |
| Disks      | rigid path                                 | 4.2361 (4.2361) | 4.5276 (4.5272) | 4.8637 (4.8637) | 5.1786 (5.1223) | 5.7529 (5.7529) | 6.2162 (6.2162) |
| Disks      | snap path                                  | 4.2361 (4.2361) | 4.5276 (4.5272) | 4.8637 (4.8637) | 5.1786 (5.1223) | 5.7529 (5.7529) | 6.2162 (6.2162) |
| Disks      | no closing squeeze                         | 4.2361 (4.2361) | 4.5292 (4.5288) | 4.8637 (4.8637) | 5.1223 (5.1223) | 5.7529 (5.7529) | 6.2195 (6.2186) |
| Disks      | short runs (500 / 1,500 / 300)             | 4.2361 (4.2361) | 4.5291 (4.5277) | 4.8637 (4.8637) | 5.1223 (5.1223) | 5.7598 (5.7558) | 6.2115 (6.1997) |
| Disks      | noise 2                                    | 4.2361 (4.2361) | 4.5495 (4.5275) | 4.8637 (4.8637) | 5.1786 (5.1223) | 5.7677 (5.7608) | 6.2162 (6.2161) |
| Disks      | pressure 0.08 (the polygon port's circles) | 4.2361 (4.2361) | 4.5272 (4.5214) | 4.8637 (4.8637) | 5.1223 (5.1223) | 5.7529 (5.7529) | 6.1978 (6.1977) |
| Disks      | pressure 0.32                              | 4.2361 (4.2361) | 4.5240 (4.5230) | 4.8637 (4.8637) | 5.1786 (5.1223) | 5.7613 (5.7613) | 6.2207 (6.2207) |
| Soft disks | default (pressure 0.16)                    | 4.2361 (4.2361) | 4.5276 (4.5272) | 4.8637 (4.8637) | 5.1786 (5.1223) | 5.7529 (5.7529) | 6.2177 (6.2166) |
| Soft disks | rigid path                                 | 4.2361 (4.2361) | 4.5276 (4.5272) | 4.8637 (4.8637) | 5.1786 (5.1223) | 5.7529 (5.7529) | 6.2162 (6.2162) |
| Soft disks | snap path                                  | 4.2361 (4.2361) | 4.5275 (4.5271) | 4.8637 (4.8637) | 5.1223 (5.1223) | 5.7529 (5.7529) | 6.2168 (6.2150) |
| Soft disks | no closing squeeze                         | 4.2361 (4.2361) | 4.5293 (4.5289) | 4.8637 (4.8637) | 5.1786 (5.1223) | 5.7529 (5.7529) | 6.2203 (6.2200) |
| Soft disks | short runs (500 / 1,500 / 300)             | 4.2361 (4.2361) | 4.5292 (4.5286) | 4.8637 (4.8637) | 5.1223 (5.1223) | 5.7577 (5.7559) | 6.2036 (6.2006) |
| Soft disks | noise 2                                    | 4.2361 (4.2361) | 4.5495 (4.5495) | 4.8637 (4.8637) | 5.1786 (5.1786) | 5.7610 (5.7609) | 6.2145 (6.2141) |
| Soft disks | pressure 0.08 (the polygon port's circles) | 4.2361 (4.2361) | 4.5257 (4.5221) | 4.8637 (4.8637) | 5.1223 (5.1223) | 5.7529 (5.7529) | 6.2003 (6.1981) |
| Soft disks | pressure 0.32                              | 4.2361 (4.2361) | 4.5495 (4.5237) | 4.8637 (4.8637) | 5.1223 (5.1223) | 5.7613 (5.7613) | 6.2207 (6.2207) |

On the reference kernel the three paths are identical, as they must be (its
soft shape is the disk itself). On these disks pressure 0.08 is better than the
default at P = 20 and 30 (median 6.1978 against 6.2162 at P = 30),
as on curved/-1/3/4/6 and unlike polyhedra/cubincub/9 (Space kernels, above).
Less noise does not help; shorter runs (more of them) are better at P = 30
and worse at P = 25; the closing squeeze changes the last digits, not the
packing found. The samples do not separate the harden path
from the rigid path on round pieces, as the originator's study leads one to
expect [SPEC]; hardening's reported advantage is on squares in a square
(polygon page).

[CALC] The alternative the task named, a sequence of squeezes at rising t, is
`morph` itself ([morph.md](morph.md)); its rows at the same P are on that page.

## Verification

[CALC] `packages/methods/test/harden.test.ts` (20 tests):

```sh
npx vitest run packages/methods/test/harden.test.ts
```

It covers the paths and their exact endpoint, the phase split, the run plan
at the kernel's costs (a step at `gradCost`, the unit's measurements, offers
at `finishCost + validateCost`) and the longest run that fits a share; the
dynamics: a kernel whose variables are stored at half their length moves
exactly as the reference kernel, the size's unit measured as 1 for a circle's
radius and 0.5 for a square's side, and a rebase that stops exactly the pieces
whose chart changed; the method's registration and capability; P = 2 to 10
on the reference kernel within 0.1% of the best known radius at 30,000
evaluations; reproducibility from the seed and a different result for another
seed; the evaluation budget for budgets of 40 to 12,000 and for large
`restarts`; a valid result after a stop or a time limit; a valid start never
worsened and a loose start improved; refused parameters; on the soft disks
kernel (which passes `checkKernel`): t = 0 while compressing, strictly rising
t along the path, ending at 1, a compressed size below the true optimum, every
state handed to `finish` at t = 1, and P = 2 to 10 within 0.1%.

Tests on an expensive test kernel (the soft disks with a finish of 1,000, a
gradient of 4, and a finish that refuses overlapping states, so that raw random
starts never finish), each written so that the defect found in the first version fails
it, which was checked by putting each defect back:

- runs planned at the kernel's costs end "done", settle and offer, and spend
  more than 90% of 5,000 and 20,000 evaluations (fails with one evaluation per
  step, and with an offer reserve of twice the finish);
- a run stopped after 60 calls returns a valid result, with seeds and without
  (fails with a raw random first offer);
- in a circle whose radius saturates with the size (R = 3.9 tanh(L / 3.9), the
  hyperbolic case), the run ends within 1e-3 of the optimum (fails, 4.4% above,
  with the size in units of size);
- with the bound at the optimum and a finish that refuses any overlap, the run
  reaches the bound (fails, 18% to 45% above, without starting the closing
  squeeze above the bound).

The variable-scaling and rebase tests likewise fail with the reference's
unscaled rate and with velocities kept across a rebase. The tests pass under
Node 26 and Node 24.
