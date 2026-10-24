#!/bin/zsh
# Rebuilds data/surface/records.json, the certificate bundles, docs/spaces/SURFACE_RESULTS.md and
# packages/surface/viz/index.html from cached inputs.
#
# Usage: packages/surface/scripts/build-tables.sh WORK_DIR API_DIR SEARCH.jsonl [SEARCH.jsonl ...]
#   WORK_DIR  scratch directory for intermediate files
#   API_DIR   cached read-only GETs of https://polypack.fly.dev/api/atlas (atlas_<N>_<M>.json)
#   SEARCH    fold search results (packages/surface/scripts/search.ts or polish.ts output)
set -e
setopt null_glob
WORK=$1
API=$2
shift 2
REPO=${0:A:h:h:h:h}
PY=${PYTHON:-python3}
cd $REPO
mkdir -p $WORK/certs data/surface/certificates
rm -f $WORK/certs/*.json
npx tsx packages/surface/scripts/build-nofold.ts $API $WORK/nofold.json
npx tsx packages/surface/scripts/build-exact.ts $WORK/exact.json
npx tsx packages/surface/scripts/build-replicas.ts $WORK/replicas.json "$@"
$PY python/surface/tables.py candidates $WORK/nofold.json $WORK/exact.json $WORK/candidates.json "$@" --extra $WORK/replicas.json
$PY python/surface/run_cert.py $WORK/candidates.json $WORK/certified.json --certdir $WORK/certs --cache $WORK/cert_cache.jsonl
$PY python/surface/tables.py subsets $WORK/subsets.json $WORK/certified.json
$PY python/surface/run_cert.py $WORK/subsets.json $WORK/certified_subsets.json --certdir $WORK/certs --cache $WORK/cert_cache.jsonl
rm -f data/surface/certificates/*.json data/surface/certificates/*.json.gz
$PY python/surface/tables.py assemble data/surface/records.json $WORK/certs data/surface/certificates $WORK/certified.json $WORK/certified_subsets.json
$PY python/surface/report.py
npx tsx packages/surface/scripts/build-viz.ts
