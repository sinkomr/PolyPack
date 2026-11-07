#!/bin/zsh
# run.sh <tag> <budget> <shards> [extra bench args...]: runs the shards in parallel and waits.
dir=${0:A:h}
tag=$1; budget=$2; shards=$3; shift 3
rm -f $dir/results/$tag-$budget.jsonl
for s in $(seq 0 $((shards - 1))); do
  npx tsx $dir/bench.ts --budget $budget --tag $tag --shard $s/$shards "$@" > $dir/results/$tag-$budget.shard$s.log 2>&1 &
done
wait
echo done $tag $budget
