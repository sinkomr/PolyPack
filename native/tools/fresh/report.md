# Fresh solvers benchmark

288 runs, 32 problems, 3 seeds. 32 problems have a reference R (best ts-valid final score of any run).

## Family: flat

### Validity and reaching the targets

| solver | runs | valid | invalid | none | reach 0.01 | median t 0.01 (s) | reach 0.001 | median t 0.001 (s) | reach 0.0001 | median t 0.0001 (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| js | 30 | 30 | 0 | 0 | 30/30 | 5.39 | 24/30 | 6.08 | 19/30 | 6.08 |
| port | 30 | 30 | 0 | 0 | 30/30 | 1.21 | 28/30 | 1.27 | 20/30 | 1.21 |
| fresh | 30 | 30 | 0 | 0 | 30/30 | 0.256 | 30/30 | 0.517 | 28/30 | 0.555 |

(invalid: a packing the validator rejects; none: no packing at all. Runs that reach nothing are censored; the median is over the runs that reach.)

### Speed ratio over (problem, seed) pairs where both reach the target

Geometric mean over the pairs of (time of b) / (time of a): above 1, a is faster.

| a vs b | target | both | only a | only b | neither | geo-mean b/a |
|---|---|---|---|---|---|---|
| fresh vs port | 0.01 | 30 | 0 | 0 | 0 | 7.33 |
| fresh vs port | 0.001 | 28 | 2 | 0 | 0 | 6.17 |
| fresh vs port | 0.0001 | 20 | 8 | 0 | 2 | 9.92 |
| fresh vs js | 0.01 | 30 | 0 | 0 | 0 | 26 |
| fresh vs js | 0.001 | 24 | 6 | 0 | 0 | 28.7 |
| fresh vs js | 0.0001 | 19 | 9 | 0 | 2 | 49 |
| port vs js | 0.01 | 30 | 0 | 0 | 0 | 3.54 |
| port vs js | 0.001 | 23 | 5 | 1 | 1 | 5.33 |
| port vs js | 0.0001 | 18 | 2 | 1 | 9 | 5.06 |

### Mean relative gap to R at fixed CPU times

Gap = best valid score found by then / R - 1, over the runs that have a packing by then (n of the valid runs).

| solver | t = 5 s | t = 15 s | t = 60 s |
|---|---|---|---|
| js | 0.00457 (n=18/30) | 0.00199 (n=30/30) | 0.000569 (n=30/30) |
| port | 0.000981 (n=30/30) | 0.000761 (n=30/30) | 0.000203 (n=30/30) |
| fresh | 0.000975 (n=30/30) | 0.000342 (n=30/30) | 1.24e-05 (n=30/30) |

## Family: curved

### Validity and reaching the targets

| solver | runs | valid | invalid | none | reach 0.01 | median t 0.01 (s) | reach 0.001 | median t 0.001 (s) | reach 0.0001 | median t 0.0001 (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| js | 24 | 24 | 0 | 0 | 24/24 | 3.01 | 24/24 | 3.01 | 24/24 | 3.01 |
| port | 24 | 24 | 0 | 0 | 24/24 | 2.76 | 24/24 | 2.76 | 24/24 | 2.76 |
| fresh | 24 | 24 | 0 | 0 | 24/24 | 0.001 | 24/24 | 0.00127 | 24/24 | 0.00127 |

(invalid: a packing the validator rejects; none: no packing at all. Runs that reach nothing are censored; the median is over the runs that reach.)

### Speed ratio over (problem, seed) pairs where both reach the target

Geometric mean over the pairs of (time of b) / (time of a): above 1, a is faster.

| a vs b | target | both | only a | only b | neither | geo-mean b/a |
|---|---|---|---|---|---|---|
| fresh vs port | 0.01 | 24 | 0 | 0 | 0 | 1.22e+03 |
| fresh vs port | 0.001 | 24 | 0 | 0 | 0 | 1.08e+03 |
| fresh vs port | 0.0001 | 24 | 0 | 0 | 0 | 1.01e+03 |
| fresh vs js | 0.01 | 24 | 0 | 0 | 0 | 1.65e+03 |
| fresh vs js | 0.001 | 24 | 0 | 0 | 0 | 1.65e+03 |
| fresh vs js | 0.0001 | 24 | 0 | 0 | 0 | 1.7e+03 |
| port vs js | 0.01 | 24 | 0 | 0 | 0 | 1.35 |
| port vs js | 0.001 | 24 | 0 | 0 | 0 | 1.53 |
| port vs js | 0.0001 | 24 | 0 | 0 | 0 | 1.7 |

### Mean relative gap to R at fixed CPU times

Gap = best valid score found by then / R - 1, over the runs that have a packing by then (n of the valid runs).

| solver | t = 5 s | t = 15 s | t = 60 s |
|---|---|---|---|
| js | 0.00349 (n=24/24) | 2.64e-05 (n=24/24) | 8.06e-13 (n=24/24) |
| port | 7.85e-13 (n=24/24) | 7.85e-13 (n=24/24) | 7.85e-13 (n=24/24) |
| fresh | 6.6e-13 (n=24/24) | 5.01e-13 (n=24/24) | 1.38e-13 (n=24/24) |

## Family: sphere

### Validity and reaching the targets

| solver | runs | valid | invalid | none | reach 0.01 | median t 0.01 (s) | reach 0.001 | median t 0.001 (s) | reach 0.0001 | median t 0.0001 (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| js | 18 | 18 | 0 | 0 | 16/18 | 17.5 | 3/18 | 43.7 | 0/18 | - |
| port | 18 | 18 | 0 | 0 | 18/18 | 7.35 | 9/18 | 28.8 | 2/18 | 30.5 |
| fresh | 18 | 18 | 0 | 0 | 18/18 | 0.0914 | 18/18 | 0.252 | 18/18 | 0.354 |

(invalid: a packing the validator rejects; none: no packing at all. Runs that reach nothing are censored; the median is over the runs that reach.)

### Speed ratio over (problem, seed) pairs where both reach the target

Geometric mean over the pairs of (time of b) / (time of a): above 1, a is faster.

| a vs b | target | both | only a | only b | neither | geo-mean b/a |
|---|---|---|---|---|---|---|
| fresh vs port | 0.01 | 18 | 0 | 0 | 0 | 70.1 |
| fresh vs port | 0.001 | 9 | 9 | 0 | 0 | 227 |
| fresh vs port | 0.0001 | 2 | 16 | 0 | 0 | 182 |
| fresh vs js | 0.01 | 16 | 2 | 0 | 0 | 152 |
| fresh vs js | 0.001 | 3 | 15 | 0 | 0 | 506 |
| fresh vs js | 0.0001 | 0 | 18 | 0 | 0 | - |
| port vs js | 0.01 | 16 | 2 | 0 | 0 | 2.27 |
| port vs js | 0.001 | 3 | 6 | 0 | 9 | 1.35 |
| port vs js | 0.0001 | 0 | 2 | 0 | 16 | - |

### Mean relative gap to R at fixed CPU times

Gap = best valid score found by then / R - 1, over the runs that have a packing by then (n of the valid runs).

| solver | t = 5 s | t = 15 s | t = 60 s |
|---|---|---|---|
| js | 0.0147 (n=18/18) | 0.0107 (n=18/18) | 0.00498 (n=18/18) |
| port | 0.0111 (n=18/18) | 0.00675 (n=18/18) | 0.00175 (n=18/18) |
| fresh | 2.96e-16 (n=18/18) | 2.96e-16 (n=18/18) | 2.96e-16 (n=18/18) |

## Family: balls

### Validity and reaching the targets

| solver | runs | valid | invalid | none | reach 0.01 | median t 0.01 (s) | reach 0.001 | median t 0.001 (s) | reach 0.0001 | median t 0.0001 (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| js | 24 | 24 | 0 | 0 | 21/24 | 3 | 13/24 | 3 | 10/24 | 3 |
| port | 24 | 24 | 0 | 0 | 22/24 | 1.87 | 13/24 | 2.63 | 12/24 | 2.26 |
| fresh | 24 | 24 | 0 | 0 | 24/24 | 0.0345 | 24/24 | 0.7 | 24/24 | 0.722 |

(invalid: a packing the validator rejects; none: no packing at all. Runs that reach nothing are censored; the median is over the runs that reach.)

### Speed ratio over (problem, seed) pairs where both reach the target

Geometric mean over the pairs of (time of b) / (time of a): above 1, a is faster.

| a vs b | target | both | only a | only b | neither | geo-mean b/a |
|---|---|---|---|---|---|---|
| fresh vs port | 0.01 | 22 | 2 | 0 | 0 | 62.1 |
| fresh vs port | 0.001 | 13 | 11 | 0 | 0 | 47.1 |
| fresh vs port | 0.0001 | 12 | 12 | 0 | 0 | 47.1 |
| fresh vs js | 0.01 | 21 | 3 | 0 | 0 | 89.3 |
| fresh vs js | 0.001 | 13 | 11 | 0 | 0 | 89 |
| fresh vs js | 0.0001 | 10 | 14 | 0 | 0 | 123 |
| port vs js | 0.01 | 21 | 1 | 0 | 2 | 1.46 |
| port vs js | 0.001 | 11 | 2 | 2 | 9 | 1.98 |
| port vs js | 0.0001 | 9 | 3 | 1 | 11 | 1.98 |

### Mean relative gap to R at fixed CPU times

Gap = best valid score found by then / R - 1, over the runs that have a packing by then (n of the valid runs).

| solver | t = 5 s | t = 15 s | t = 60 s |
|---|---|---|---|
| js | 0.00818 (n=24/24) | 0.00494 (n=24/24) | 0.00224 (n=24/24) |
| port | 0.00597 (n=24/24) | 0.00517 (n=24/24) | 0.00228 (n=24/24) |
| fresh | 0.000167 (n=24/24) | 4.16e-05 (n=24/24) | 3.56e-07 (n=24/24) |

## All families

### Validity and reaching the targets

| solver | runs | valid | invalid | none | reach 0.01 | median t 0.01 (s) | reach 0.001 | median t 0.001 (s) | reach 0.0001 | median t 0.0001 (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| js | 96 | 96 | 0 | 0 | 91/96 | 3.01 | 64/96 | 3.01 | 53/96 | 3.01 |
| port | 96 | 96 | 0 | 0 | 94/96 | 1.87 | 74/96 | 2.5 | 58/96 | 1.92 |
| fresh | 96 | 96 | 0 | 0 | 96/96 | 0.0498 | 96/96 | 0.153 | 94/96 | 0.147 |

(invalid: a packing the validator rejects; none: no packing at all. Runs that reach nothing are censored; the median is over the runs that reach.)

### Speed ratio over (problem, seed) pairs where both reach the target

Geometric mean over the pairs of (time of b) / (time of a): above 1, a is faster.

| a vs b | target | both | only a | only b | neither | geo-mean b/a |
|---|---|---|---|---|---|---|
| fresh vs port | 0.01 | 94 | 2 | 0 | 0 | 68.7 |
| fresh vs port | 0.001 | 74 | 22 | 0 | 0 | 73 |
| fresh vs port | 0.0001 | 58 | 36 | 0 | 2 | 102 |
| fresh vs js | 0.01 | 91 | 5 | 0 | 0 | 141 |
| fresh vs js | 0.001 | 64 | 32 | 0 | 0 | 189 |
| fresh vs js | 0.0001 | 53 | 41 | 0 | 2 | 291 |
| port vs js | 0.01 | 91 | 3 | 0 | 2 | 2.07 |
| port vs js | 0.001 | 61 | 13 | 3 | 19 | 2.55 |
| port vs js | 0.0001 | 51 | 7 | 2 | 36 | 2.56 |

### Mean relative gap to R at fixed CPU times

Gap = best valid score found by then / R - 1, over the runs that have a packing by then (n of the valid runs).

| solver | t = 5 s | t = 15 s | t = 60 s |
|---|---|---|---|
| js | 0.00747 (n=84/96) | 0.00388 (n=96/96) | 0.00167 (n=96/96) |
| port | 0.00387 (n=96/96) | 0.0028 (n=96/96) | 0.000962 (n=96/96) |
| fresh | 0.000346 (n=96/96) | 0.000117 (n=96/96) | 3.95e-06 (n=96/96) |

## Runs without a valid packing

None.
