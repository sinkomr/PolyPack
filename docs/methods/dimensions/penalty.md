# Penalty (`penalty`)

Board title: **Penalty**. Summary: "Squeezes the packing tighter while overlapping pieces push apart,
restarts from fresh layouts, and keeps the tightest valid result."

This is the polygon method `penalty` ([`../penalty.md`](../penalty.md)) written once against the
kernel interface ([`README.md`](README.md)). It needs no kernel capability. It uses `seeds` when
the kernel has it. Code: `packages/methods/src/methods/penalty.ts`, `penalty-schedule.ts` and
`seed-starts.ts`.

## How it works

[CALC] The method minimises `size + mu * E` over every piece's variables, the globals and the size
together. `E` is the kernel's penalty energy: squared overlaps and protrusions, measured as lengths.
L-BFGS solves it for each weight `mu` of a schedule, then relaxes the state at the size reached.
The framework's finish (`ctx.offer`) turns the result into a valid configuration.

1. **Starts.** The given start comes first. Further starts follow while the budget lasts, or
   `starts` of them in all. A share `seedShare` comes from the kernel's seeds; the rest are random
   starts. Seeds are asked for in batches of 8. A seed met before is skipped. When the kernel gives
   nothing new, every later start is random. Every structured start is moved by a seeded `jitter`
   (0.1 piece steps by default) before its descent: a symmetric layout can hold a descent at a
   saddle, and polyhedra seeds, which turn every piece alike, need a real knock. A given start is
   only nudged, by 1e-4 of the jitter, which keeps its layout; random starts are not moved.
2. **Descent.** The weight schedule, below. Its L-BFGS iterations per solve are `innerIterations`,
   or fewer when the descent and its offer would not fit in the evaluations left. An iteration is
   reckoned at 1.5 gradients, each costing the kernel's `gradCost`. Until the run has a result, a
   descent takes at most half of what its offer leaves, or all of it when a second offer would not
   fit anyway. So a run whose budget holds a few finishes still ends with a result.
3. **Offer and restoration.** The descended state is offered. When its finish fails, the method
   restores it: it relaxes the state at its size and offers it again; then it grows the size by
   1%, 2%, 4%, ... up to 128%, relaxing at each size, until a finish succeeds. Growing keeps the
   normalized arrangement, so it moves the pieces apart. `restoration: "expand"` grows without
   relaxing.
4. **Polish.** A start whose finished score beats the best so far is squeezed again with the
   weights 1e6, 1e7, 1e8 and 1e9, and offered once more. This is the final finish of the best,
   done at once: the budget ends at whatever kernel call spends it, so a polish saved for the end
   would often not happen. New bests are rare once starts accumulate: among n random starts, about
   ln n set a new best. Where the space's own finish polishes already, as in curved space, a
   polish gains nothing; after the first such polish the run tries no more. The budget can still
   cut a polish short, and then the best returned is unpolished.

The method never checks validity itself; the framework finishes and checks every offer and keeps
the best. Once the run has a result, an offer that no longer fits the budget ends the run. The
first result may overrun the budget by one finish and one check.

## The schedules

[CALC] **quadratic** (the default) is the squeeze of `local.ts`: `mu = initialWeight *
growthFactor^k` for `k = 0 ... outerIterations - 1`, by default 10, 100, 1000 and 10000.

[EST] The polygon method's augmented schedule adds the Powell–Hestenes–Rockafellar term
`(max(0, lambda + 2 mu g)^2 - lambda^2) / (4 mu)` for each constraint `g <= 0` (Nocedal and Wright,
section 17.4). [CALC] That term equals `mu * max(0, g + lambda / (2 mu))^2 - lambda^2 / (4 mu)`: it
shifts each constraint by `lambda / (2 mu)`. A kernel's energy has no shift per constraint. Its only
handle is one weight per piece; a pair term takes the mean of its two pieces' weights.

[CALC] **augmented** therefore uses the weights as multipliers. At the minimum of a solve, each
contact carries about the force its geometry needs, `2 * w * depth`, where `w` is the term's
weight. To bring a contact's residual depth `r` down to a target `tau`, its weight must grow by
about `r / tau`. Per piece this is a heuristic: a pair term's weight is the mean `(w_i + w_j) / 2`,
so raising one piece's weight by `r / tau` raises its pair terms by less, unless both pieces lag.
After each solve the method measures every piece's residual depth, the square root of its own
energy terms:

