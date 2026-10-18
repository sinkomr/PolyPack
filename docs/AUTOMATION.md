# Unattended batch search

`scripts/batch-search.ts` runs search methods on many problems in parallel and, when asked, submits each problem's best packing to a PolyPack server if it improves on that problem's current leader. It is meant for a machine that is left alone for hours: a local computer, a rented server or a cloud sandbox. Without `--submit` it never sends anything; it only reads the public records.

## Install

Node 24 is what the repository targets (`engines` in `package.json`). [CALC] The batch runner also ran here on Node 22.23 (worker threads, submissions and the unit tests). On Node 22, npm may print an `EBADENGINE` warning about the `engines` field; it is a warning unless npm's `engine-strict` is set. The API server, which is not needed for searching, uses `node:sqlite`: Node 22.23 loads it with an experimental-feature warning.

```
git clone https://github.com/sinkomr/PolyPack.git
cd PolyPack
npm ci
npx tsx scripts/batch-search.ts --help
```

## A pilot, then a populating run

Start with a pilot that submits nothing, to see the throughput and the scores on the machine at hand:

```
npx tsx scripts/batch-search.ts --sample 200 --methods asc,harden --seeds 1 --evals 20000 --time 15 --hours 0.5 --out pilot
```

Then a run that populates the leaderboard. Choose the problem set, the methods and a display name; `--hours` caps the wall-clock time:

```
npx tsx scripts/batch-search.ts --N 0,3,4,5,6,8,12 --M 0,3,4,5,6,8 --P 1-50 --methods asc,harden --seeds 1-3 --evals 20000 --time 15 --hours 8 --submit --base https://polypack.fly.dev --name "my batch" --out run1
```

`--name` is the display name of the entries. An AI agent that runs the batch uses its model name, for example `--name "Claude Haiku 5.5"`. `--note TEXT` adds free text shown with the entries; without it the note stays empty. (`--note-prefix` is the deprecated name of `--note`.)

To keep it running after the terminal closes on a server, start it with `nohup ... > run1.log 2>&1 &` or inside `tmux`/`screen`.

What it does:

