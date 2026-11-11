#!/bin/bash
# bundle.sh TOOL...     (for example: bundle.sh flat-ref sphere-ref boundary-tables)
#
# Bundles native/tools/TOOL.mts into one plain JavaScript file, $LINUXREF_DIR/bundle/TOOL.mjs, that runs under plain
# `node` with no node_modules: the repository's node_modules holds this machine's binaries (tsx needs esbuild's), so tsx
# cannot run in a container of another platform. See native/tools/LINUX_REFERENCE.md.
#
#  - import.meta.url is defined as the tool's own path, so that what a tool derives from its place (the repository's
#    root, a crate's fixtures) still resolves when the bundle lies elsewhere;
#  - --loader:.mts=ts: some tools write a generic arrow function as <T>(...) => ..., which esbuild refuses in a .mts
#    file and tsx accepts.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
out=${LINUXREF_DIR:?set LINUXREF_DIR to a scratch directory outside the repository}
mkdir -p "$out/bundle"
for tool in "$@"; do
  "$root/node_modules/.bin/esbuild" "$root/native/tools/$tool.mts" --bundle --platform=node --format=esm --loader:.mts=ts \
    "--define:import.meta.url=\"file://$root/native/tools/$tool.mts\"" --outfile="$out/bundle/$tool.mjs" --log-level=warning
  echo "$out/bundle/$tool.mjs"
done
