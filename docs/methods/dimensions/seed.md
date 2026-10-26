# Seeds (`seed`)

Board title: **Seeds**. Summary: "Tries many quick starting layouts, settles each one briefly, and
keeps the tightest."

This is the polygon method `seed` ([`../seed.md`](../seed.md)) written once against the kernel
interface ([`README.md`](README.md)). It generates starts rather than optimising one. It needs no
kernel capability and uses `seeds` when the kernel has it. Its result is a good start for `penalty`
or `basin_hopping`. Code: `packages/methods/src/methods/seed.ts` and `seed-starts.ts`.

## How it works

[CALC]

1. The given start comes first.
2. Further starts follow while the budget lasts, or `starts` of them in all. A share `seedShare`
   comes from the kernel's structured seeds (lattices, rings, symmetric layouts: whatever the space
   provides); the rest are the kernel's random starts. Seeds are asked for in batches of `batch`,
   each seed costing one evaluation.
3. A seed met before is skipped: its configuration's hash was seen. A batch with nothing new doubles
   the request once; when that brings nothing new either, the seeds are spent and every later start
   is random. So a kernel that lists the same few layouts on every call gives each of them once.
4. Each structured start is moved by a seeded `jitter` (a tenth of a piece step by default), a
   given start by 1e-4 of it, a random start not at all. Then each start gets a short squeeze: `iterations` L-BFGS iterations at each of the weights 10, 100, ..., 10^`squeeze`, then
   a relaxation at the size reached. With `squeeze: 0` it is only relaxed at its own size. The
   iterations shrink when the squeeze and its offer would not fit in the evaluations left; until the
   run has a result, a squeeze takes at most half of what its offer leaves (all of it when a second
   offer would not fit anyway). So a run whose budget holds a few finishes still ends with a result.
5. The settled start is offered. The framework finishes it and keeps the best.

A start whose finish fails is dropped; there is no restoration, as starts are cheap. Once the run
has a result, an offer that no longer fits the budget ends the run; the first result may overrun
the budget by one finish and one check.

## What carries over from the polygon method, and what is dropped

Kept: many cheap structured starts, each scored by the exact finishing, the best kept.

Dropped:

- **The generators.** Square and hexagonal lattices, the pentagon double lattice, rings and rows
  are 2D constructions for polygons in a polygon. A space supplies its own structured starts
  through the kernel's `seeds()`; the reference kernel gives patches of the hexagonal lattice. This
  method knows no lattice.
- **Trials over lattice angle, offset and piece orientation.** `seeds()` receives the random
  stream, so such variation is the kernel's to make.
- **`record_plus_one` and `record_minus_one`.** They need a configuration with P − 1 or P + 1
  pieces. A kernel reads configurations of its own P only.
- **The emitted pool.** The polygon method emits up to `poolLimit` seeds that differ by a
  congruence signature, for later methods to use. The kernel framework keeps one best and has no
  emit. What generalises of the signature, skipping exact repeats, is kept.
- **No optimisation.** The polygon seeds are valid as built. A kernel's seeds and random starts
  need not be valid or tight (random starts are roomy by contract), so every start gets a short
  squeeze here.

## Parameters

| Parameter    | Default | Schema               | Meaning                                                                                           |
| ------------ | ------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| `seedShare`  | 0.5     | number in [0, 1]     | Share of the starts taken from the kernel's seeds, where it has them.                             |
| `batch`      | 8       | integer in [1, 256]  | Seeds asked for at once.                                                                          |
| `squeeze`    | 4       | integer in [0, 8]    | The short squeeze's weights 10 ... 10^k; 0 relaxes only.                                          |
| `iterations` | 200     | integer in [1, 1000] | L-BFGS iterations per weight.                                                                     |
| `jitter`     | 0.1     | number in [0, 1]     | Seeded move of every piece of a structured start, in piece steps; a given start moves 1e-4 of it. |
| `starts`     | 0       | integer in [0, 1e6]  | Starts in all, the given one first; 0 offers starts while the budget lasts.                       |

The schema is an object with `additionalProperties: false`; every property has a title, a
description and its default.

## Measurements

[CALC] Node.js v26.5.0, Apple Silicon. Every result is checked with the kernel's own validator.

### Space kernels

[CALC] Defaults, seeds 1–3. Each cell is the median excess over the space's record
(`score_cert` in `data/<space>/records.json`), then the runs within 1e-3 of it. Every run has a
result. A negative excess (1e-13 to 1e-10) is a score just below the record's certified score,
which carries a safety margin; it is not a new record. The costs of a finish are listed in
[`penalty.md`](penalty.md).

| Problem                   | 1,000 evaluations |        5,000 |       20,000 |
| ------------------------- | ----------------: | -----------: | -----------: |
| surface/cube/fold/4/7     |       +5.8e-1 · 0 |  +1.1e-1 · 0 |  +6.9e-2 · 0 |
| sphere/4/12               |       +2.3e-1 · 0 |  +2.0e-2 · 0 |  +1.2e-2 · 0 |
| sphere/0/13               |       +4.9e-5 · 2 |  +1.6e-7 · 3 |  +1.6e-7 · 3 |
| torus/free/3/6            |       +1.0e-1 · 1 | +9.3e-11 · 3 | +7.0e-11 · 3 |
| boundary/tesseract/cube/9 |       +9.0e-1 · 0 |  +6.7e-2 · 0 | −6.6e-13 · 3 |
| polyhedra/tetintet/6      |       +3.6e-1 · 0 |  +4.2e-2 · 0 |  +3.3e-3 · 1 |
| curved/-1/0/0/7           |      −2.3e-11 · 2 | −2.3e-11 · 3 | −2.3e-11 · 3 |
| curved/-1/3/4/5           |       +3.4e-3 · 1 |  +7.6e-4 · 2 | −3.8e-11 · 3 |
| curved/1/4/4/3            |       +6.6e-5 · 2 | −8.3e-12 · 3 | −8.3e-12 · 3 |