- if the largest residual fell to at most `violationReduction` times the last one, `mu` is held and
  every piece with `r > tau = violationReduction * largest` has its weight multiplied by `r / tau`;
- otherwise `mu` grows by `growthFactor`.

The first solve holds `mu` and sets the baseline, as in the polygon method. This is a weighted
penalty in the spirit of the method of multipliers. It is not PHR: no constraint is ever shifted,
so the residuals still vanish only through rising weights.

### Measured: the multipliers gain nothing over a converged quadratic schedule

[CALC] Unit disks in a circle (the reference kernel), 20,000 evaluations, seeds 1–20. Each cell is
the number of runs within 1e-6 of the best known radius in `data/records.json` (Packomania), then
the median excess over it.

|   P | Default: quadratic, 4 weights, 500 it. | Quadratic, 6 weights, 200 it. | Augmented, 8 solves, 200 it. | Quadratic, 6 weights, 500 it. | Augmented, 8 solves, 500 it. |
| --: | -------------------------------------: | ----------------------------: | ---------------------------: | ----------------------------: | ---------------------------: |
|  22 |                           14 · 1.3e-11 |                    4 · 1.6e-4 |                 12 · 1.3e-11 |                  11 · 1.3e-11 |                 12 · 1.3e-11 |
|  23 |                           19 · 2.0e-11 |                    0 · 4.2e-4 |                 19 · 2.1e-11 |                  18 · 2.1e-11 |                 18 · 2.1e-11 |
|  25 |                             7 · 4.9e-6 |                    0 · 9.2e-4 |                  13 · 1.4e-9 |                    4 · 4.9e-6 |                   5 · 4.9e-6 |
|  28 |                             7 · 1.1e-5 |                    0 · 4.5e-3 |                   8 · 1.1e-5 |                    4 · 9.9e-5 |                   7 · 9.8e-5 |
|  30 |                           20 · 1.1e-11 |                    7 · 3.2e-4 |                 13 · 1.1e-11 |                  18 · 1.1e-11 |                 19 · 1.1e-11 |

[CALC] At the polygon method's 200 inner iterations, the augmented schedule is far ahead of the
quadratic one (P = 23: 19 runs at the best known radius against none). The cause is convergence,
not the multipliers: with 500 inner iterations the same quadratic schedule comes within a few runs
of the augmented one at every P. At 200 iterations the quadratic solves at high weights stop before
they converge; holding `mu` low, as the augmented schedule does, hides that.

[CALC] So the default is quadratic, with 500 inner iterations and four weights (10 to 1e4). The
polish supplies the heavy weights for new bests only, which leaves more evaluations for starts: the
default matches or beats six weights at every P above. The augmented schedule at 200 iterations
does better than the default at P = 25 and worse at P = 30; it stays as an option for kernels whose
solves converge slowly.

## Parameters

| Parameter            | Default       | Schema                         | Meaning                                                                                           |
| -------------------- | ------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `seedShare`          | 0.5           | number in [0, 1]               | Share of the starts taken from the kernel's seeds, where it has them.                             |
| `schedule`           | `"quadratic"` | `"quadratic"` or `"augmented"` | The weight schedule.                                                                              |
| `initialWeight`      | 10            | number > 0                     | The first weight `mu`.                                                                            |
| `growthFactor`       | 10            | number in [1, 100]             | Weight multiplier per quadratic solve, or per augmented solve that left too much overlap.         |
| `outerIterations`    | 4             | integer in [1, 100]            | Solves per start, one weight each.                                                                |
| `innerIterations`    | 500           | integer in [1, 10000]          | L-BFGS iterations per solve and per relaxation.                                                   |
| `violationReduction` | 0.5           | number in (0, 1)               | Augmented: the fall of the largest residual that holds `mu`.                                      |
| `jitter`             | 0.1           | number in [0, 1]               | Seeded move of every piece of a structured start, in piece steps; a given start moves 1e-4 of it. |
| `restoration`        | `"relax"`     | `"relax"` or `"expand"`        | Relax then grow, or grow only, when a finish fails.                                               |
| `starts`             | 0             | integer in [0, 1e6]            | Starts in all, the given one first; 0 restarts while the budget lasts.                            |
| `polish`             | true          | boolean                        | Squeeze every new best with weights up to 1e9 and offer it again.                                 |

