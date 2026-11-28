<!-- python3 native/tools/fresh/analyze.py <runs.validated.jsonl> --times 1,5,20 for problems-torus.json at 20 CPU s, seeds 1-2; fresh at commit 42d407f; preliminary (a loaded shared machine), see native/fresh-torus/README.md -->
# Fresh solvers benchmark

84 runs, 14 problems, 2 seeds. 14 problems have a reference R (best ts-valid final score of any run).

## Family: torus

### Validity and reaching the targets

| solver | runs | valid | invalid | none | reach 0.01 | median t 0.01 (s) | reach 0.001 | median t 0.001 (s) | reach 0.0001 | median t 0.0001 (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| js | 28 | 28 | 0 | 0 | 6/28 | 1.14 | 6/28 | 6.36 | 6/28 | 6.36 |
| port | 28 | 28 | 0 | 0 | 6/28 | 0.721 | 6/28 | 0.759 | 6/28 | 0.863 |
| fresh | 28 | 28 | 0 | 0 | 28/28 | 0.00833 | 27/28 | 0.00482 | 26/28 | 0.0166 |

(invalid: a packing the validator rejects; none: no packing at all. Runs that reach nothing are censored; the median is over the runs that reach.)

### Speed ratio over (problem, seed) pairs where both reach the target

Geometric mean over the pairs of (time of b) / (time of a): above 1, a is faster.

| a vs b | target | both | only a | only b | neither | geo-mean b/a |
|---|---|---|---|---|---|---|
| fresh vs port | 0.01 | 6 | 22 | 0 | 0 | 403 |
| fresh vs port | 0.001 | 6 | 21 | 0 | 1 | 444 |
| fresh vs port | 0.0001 | 6 | 20 | 0 | 2 | 493 |
| fresh vs js | 0.01 | 6 | 22 | 0 | 0 | 1e+03 |
| fresh vs js | 0.001 | 6 | 21 | 0 | 1 | 1.37e+03 |
| fresh vs js | 0.0001 | 6 | 20 | 0 | 2 | 1.37e+03 |
| port vs js | 0.01 | 6 | 0 | 0 | 22 | 2.49 |
| port vs js | 0.001 | 6 | 0 | 0 | 22 | 3.09 |
| port vs js | 0.0001 | 6 | 0 | 0 | 22 | 2.79 |

### Mean relative gap to R at fixed CPU times

Gap = best valid score found by then / R - 1, over the runs that have a packing by then (n of the valid runs).

| solver | t = 1 s | t = 5 s | t = 20 s |
|---|---|---|---|
| js | - (n=0/28) | 0.434 (n=28/28) | 0.23 (n=28/28) |
| port | 0.594 (n=27/28) | 0.372 (n=28/28) | 0.217 (n=28/28) |
| fresh | 0.000586 (n=28/28) | 0.000377 (n=28/28) | 5.35e-05 (n=28/28) |

## All families

### Validity and reaching the targets

| solver | runs | valid | invalid | none | reach 0.01 | median t 0.01 (s) | reach 0.001 | median t 0.001 (s) | reach 0.0001 | median t 0.0001 (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| js | 28 | 28 | 0 | 0 | 6/28 | 1.14 | 6/28 | 6.36 | 6/28 | 6.36 |
| port | 28 | 28 | 0 | 0 | 6/28 | 0.721 | 6/28 | 0.759 | 6/28 | 0.863 |
| fresh | 28 | 28 | 0 | 0 | 28/28 | 0.00833 | 27/28 | 0.00482 | 26/28 | 0.0166 |

(invalid: a packing the validator rejects; none: no packing at all. Runs that reach nothing are censored; the median is over the runs that reach.)

### Speed ratio over (problem, seed) pairs where both reach the target

Geometric mean over the pairs of (time of b) / (time of a): above 1, a is faster.

| a vs b | target | both | only a | only b | neither | geo-mean b/a |
|---|---|---|---|---|---|---|
| fresh vs port | 0.01 | 6 | 22 | 0 | 0 | 403 |
| fresh vs port | 0.001 | 6 | 21 | 0 | 1 | 444 |
| fresh vs port | 0.0001 | 6 | 20 | 0 | 2 | 493 |
| fresh vs js | 0.01 | 6 | 22 | 0 | 0 | 1e+03 |
| fresh vs js | 0.001 | 6 | 21 | 0 | 1 | 1.37e+03 |
| fresh vs js | 0.0001 | 6 | 20 | 0 | 2 | 1.37e+03 |
| port vs js | 0.01 | 6 | 0 | 0 | 22 | 2.49 |
| port vs js | 0.001 | 6 | 0 | 0 | 22 | 3.09 |
| port vs js | 0.0001 | 6 | 0 | 0 | 22 | 2.79 |

### Mean relative gap to R at fixed CPU times

Gap = best valid score found by then / R - 1, over the runs that have a packing by then (n of the valid runs).

| solver | t = 1 s | t = 5 s | t = 20 s |
|---|---|---|---|
| js | - (n=0/28) | 0.434 (n=28/28) | 0.23 (n=28/28) |
| port | 0.594 (n=27/28) | 0.372 (n=28/28) | 0.217 (n=28/28) |
| fresh | 0.000586 (n=28/28) | 0.000377 (n=28/28) | 5.35e-05 (n=28/28) |

## Runs without a valid packing

None.
