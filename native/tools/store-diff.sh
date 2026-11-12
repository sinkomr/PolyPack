#!/bin/bash
# The whole comparison of the SQLite store (apps/server/src/sqlite-store.ts) with its Rust port (native/server/src/store):
#   1. a seeded random sequence of calls of every method, run by each implementation on its own fresh file;
#   2. the same sequence with the file changing hands (TypeScript then Rust, Rust then TypeScript, and back and forth);
#   3. databases as older servers left them, opened and migrated in place by each, and with the file changing hands
#      in the middle of the migration.
# Every run is compared with the TypeScript's own: the result of every call as text, then the database files table by
# table and row by row (store-compare.mjs). Prints one line per comparison and a count at the end; exit status 1 when
# anything differs.
#
#   native/tools/store-diff.sh WORKDIR SNAPDIR SPACESNAPDIR [COUNT] [SEED]
#
# WORKDIR is emptied of earlier runs of this script. Run from the repository root; CARGO_TARGET_DIR is honoured.
set -u
W=${1:?WORKDIR}; SNAP=${2:?SNAPDIR}; SPACESNAP=${3:?SPACESNAPDIR}; COUNT=${4:-6000}; SEED=${5:-20261110}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT" || exit 2
export PATH="$HOME/.cargo/bin:$PATH"
(cd native && cargo build -q --release -p polypack-server --example storediff) || exit 2
BIN="${CARGO_TARGET_DIR:-$ROOT/native/target}/release/examples/storediff"
NODE=${NODE:-node}
TS="$NODE --import tsx native/tools/store-ref.mts"
CMP="$NODE native/tools/store-compare.mjs"
echo "Node $($NODE --version) with SQLite $($NODE -e "console.log(process.versions.sqlite)"); the Rust store's SQLite is the one bundled by its rusqlite"
mkdir -p "$W"
fails=0; checks=0
check() { # label, command...
  local label=$1; shift
  local out; out=$("$@" 2>&1); local st=$?
  checks=$((checks + 1))
  if [ $st -ne 0 ]; then fails=$((fails + 1)); echo "DIFFERENT  $label"; echo "$out" | sed 's/^/    /'; else echo "same       $label: $(echo "$out" | tail -1)"; fi
}
fresh() { rm -f "$1" "$1-wal" "$1-shm" "$2"; }
# one run: who (ts|rs), calls, ids, db, from, to, out, [leave]; with TRACE=file, the statements sent to SQLite go there
run() {
  local who=$1; shift
  if [ "$who" = ts ]; then STORE_TRACE="${TRACE:-}" $TS run "$1" "$3" "$4" "$5" "$6" "${7:-}" || { echo "the TypeScript run failed"; exit 2; }
  else STORE_TRACE="${TRACE:-}" "$BIN" run "$1" "$2" "$3" "$4" "$5" "$6" "${7:-}" || { echo "the Rust run failed"; exit 2; }; fi
}

echo "== 1. a random sequence of $COUNT calls (seed $SEED), each implementation on its own file"
G="$W/gen"; rm -rf "$G"; mkdir -p "$G"
$TS gen "$G" "$SEED" "$COUNT" "$SNAP" "$SPACESNAP" || exit 2
C="$G/calls.jsonl"; I="$G/spaceids.json"
rm -f "$G/rs.trace" "$G/ts.trace"
fresh "$G/rs.sqlite" "$G/rs.jsonl"; TRACE="$G/rs.trace" run rs "$C" "$I" "$G/rs.sqlite" 0 "$COUNT" "$G/rs.jsonl"
check "pure Rust, results" $CMP results "$G/ts.jsonl" "$G/rs.jsonl"
check "pure Rust, database" $CMP db "$G/ts.sqlite" "$G/rs.sqlite"
# the TypeScript again, through `run`: the reference must reproduce itself
fresh "$G/ts2.sqlite" "$G/ts2.jsonl"; TRACE="$G/ts.trace" run ts "$C" "$I" "$G/ts2.sqlite" 0 "$COUNT" "$G/ts2.jsonl"
check "TypeScript again, results" $CMP results "$G/ts.jsonl" "$G/ts2.jsonl"
check "TypeScript again, database" $CMP db "$G/ts.sqlite" "$G/ts2.sqlite"
check "pure runs, the statements sent to SQLite" $CMP trace "$G/ts.trace" "$G/rs.trace"

