# Fresh solvers benchmark: the wide flat set

`problems-flat-wide.json`, 20 CPU seconds, seeds 1 and 2, one run at a time on a shared 4-core Linux container
(2026-11-28; preliminary). The port and JavaScript runs are from one session, the fresh runs from a second one an
hour later. Per-problem numbers: `native/fresh-flat/README.md`.

96 runs, 16 problems, 2 seeds. 16 problems have a reference R (best ts-valid final score of any run).

## Family: flat

### Validity and reaching the targets

| solver | runs | valid | invalid | none | reach 0.01 | median t 0.01 (s) | reach 0.001 | median t 0.001 (s) | reach 0.0001 | median t 0.0001 (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| js | 32 | 32 | 0 | 0 | 20/32 | 3.88 | 15/32 | 3.12 | 13/32 | 6.04 |
| port | 32 | 32 | 0 | 0 | 32/32 | 0.729 | 22/32 | 0.979 | 19/32 | 1 |
| fresh | 32 | 32 | 0 | 0 | 32/32 | 0.301 | 29/32 | 0.342 | 27/32 | 0.342 |

(invalid: a packing the validator rejects; none: no packing at all. Runs that reach nothing are censored; the median is over the runs that reach.)

### Speed ratio over (problem, seed) pairs where both reach the target

Geometric mean over the pairs of (time of b) / (time of a): above 1, a is faster.

| a vs b | target | both | only a | only b | neither | geo-mean b/a |
|---|---|---|---|---|---|---|
| fresh vs port | 0.01 | 32 | 0 | 0 | 0 | 4.44 |
| fresh vs port | 0.001 | 22 | 7 | 0 | 3 | 7.95 |
| fresh vs port | 0.0001 | 19 | 8 | 0 | 5 | 10.1 |
| fresh vs js | 0.01 | 20 | 12 | 0 | 0 | 32.9 |
| fresh vs js | 0.001 | 15 | 14 | 0 | 3 | 51.3 |
| fresh vs js | 0.0001 | 13 | 14 | 0 | 5 | 75.5 |
| port vs js | 0.01 | 20 | 12 | 0 | 0 | 5.59 |
| port vs js | 0.001 | 15 | 7 | 0 | 10 | 4.89 |
| port vs js | 0.0001 | 13 | 6 | 0 | 13 | 5.07 |

### Mean relative gap to R at fixed CPU times

Gap = best valid score found by then / R - 1, over the runs that have a packing by then (n of the valid runs).

| solver | t = 1 s | t = 5 s | t = 20 s |
|---|---|---|---|
| js | - (n=0/32) | 0.00515 (n=14/32) | 0.00713 (n=32/32) |
| port | 0.0151 (n=32/32) | 0.00289 (n=32/32) | 0.00144 (n=32/32) |
| fresh | 0.00542 (n=32/32) | 0.00195 (n=32/32) | 0.000329 (n=32/32) |

## All families

### Validity and reaching the targets

| solver | runs | valid | invalid | none | reach 0.01 | median t 0.01 (s) | reach 0.001 | median t 0.001 (s) | reach 0.0001 | median t 0.0001 (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| js | 32 | 32 | 0 | 0 | 20/32 | 3.88 | 15/32 | 3.12 | 13/32 | 6.04 |
| port | 32 | 32 | 0 | 0 | 32/32 | 0.729 | 22/32 | 0.979 | 19/32 | 1 |
| fresh | 32 | 32 | 0 | 0 | 32/32 | 0.301 | 29/32 | 0.342 | 27/32 | 0.342 |

(invalid: a packing the validator rejects; none: no packing at all. Runs that reach nothing are censored; the median is over the runs that reach.)

### Speed ratio over (problem, seed) pairs where both reach the target

Geometric mean over the pairs of (time of b) / (time of a): above 1, a is faster.

| a vs b | target | both | only a | only b | neither | geo-mean b/a |
|---|---|---|---|---|---|---|
| fresh vs port | 0.01 | 32 | 0 | 0 | 0 | 4.44 |
| fresh vs port | 0.001 | 22 | 7 | 0 | 3 | 7.95 |
| fresh vs port | 0.0001 | 19 | 8 | 0 | 5 | 10.1 |
| fresh vs js | 0.01 | 20 | 12 | 0 | 0 | 32.9 |
| fresh vs js | 0.001 | 15 | 14 | 0 | 3 | 51.3 |
| fresh vs js | 0.0001 | 13 | 14 | 0 | 5 | 75.5 |
| port vs js | 0.01 | 20 | 12 | 0 | 0 | 5.59 |
| port vs js | 0.001 | 15 | 7 | 0 | 10 | 4.89 |
| port vs js | 0.0001 | 13 | 6 | 0 | 13 | 5.07 |

### Mean relative gap to R at fixed CPU times

Gap = best valid score found by then / R - 1, over the runs that have a packing by then (n of the valid runs).

| solver | t = 1 s | t = 5 s | t = 20 s |
|---|---|---|---|
| js | - (n=0/32) | 0.00515 (n=14/32) | 0.00713 (n=32/32) |
| port | 0.0151 (n=32/32) | 0.00289 (n=32/32) | 0.00144 (n=32/32) |
| fresh | 0.00542 (n=32/32) | 0.00195 (n=32/32) | 0.000329 (n=32/32) |

## Runs without a valid packing

None.
