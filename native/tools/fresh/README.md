# Fresh solvers benchmark harness

Runs three solvers on the same seeded random problems, one thread each, with CPU-time clocks, re-checks every
final packing with the server's TypeScript validators and reports time-to-quality. The experiment and the
contract every solver follows are in `native/FRESH.md`.

| solver | what runs | command (from the repository root) |
|---|---|---|
| `js` | the JavaScript volunteer client's search, one lane | `node_modules/.bin/tsx native/tools/fresh/js-flat.mts --id flat/3/4/8 --seconds 20 --seed 1` (flat); `js-space.mts --id sphere/0/30 ...` (curved, sphere, balls) |
| `port` | the Rust port in the native client, one lane | `native/target/release/polypack-native bench --N 3 --M 4 --P 8 --seconds 20 --seed 1` (flat); `polypack-native bench-space --id sphere/0/30 --seconds 20 --seed 1` (the rest) |
| `fresh` | the from-scratch binaries | `native/target/release/fresh-flat`, `fresh-round` (curved and sphere), `fresh-balls`, each `--id ID --seconds S --seed K` |

Each prints one JSON line (the contract: solver, id, seed, score, config, evaluations, check_valid, trace of
best-so-far improvements with CPU time). `run.py` turns the port's flat `bench` output into the same shape.

## Commands

    export PATH="$HOME/.cargo/bin:$PATH"
    npm ci --prefer-offline --no-audit --no-fund
    (cd native && cargo build --release -p polypack-native -p polypack-fresh-flat -p polypack-fresh-round -p polypack-fresh-balls)

    npx tsx native/tools/fresh/draw.mts
    python3 native/tools/fresh/run.py --seconds 60 --concurrency 5 --out native/tools/fresh/runs.jsonl
    npx tsx native/tools/fresh/validate.mts native/tools/fresh/runs.jsonl native/tools/fresh/runs.validated.jsonl
    python3 native/tools/fresh/analyze.py native/tools/fresh/runs.validated.jsonl > native/tools/fresh/report.md

- `draw.mts` writes `problems.json` (seed 20261121): 10 flat, 8 curved (K = -1 or 1, disks), 6 sphere, 8 balls
  (ball pieces), only problems that exist and accept submissions (flat: not closed by the literature, as
  `POST /api/submit` decides; spaces: `problemOf` and `acceptsSubmissions`, as `POST /api/spaces/submit`).
  A curved problem is kept only if the native client's search finds a packing of it in 2 CPU seconds (the domain's area
  bound cannot tell that a small hyperbolic or spherical container holds fewer disks); the screen skips problems the port
  cannot start on, so build `polypack-native` first (`--no-screen` skips it). `--seed` and `--out` are options.
- `draw-flat-wide.mts` writes `problems-flat-wide.json` (seed 20261128): 16 flat problems with many-sided pieces
  or containers (5 with N >= 17 and M <= 8, 5 with M >= 9 and N <= 16, 3 with both, 3 with N in 9..16 and
  M <= 8; P in 5..50 with probability 0.8, else 51..120), only problems that accept submissions. Run it with
  `run.py --problems native/tools/fresh/problems-flat-wide.json --solvers js,port,fresh`.
- `run.py` runs problem x solver x seed (seeds 1, 2, 3; solvers `--solvers js,port,fresh`), shuffled with a fixed
  seed, `--concurrency` at once (default 5), a per-run wall `--timeout` (default 2 x seconds + 60 s). It appends one
  JSON line per run (exit code, wall time, stderr tail on failure, the result) and skips runs already in the file,
  so an interrupted run resumes by running the same command (`--retry-failed` repeats failed ones).
- `validate.mts` adds `ts_valid`, `ts_score`, `ts_score_match` (the reported score within the tie tolerance 1e-9) and
  `ts_strict` (flat: the shrink test) from the server's validators. Flat: `parseConfig` + `evaluate`
  (`POST /api/submit`); spaces: `validateSpaceSubmission` with the default options (`POST /api/spaces/submit`).
- `analyze.py` prints the markdown report: validity counts, runs reaching R(1+eps) for eps 1e-2, 1e-3, 1e-4, medians,
  geometric-mean speed ratios, mean relative gap to R at 5, 15 and 60 s (`--eps`, `--times` change them).

## One problem, quickly (solver authors)

    python3 native/tools/fresh/run.py --only sphere/0/30 --solvers port,js --seeds 1 --seconds 20 --out /tmp/one.jsonl
    npx tsx native/tools/fresh/validate.mts /tmp/one.jsonl /tmp/one.v.jsonl
    python3 native/tools/fresh/analyze.py /tmp/one.v.jsonl

Add `fresh` to `--solvers` to include your binary; use a fresh `--out` file, since finished runs are skipped.
The reference R of a single problem is the best of the runs you give it, so include `port,js` for a meaningful table.
A problem id of the right shape that is not in `problems.json` works too (`--only flat/5/6/20`).

## Fairness notes

- All clocks are CPU time. `fresh` and `port` flat use the calling thread's CPU time. `port bench-space`
  uses the process's CPU time (its space jobs run on worker threads); the jobs' own deadlines are wall-clock, as in
  the client, so on a loaded machine a job gets less CPU than its budget (keep the machine quiet; at most 5
  runs at once on six performance cores). `js` replaces `performance.now` with the process's CPU time (user +
  system, including the garbage collector's threads), as `native/tools/js-bench.mts` does.
- `js` and `port` run the client's own engine: one lane, no memory, no known packing, no server. The engine stops
  when its budget is spent, or earlier on its own stagnation rule (a quarter of the budget without an improvement),
  or when it reports "no start". The result records `stopped`.
- Trace times of `js` and `port` are the CPU time at which a finished job was seen to improve the best, so
  they are coarse (a job takes up to a quarter of the budget); `fresh` records the time of each improvement. This
  favours `fresh` in time-to-target by up to one job length; the analysis reports the same trace for all.
- Space searches use the default rule (no bound, not certified, noRecord false) in every solver and in the
  validator; the server also asks for the strict check on problems without a research record, which the harness does not.
- A flat packing counts as valid for the check the client applies (`valid && strict`); `validate.mts` reports
  `ts_valid` (the server's `evaluate`) and `ts_strict` separately, and `analyze.py` uses `ts_valid`.