echo "== 2. the same sequence with the file changing hands"
H=$((COUNT / 2))
fresh "$G/x1.sqlite" "$G/x1.jsonl"; run ts "$C" "$I" "$G/x1.sqlite" 0 "$H" "$G/x1.jsonl"; run rs "$C" "$I" "$G/x1.sqlite" "$H" "$COUNT" "$G/x1.jsonl"
check "TypeScript then Rust (the cutover), results" $CMP results "$G/ts.jsonl" "$G/x1.jsonl" --segments
check "TypeScript then Rust (the cutover), database" $CMP db "$G/ts.sqlite" "$G/x1.sqlite"
fresh "$G/x2.sqlite" "$G/x2.jsonl"; run rs "$C" "$I" "$G/x2.sqlite" 0 "$H" "$G/x2.jsonl"; run ts "$C" "$I" "$G/x2.sqlite" "$H" "$COUNT" "$G/x2.jsonl"
check "Rust then TypeScript (the rollback), results" $CMP results "$G/ts.jsonl" "$G/x2.jsonl" --segments
check "Rust then TypeScript (the rollback), database" $CMP db "$G/ts.sqlite" "$G/x2.sqlite"
fresh "$G/x3.sqlite" "$G/x3.jsonl"
STEP=$((COUNT / 12)); at=0; who=rs
while [ $at -lt "$COUNT" ]; do
  to=$((at + STEP)); [ $to -gt "$COUNT" ] && to=$COUNT
  run $who "$C" "$I" "$G/x3.sqlite" $at $to "$G/x3.jsonl"
  at=$to; if [ $who = rs ]; then who=ts; else who=rs; fi
done
check "back and forth every $STEP calls, results" $CMP results "$G/ts.jsonl" "$G/x3.jsonl" --segments
check "back and forth every $STEP calls, database" $CMP db "$G/ts.sqlite" "$G/x3.sqlite"

echo "== 3. databases as older servers left them"
for kind in prediet ancient partial preunits epoch1 poison; do
  O="$W/old-$kind"; rm -rf "$O"; mkdir -p "$O"
  $TS old $kind "$O" "$SNAP" "$SPACESNAP" || exit 2
  C="$O/calls.jsonl"; I="$O/spaceids.json"; N=$(wc -l < "$C" | tr -d ' '); CUT=$(cat "$O/cut.txt")
  modes="migrate"; [ $kind = preunits ] && modes="migrate leave"
  for mode in $modes; do
    for who in ts rs; do
      fresh "$O/$who-$mode.sqlite" "$O/$who-$mode.jsonl"; cp "$O/old.sqlite" "$O/$who-$mode.sqlite"; rm -f "$O/$who-$mode.trace"
      TRACE="$O/$who-$mode.trace" run $who "$C" "$I" "$O/$who-$mode.sqlite" 0 "$N" "$O/$who-$mode.jsonl" $mode
    done
    check "$kind ($mode), Rust, results" $CMP results "$O/ts-$mode.jsonl" "$O/rs-$mode.jsonl"
    check "$kind ($mode), Rust, database" $CMP db "$O/ts-$mode.sqlite" "$O/rs-$mode.sqlite"
    check "$kind ($mode), the statements sent to SQLite" $CMP trace "$O/ts-$mode.trace" "$O/rs-$mode.trace"
    # the TypeScript's statements through the SQLite bundled with the Rust store, and none of the store's code:
    # the same rows, and the page counts to set beside the Rust store's
    rm -f "$O/replay-$mode.sqlite" "$O/replay-$mode.sqlite-wal" "$O/replay-$mode.sqlite-shm"; cp "$O/old.sqlite" "$O/replay-$mode.sqlite"
    "$BIN" replay "$O/ts-$mode.trace" "$O/replay-$mode.sqlite" > /dev/null || exit 2
    check "$kind ($mode), the TypeScript's statements replayed on the bundled SQLite, database" $CMP db "$O/ts-$mode.sqlite" "$O/replay-$mode.sqlite"
    echo "           pages of the Rust store's file: $($CMP db "$O/rs-$mode.sqlite" "$O/replay-$mode.sqlite" | tail -1 | sed 's/.*Pages: A //; s/, B / | the replay: /')"
  done
  if [ "$N" -gt 0 ]; then
    for order in "ts rs" "rs ts"; do
      set -- $order; tag="$1$2"
      fresh "$O/$tag.sqlite" "$O/$tag.jsonl"; cp "$O/old.sqlite" "$O/$tag.sqlite"
      run $1 "$C" "$I" "$O/$tag.sqlite" 0 "$CUT" "$O/$tag.jsonl"; run $2 "$C" "$I" "$O/$tag.sqlite" "$CUT" "$N" "$O/$tag.jsonl"
      check "$kind, $1 then $2 from call $CUT, results" $CMP results "$O/ts-migrate.jsonl" "$O/$tag.jsonl" --segments
      check "$kind, $1 then $2 from call $CUT, database" $CMP db "$O/ts-migrate.sqlite" "$O/$tag.sqlite"
    done
    # opened by one and then by the other, with no call in between: the second finds nothing to do
    fresh "$O/open2.sqlite" "$O/open2.jsonl"; cp "$O/old.sqlite" "$O/open2.sqlite"
    run rs "$C" "$I" "$O/open2.sqlite" 0 0 "$O/open2.jsonl"; run ts "$C" "$I" "$O/open2.sqlite" 0 "$N" "$O/open2.jsonl"
    check "$kind, opened by Rust, then everything by TypeScript, results" $CMP results "$O/ts-migrate.jsonl" "$O/open2.jsonl" --segments
    check "$kind, opened by Rust, then everything by TypeScript, database" $CMP db "$O/ts-migrate.sqlite" "$O/open2.sqlite"
  fi
done
echo "== $checks comparisons, $fails with differences"
[ $fails -eq 0 ]
