#!/bin/bash
# linux.sh NAME TOOL ARGS...     (for example: linux.sh flat flat-ref $LINUXREF_DIR/flat 4 --no-times n-0.json.gz ...)
#
# Runs $LINUXREF_DIR/bundle/TOOL.mjs (bundle.sh wrote it) with ARGS under Node 24 on linux/amd64, the production
# platform, in a container named linuxref-NAME that is removed when it ends. See native/tools/LINUX_REFERENCE.md.
#
# Mounted at their own paths, so that the paths the tools use and the paths in ARGS mean the same inside:
#   the repository      read-only; read-write with LINUXREF_RW=1, for a tool that writes into it (fixtures, a table)
#   $LINUXREF_DIR       read-write: the scratch directory for the bundles and the outputs
#   $LINUXREF_INPUTS    read-only, when set: a directory of inputs outside the two above (the nightly snapshots)
# The working directory is the repository's root, as the tools expect.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
out=${LINUXREF_DIR:?set LINUXREF_DIR to a scratch directory outside the repository}
name=$1; tool=$2; shift 2
mode=ro
if [ "${LINUXREF_RW:-}" = 1 ]; then mode=rw; fi
mounts=(-v "$root:$root:$mode" -v "$out:$out")
if [ -n "${LINUXREF_INPUTS:-}" ]; then mounts+=(-v "$LINUXREF_INPUTS:$LINUXREF_INPUTS:ro"); fi
exec docker run --rm --name "linuxref-$name" --platform linux/amd64 "${mounts[@]}" -w "$root" \
  node:24-slim node --max-old-space-size=8192 "$out/bundle/$tool.mjs" "$@"
