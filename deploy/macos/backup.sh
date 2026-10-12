#!/bin/zsh
# Nightly copy of the SQLite database. `.backup` is safe while the server is writing.
set -eu
ENV_FILE="${POLYPACK_ENV:-$HOME/.polypack/env}"
set -a
source "$ENV_FILE"
set +a
DEST="${BACKUP_DIR:-$HOME/.polypack/backups}"
mkdir -p "$DEST"
/usr/bin/sqlite3 "$DATABASE_PATH" ".backup '$DEST/polypack-$(date +%Y-%m-%d).sqlite'"
# Keep the newest 30.
ls -1t "$DEST"/polypack-*.sqlite | tail -n +31 | while read -r old; do rm -f "$old"; done