[CALC] Without jitter (seeds 1–4, 20,000 evaluations) every problem ends the same but
polyhedra/tetintet/6, where 3 runs of 4 come within 1e-3 of the record against 1 with the default.
The sample is small, and penalty's larger one favours the jitter on the same problem, so the
default stays 0.1 in both methods.

### The reference kernel: disks in a circle

**P = 2 to 12, defaults, 20,000 evaluations, seeds 1–20:**

|   P | Best known R | Worst relative excess | Runs within 1e-6 (of 20) |
| --: | -----------: | --------------------: | -----------------------: |
|   2 |            2 |                     0 |                       20 |
|   3 |  2.154700538 |               5.4e-14 |                       20 |
|   4 |  2.414213562 |               2.7e-13 |                       20 |
|   5 |  2.701301617 |               5.1e-15 |                       20 |
|   6 |            3 |               3.8e-12 |                       20 |
|   7 |            3 |               4.2e-15 |                       20 |
|   8 |  3.304764871 |               1.4e-14 |                       20 |
|   9 |  3.613125930 |               3.5e-12 |                       20 |
|  10 |  3.813025631 |                2.4e-6 |                        0 |
|  11 |  3.923804400 |                8.5e-7 |                       20 |
|  12 |  4.029601930 |                4.2e-7 |                       20 |

[CALC] Every run is within 1% of the best known radius, and within 2.5e-6 of it. The short squeeze
stops at weight 1e4 and does not polish, so the last digits are left to `penalty`.

**Variants at P = 5, 9, 10, 12, 20 and 30**, 20,000 evaluations, seeds 1–10; the median excess over
the best known radius:

| Variant                                 |   P = 5 |   P = 9 | P = 10 | P = 12 | P = 20 | P = 30 |
| --------------------------------------- | ------: | ------: | -----: | -----: | -----: | -----: |
| Default: squeeze 4, 200 it., jitter 0.1 | 1.1e-15 | 2.2e-13 | 2.4e-6 | 4.2e-7 | 1.0e-6 | 1.6e-4 |
| Relaxation only (`squeeze: 0`)          |  1.5e-1 |  7.8e-2 | 4.9e-2 | 6.3e-3 | 7.5e-2 | 4.1e-2 |
| `squeeze: 2`                            | 2.1e-13 | 5.8e-12 | 2.4e-4 | 4.2e-5 | 8.4e-5 | 1.1e-4 |
| `squeeze: 3`, 30 it.                    | 3.6e-15 |  3.2e-2 | 1.4e-2 | 5.2e-3 | 2.8e-2 | 1.8e-2 |
| 100 it.                                 | 2.4e-15 | 1.7e-13 | 2.4e-6 | 4.2e-7 | 1.0e-6 | 2.8e-3 |
| Random starts only                      | 1.6e-15 | 1.3e-13 | 2.4e-6 | 4.2e-7 | 1.0e-6 | 1.3e-3 |
| Seeds only                              | 8.9e-16 |  1.0e-2 | 2.4e-6 | 4.2e-7 | 1.0e-6 | 1.1e-6 |
| No jitter                               | 1.6e-15 | 4.7e-13 | 2.4e-6 | 4.2e-7 | 1.0e-6 | 5.6e-3 |

[CALC] Without a squeeze the starts stay loose, 0.6% to 15% above the best known radius. With 30
iterations per weight the random starts hardly contract, and only the seeds' layouts count. At
P = 30, 100 iterations or no jitter leave the median at 2.8e-3 and 5.6e-3, against 1.6e-4 for the
default. The seeds alone are the best choice at P = 30 and fall into a worse optimum at P = 9. The
defaults were chosen from these runs, so the table flatters them.

Reproduce with:

```sh
nice -n 10 npx tsx packages/methods/scripts/bench-penalty-seed-real.ts seed 1000,5000,20000 3 all default
nice -n 10 npx tsx packages/methods/scripts/bench-penalty-seed-real.ts seed 20000 4 all jitter0 default
nice -n 10 npx tsx packages/methods/scripts/bench-seed.ts 20000 20 2,3,4,5,6,7,8,9,10,11,12 default
nice -n 10 npx tsx packages/methods/scripts/bench-seed.ts 20000 10 5,9,10,12,20,30 default relax squeeze2 iterations30 iterations100 random seeds jitter0
```

The variants are defined at the top of each script. Runs are reproducible from the seed in one
JavaScript runtime; another Node.js version may round differently and give other runs.

## Limits

- [CALC] Measured on a few problems per space and few seeds. How good a space's seeds are is the
  space's matter.
- A start's squeeze is short, so close local optima (relative gaps near 1e-6) are not told apart
  reliably. Polish the result with `penalty`.
- The seeds can trap their whole share of the starts in one local optimum.