1. Reads `GET /api/records?N=&M=` once per (N, M) pair of the problem set: closed problems (proven optimum) are skipped without searching; published values and site leaders decide the order. The default order, `missing-first`, takes problems with neither a site leader nor a published value first, then those whose site leader is missing or worse than the published value, then the rest; smaller P first within each group.
2. Runs every method with every seed on each problem, one search per worker thread. `--workers` defaults to `os.availableParallelism()`; the first line printed shows it with `os.cpus().length`, the memory and the Node version. Each worker holds one search; in a test with 4 workers on problems of up to 14 pieces the whole process stayed near 300 MB.
3. After the last run of a problem, re-reads that problem's leader and submits the best valid packing only if it is better than the leader by more than the tie tolerance (`score < leader * (1 - 1e-9)`; an equal score never replaces the earlier entry). Each entry records how it was found in its own fields: `found_with: "optimizer"`, the `method`, its resolved parameters (`method_params`), the `seed` and the `budget`. The site shows only "PolyPack optimizer" with the entry; the full record is at `GET /api/submissions/{id}`. The deprecated `agent` field is no longer sent.
4. Prints a progress line every 60 s (runs, problems, submissions sent/accepted/leading, runs per minute, ETA and how often each method produced its problem's best) and a per-method summary at the end: runs, median ratio of score to published value where one exists, number of problem bests, median wall time.

When `--hours` is reached no new run is started; runs in flight finish within their `--time`, and problems left part-way are still submitted. Ctrl-C (SIGINT) or SIGTERM aborts the runs in flight within about 5 s, prints the summary and exits with code 0 without submitting further; a second signal exits at once.

## Output and resume

The output directory (`--out`, default `./batch-out`) holds:

- `runs.jsonl`: one JSON line per finished run (`"type": "run"`: problem, method, seed, budget, score, validity, evaluations, wall time, termination, published value and ratio), and one line per submission decision (`"type": "submission"`: the run that produced the best, whether it was sent, the HTTP status, `leader`, the server's score and the leader's score, or why it was not sent).
- `best/N-M-P.json`: the best packing found for each problem, across all invocations, with the method, its resolved parameters (`params`; absent in files written by earlier versions, whose submissions then leave `method_params` out), seed and budget that found it.

Running the same command again resumes: runs whose (problem, method, seed, budget) are already in `runs.jsonl` are skipped, and the best of each finished problem is submitted if it still improves on the leader (so a submission lost to an interruption is sent later, and one already leading is not sent twice). A run interrupted by a signal is not recorded and runs again. Changing `--evals` or `--time` makes new experiments.

## Sawteeth and free improvements

Quick first searches leave a sawtooth in each family's records: just past a number that packs well (a perfect square of squares, say), the easy answer is the next regular arrangement, so the container jumps up and only slowly comes down again. `--order teeth` searches the deepest teeth first, those whose site record is least dense against their neighbours' (only problems with a site leader and no published value are rated), and `--top K` keeps the first K:

```sh
npx tsx scripts/batch-search.ts --N 0,3-12 --M 0,3-12 --P 1-500 --order teeth --top 2000 --methods asc,harden --seeds 1-3 --time 120 --submit --name "<model name>"
```

A record can never be worse than one for more pieces: removing pieces from a packing of Q > P leaves a packing of P in a container no larger. `scripts/trim-down.ts` finds every such case and submits the trimmed packing (found_with "external", with the donor named in `software`); without `--submit` it only reports:

```sh
npx tsx scripts/trim-down.ts --N 0,3-20 --M 0,3-20
```

## The rate limit

The server accepts 120 submissions per minute per address. The script keeps all its workers together at or below 25 per minute; on HTTP 429 it waits 65 s and tries again (at most three times), on 409 it marks the problem closed, and network errors are retried with backoff up to 60 s without stopping the batch. Several copies of the script behind one address share the server's limit but not the script's pacing, so on one machine run one copy and use `--workers` for parallelism. Cloud sandboxes may also share an address: a few dozen sessions on problems of a hundred pieces or more stay well under the limit, but many sessions on very small problems may not.

## Choosing methods

`--methods` takes any registered method except `identity` and `polish`, which need a starting configuration; `--list-methods` lists them. The default is `asc,harden`.

[CALC] Small-sample evidence only: in one trial of about 8 runs per method at 15 s each, soft-to-rigid hardening (`harden`) and the adaptive shrinking container (`asc`) had the smallest median gaps to the published values, 0.06% and 0.75%, and `asc` was the fastest. That trial is too small to rank the methods in general; the summary table of a pilot on the problems you care about is better evidence. Several seeds per method help on harder problems more than a longer budget for one seed, but that too is [SPEC] until measured.

## Costs

The cost is CPU time. Each search uses one core for up to `--time` seconds, so a run of `problems x methods x seeds` searches needs about that many times `--time` core-seconds (less when runs finish early on their evaluation budget). For example 2,000 problems with 2 methods and 3 seeds at 15 s is 50 core-hours: about 6 hours on 8 cores. Memory stays modest (the best packing of each active problem, plus one search per worker), and the network traffic is a few requests per problem.

## In a Claude Managed Agents sandbox

`deploy/managed-agent/run.sh` runs this script in an Anthropic-hosted cloud sandbox (Managed Agents, beta), supervised by a small model that only starts the job and checks on it. It needs `ANTHROPIC_API_KEY` in the environment, `jq`, and, while the repository is private, a read-only GitHub token for it in `~/.polypack/github-token` (otherwise it asks for one). The sandbox may reach only this site, GitHub and the npm registry, and the session has a hard spending cap in US cents:

```sh
./deploy/managed-agent/run.sh start phase1a 1000 '--N 0,3-5 --M 0,3-12 --P 1-100 --skip-existing --order smallest-first --methods harden,asc --seeds 1-2 --hours 12 --submit --name "Claude Haiku 5.5"'
./deploy/managed-agent/run.sh status
./deploy/managed-agent/run.sh watch phase1a
./deploy/managed-agent/run.sh fetch phase1a
./deploy/managed-agent/run.sh delete phase1a
```

Each session gets a short name. Several can run at once on different slices of the problems; `--skip-existing` keeps them from repeating problems that already have an entry. `status` without a name lists every session with its hours and cost.

`fetch` downloads `run.log`, `runs.jsonl` and the best configurations into `~/.polypack/managed/outputs-<name>/`. `delete` removes the sandbox and its files. The number of cores a sandbox has is not documented; the job reports it in its first lines.
