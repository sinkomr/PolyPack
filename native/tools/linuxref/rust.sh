#!/bin/bash
# rust.sh FAMILY DIR     (FAMILY: flat surface curved sphere torus ndim boundary polyhedra balls spaces)
#
# The Rust side of a comparison on the cases of DIR, natively on this machine (the port's answers do not depend on the
# platform), then the family's compare tool as it is, its output in DIR/compare.txt. DIR holds what the family's ref
# tool wrote under Linux Node 24 (linux.sh). See native/tools/LINUX_REFERENCE.md.
#
# The compare tools of most families read ts-times.json, which a reference written with --no-times does not have. When
# it is missing, rust-times.json stands in for it, so that the tool runs unchanged: the timing tables of compare.txt
# then show a ratio of 1 and mean nothing. The verdicts and numbers compared are not touched by this.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
fam=$1; dir=$2
run() { (cd "$root/native" && cargo run --release --quiet -p "$1" --example "$2" -- "${@:3}"); }
case $fam in
  flat) run polypack-flat serverdiff "$dir" ;;
  surface) for part in cases solids domain; do run polypack-surface surfacediff "$part" "$dir"; done ;;
  curved) run polypack-curved curveddiff "$dir" ;;
  sphere) run polypack-sphere spherediff "$dir" ;;
  torus) run polypack-torus torusdiff "$dir" ;;
  ndim) run polypack-ndim ndimdiff "$dir" ;;
  boundary)
    run polypack-boundary boundarydiff "$dir/cases.jsonl" "$dir/rust.jsonl" "$dir/rust-times.json"
    run polypack-boundary boundarydiff --extras "$dir/extras.jsonl" "$dir/rust-extras.jsonl" ;;
  polyhedra) run polypack-polyhedra polyhedradiff "$dir" ;;
  balls) run polypack-balls ballsdiff "$dir" ;;
  spaces) run polypack-spaces spacesdiff "$dir" ;;
  *) echo "unknown family $fam" >&2; exit 2 ;;
esac
if [ ! -f "$dir/ts-times.json" ] && [ -f "$dir/rust-times.json" ]; then
  cp "$dir/rust-times.json" "$dir/ts-times.json"
  echo "ts-times.json was missing (a reference written with --no-times): rust-times.json stands in for it; the timing tables of compare.txt mean nothing"
fi
status=0
(cd "$root" && node "native/tools/$fam-compare.mjs" "$dir") > "$dir/compare.txt" 2>&1 || status=$?
echo "$fam-compare.mjs: exit $status, output in $dir/compare.txt"
exit $status
