#!/bin/zsh
# chain.sh <piece> <tag> [params-json]: chain.ts for 60 s in pieces, seeds 1 to 3, in parallel.
dir=${0:A:h}
list="0/4/100,3/3/20,6/0/40,4/4/37,5/5/20,3/4/20"
for s in 1 2 3; do
  npx tsx $dir/chain.ts 60 $1 $s $list $3 >> $dir/results/$2.jsonl &
done
wait