The schema is an object with `additionalProperties: false`; every property has a title, a
description and its default.

## Measurements

[CALC] Node.js v26.5.0, Apple Silicon. Every result is checked with the kernel's own validator.
Times are not given: the machine was shared and loaded.

### Space kernels

[CALC] Defaults, seeds 1–3. Each cell is the median excess over the space's record
(`score_cert` in `data/<space>/records.json`), then the runs within 1e-3 of it. Every run has a
result. A negative excess (1e-12 to 1e-7) is a score just below the record's certified score,
which carries a safety margin; it is not a new record.

| Problem                   | finishCost + check | 1,000 evaluations |        5,000 |       20,000 |
| ------------------------- | -----------------: | ----------------: | -----------: | -----------: |
| surface/cube/fold/4/7     |            275 + 2 |       +5.8e-1 · 0 |  +1.1e-1 · 0 |  +1.0e-1 · 0 |
| sphere/4/12               |          500 + 200 |       +2.3e-1 · 0 |  +5.2e-2 · 0 |  +8.5e-3 · 0 |
| sphere/0/13               |             30 + 5 |       +3.8e-2 · 0 | −8.3e-12 · 3 | −8.3e-12 · 3 |
| torus/free/3/6            |            50 + 10 |       +1.0e-1 · 0 | +7.7e-11 · 3 | +7.7e-11 · 3 |
| boundary/tesseract/cube/9 |        2000 + 2000 |       +9.0e-1 · 0 |  +6.7e-2 · 0 | −1.0e-12 · 3 |
| polyhedra/tetintet/6      |          769 + 769 |       +3.6e-1 · 0 |  +4.2e-2 · 0 |  −1.4e-7 · 3 |
| curved/-1/0/0/7           |            492 + 3 |      −2.3e-11 · 2 | −2.3e-11 · 3 | −2.3e-11 · 3 |
| curved/-1/3/4/5           |            492 + 3 |       +3.4e-3 · 1 |  +3.4e-3 · 1 | −3.8e-11 · 3 |
| curved/1/4/4/3            |            725 + 3 |       +6.6e-5 · 2 | −8.3e-12 · 3 | −8.3e-12 · 3 |

[CALC] At 1,000 evaluations the first descent is cut to fit, so its result is loose where a finish
is dear. The boundary problem's first result costs 4,000 evaluations (finish and check), so its
runs at 1,000 end at about 4,000: the framework lets the first result overrun the budget. On the
torus the runs end early at the problem's lower bound.

**Jitter.** [CALC] Penalty, 20,000 evaluations, seeds 1–6, runs within 1e-3 of the record and the
median. Only the polyhedra problem tells them apart: its seeds turn every piece alike, and a
knock of 0.1 piece steps gets them out of that saddle.

| Problem                   | Jitter 1e-5 | Jitter 0.1 (default) |
| ------------------------- | ----------: | -------------------: |
| polyhedra/tetintet/6      | 2 · +3.6e-3 |          4 · −1.3e-7 |
| sphere/4/12               | 0 · +9.1e-3 |          0 · +9.1e-3 |
| every other problem above |  same count |           same count |

**Polish.** [CALC] Without it (seeds 1–3, 20,000 evaluations) sphere/0/13 ends 1.6e-7 above the
record instead of at it, and polyhedra/tetintet/6 has 2 runs near the record instead of 3. On the
surface problem, whose gradient costs 8 evaluations, the polish takes evaluations from the starts:
without it the median is 6.9e-2 instead of 1.0e-1. On curved space, whose finish polishes, the
first polish gains nothing and is the only one tried; the scores are the same.

### The reference kernel: disks in a circle

**P = 2 to 12, defaults, 20,000 evaluations, seeds 1–20.** Every run is within 1e-6 of the best
known radius (`data/records.json`, Packomania). The worst excess over it:

