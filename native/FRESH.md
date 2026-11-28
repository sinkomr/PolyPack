# Fresh solvers: a from-scratch Rust search against the port and the JavaScript

Research branch `research/fresh-solvers`. Question: does a Rust search written from scratch, for speed, reach
a given packing quality in less CPU time than the line-by-line port (`native/<kind>`, `native/client`) and the
JavaScript (`packages/*`, `apps/volunteer`), while every packing it reports is valid? Trajectories need not
match the old searches; only validity and time-to-quality count.

## The families benchmarked

| family | ids | pieces and containers | solver |
|---|---|---|---|
| flat | `flat/<N>/<M>/<P>` | N in {0, 3..8} (0 = disk), M in {0, 3, 4, 5, 6, 8} (0 = circle), P 5..40 | `fresh-flat` |
| curved | `curved/<K>/0/<M>/<P>` | disks at curvature K = -1 or 1, containers of the catalogue, P 5..30 | `fresh-round` |
| sphere | `sphere/0/<P>` | disks on the sphere, P 5..80 | `fresh-round` |
| balls | `balls/ballin<container>/<P>` | balls in a ball or one of the catalogue's solids, P 5..60 | `fresh-balls` |

Only problems that exist in the catalogues and accept submissions are drawn (the harness draws them, seeded).

## The contract every solver binary follows

    <binary> --id ID --seconds S --seed K [--evals E]

- One thread. The clock is this thread's CPU time (`polypack_flat::clock::thread_cpu_seconds`). Stop when it
  reaches S (overshoot at most about 0.2 s). With `--evals E`, also stop after E evaluations, so that a run is
  reproducible: the same id, seed and E give the same output.
- From scratch: no start configuration, no memory, no network.
- Prints one JSON line on stdout:

      {"solver": "...", "id": ID, "seed": K, "seconds": S, "clock": "cpu",
       "score": number|null, "config": object|null, "evaluations": integer,
       "check_valid": true|false|null,
       "trace": [{"t": cpu_seconds, "best": score}, ...]}

  - `config` is the best valid packing, in the submission format: flat
    `{"N", "M", "P", "container_phi", "pieces": [{"x", "y", "theta"}]}`; a space its own configuration
    (as POST /api/spaces/submit takes it in `config`).
  - `score` is the score the check below computes for it.
  - `trace` gets one entry each time the best valid score improves: `t` is the CPU time at which that packing
    was found and checked, `best` its score. Only checked packings enter the trace.

## Valid

The check is the one the native client applies before it submits:

- flat: `polypack_flat::validate::server_check(&config, P)` with `valid && strict`; the score is its `score`.
- spaces: `polypack_spaces::validate_space_submission(space, id, &config, &SpaceValidateOptions::default())`
  with `valid`; the score is its `score`.

The harness checks every final packing again with the server's TypeScript validators, which are authoritative.

## From scratch

A fresh solver's search is new code: its own representation, overlap and distance computations, objective,
optimiser and schedule. It does not port or call the existing searches (`packages/solver`,
`packages/*/src/search*`, `native/*/src/{search,auto,methods,penalty,...}.rs`). It may read the problem
definitions and conventions (shapes, containers, units, scores, the curved and sphere geometry), and it calls the
check above on candidates, but not inside its inner loop.
