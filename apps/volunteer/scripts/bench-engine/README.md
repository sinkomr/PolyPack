# Volunteer engine benchmark (flat 2D)

The quality of the volunteer engine (`apps/volunteer/src/engine`) at a fixed CPU budget, on the
24 flat problems of `panel.json` (10 disks in a circle to 150 squares in a square) and the 9
polygon problems of `warm.json`, which start from the site's leader. The gap of a run is its
score over the reference (the better of the literature and the site's best) less one, in percent.
The clock is CPU time (process CPU for one lane, each thread's own CPU for several), so results
hold on a loaded machine. The numbers in `policy.ts` that cite this folder come from these files.

```
npx tsx apps/volunteer/scripts/bench-engine/bench.ts --budget 60 --seeds 1,2,3 --tag v5 --shard 0/4
zsh apps/volunteer/scripts/bench-engine/run.sh v5 60 4
python3 apps/volunteer/scripts/bench-engine/analyze.py base-60 v5-60
```

`--engine base` runs the engine as it was before the change, from `base-engine/` (not tracked):

```
mkdir -p apps/volunteer/scripts/bench-engine/base-engine
git archive bd4c33a apps/volunteer/src/engine apps/volunteer/src/types.ts | tar -x --strip-components=3 -C apps/volunteer/scripts/bench-engine/base-engine
```

## Results

One JSON line per problem and seed: final score, gap, the anytime trace (CPU seconds, best) and
the job log. The file name is the tag and the budget in seconds per lane.

| Tag                             | Engine                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `base`                          | before the change (bd4c33a)                                                                                    |
| `v5`                            | the committed engine                                                                                           |
| `v4`                            | the committed engine with jobs of at most a sixth of the budget (`capShare` 1/6)                               |
| `v1`–`v3`, `warmv2`–`warmv4`    | earlier drafts of the change, kept for the record; not reproducible from the repository                        |
| `sr`                            | `shrink_repair` alone, one run for the whole budget                                                            |
| `chain4`, `chain10`, `chain4lo` | `shrink_repair` chained from the best in runs of 4.5 s and 10 s (`chain.ts`); `lo` with a smaller shrink ratio |
| `mlbase`, `mlv5`                | 4 lanes × 90 s, 12 problems, seeds 1 and 2                                                                     |
| `nsbase`, `nsv5`                | 60 s on 9 problems after the faster flat solver of #76                                                         |
| `warmbase`, `warmv5`            | 60 s from the site's leader (`warm.json`)                                                                      |