|   P | Best known R | Worst relative excess |
| --: | -----------: | --------------------: |
|   2 |            2 |                     0 |
|   3 |  2.154700538 |               2.0e-14 |
|   4 |  2.414213562 |               4.5e-14 |
|   5 |  2.701301617 |               2.2e-15 |
|   6 |            3 |               5.4e-14 |
|   7 |            3 |               3.3e-15 |
|   8 |  3.304764871 |               2.0e-14 |
|   9 |  3.613125930 |               7.1e-14 |
|  10 |  3.813025631 |               2.4e-11 |
|  11 |  3.923804400 |               1.2e-11 |
|  12 |  4.029601930 |               4.6e-12 |

**Variants at P = 9, 22, 25, 28 and 30**, runs within 1e-6 of the best known radius (of 20):

|   P | Default | No polish | Random starts only | Seeds only | Jitter 1e-5 |
| --: | ------: | --------: | -----------------: | ---------: | ----------: |
|   9 |      20 |        20 |                 20 |          0 |          20 |
|  22 |      14 |         0 |                 16 |          0 |          15 |
|  25 |       7 |         0 |                  2 |         12 |          10 |
|  28 |       7 |         0 |                  1 |         14 |          14 |
|  30 |      20 |         0 |                 20 |         20 |          19 |

[CALC] Without the polish, the best run at P = 22 to 30 ends 1.1e-6 to 1.5e-6 above the best known
radius: the descent's weights end at 1e4. The seeds of the reference kernel, hexagonal patches,
trap every start at P = 9 and P = 22 in a worse local optimum, while at P = 25 and P = 28 they lead
to the best known packing more often than random starts. The share of one half hedges between the
two; it is not tuned per space. Here a jitter of 1e-5 does better at P = 25 and 28: the lattice
patches are best kept as they are. The default of 0.1 serves the space kernels instead.

Reproduce with:

```sh
nice -n 10 npx tsx packages/methods/scripts/bench-penalty-seed-real.ts penalty 1000,5000,20000 3 all default
nice -n 10 npx tsx packages/methods/scripts/bench-penalty-seed-real.ts penalty 20000 6 all jitter1e-5 default
nice -n 10 npx tsx packages/methods/scripts/bench-penalty-seed-real.ts penalty 20000 3 all no_polish
nice -n 10 npx tsx packages/methods/scripts/bench-penalty.ts 20000 20 2,3,4,5,6,7,8,9,10,11,12 default
nice -n 10 npx tsx packages/methods/scripts/bench-penalty.ts 20000 20 22,23,25,28,30 default quadratic200 augmented200 quadratic500 augmented500
nice -n 10 npx tsx packages/methods/scripts/bench-penalty.ts 20000 20 9,22,25,28,30 default no_polish random seeds jitter1e-5
```

The variants are defined at the top of each script. Runs are reproducible from the seed in one
JavaScript runtime; another Node.js version may round differently and give other runs.

## Differences from the polygon method

- The polygon method descends from one start. This one restarts while the budget lasts; `starts: 1`
  gives a single descent.
- Its `start: "seed" | "scatter"` (a 24-assessment seed subrun, or a jittered grid) became
  `seedShare`: seeds and random starts mixed over all starts.
- It assessed every accepted L-BFGS step. Here a finish can cost far more than an energy evaluation,
  so the method offers once per start, plus restoration and polish.
- `memory` and `gradientTolerance` are not exposed: the shared L-BFGS keeps 12 pairs and stops on a
  negligible relative decrease.
- Its restoration `"separate"` (pairwise separating moves) is the kernel's relaxation at a fixed size
  here, `"relax"`.
- The container's centre and angle were variables of the polygon objective. Here they are the
  kernel's affair: charts, globals or the size.

## Limits

- [CALC] The defaults were chosen from these runs, on a few problems per space and few seeds.
  [SPEC] Other problems may want other defaults, the augmented schedule among them.
- The seeds can trap a whole share of the starts in one local optimum, as at P = 9 above.
- At 1,000 evaluations a space with a dear finish gets one loose result, not a packing.
- It is a multistart local method, not a global search; it gives no optimality guarantee.

## References

[EST] As cited and checked in [`../penalty.md`](../penalty.md):

- Jorge Nocedal and Stephen J. Wright, _Numerical Optimization_, second edition, Springer, 2006.
  Chapter 17, "Penalty and Augmented Lagrangian Methods", pp. 497–528.
- Dong C. Liu and Jorge Nocedal, "On the limited memory BFGS method for large scale optimization",
  _Mathematical Programming_ 45, 503–528, 1989.
