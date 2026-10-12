#!/bin/zsh
# Runs the PolyPack server in production. Started by launchd (see install.sh); also fine to run by hand.
set -eu
REPO="${0:A:h:h:h}"
ENV_FILE="${POLYPACK_ENV:-$HOME/.polypack/env}"
# launchd starts with a bare PATH; Homebrew's node lives in one of these.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi
cd "$REPO"
exec npm run start
