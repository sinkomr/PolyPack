#!/bin/zsh
# Copies the live PolyPack database from Fly.io to this Mac, compressed, keeping the newest few.
# backup-dump.cjs runs on the server and streams one consistent snapshot of the database (a single
# read transaction, while the server goes on writing) straight over `fly ssh`, so nothing is
# written to the server's disk and no free space is needed there. backup-rebuild.mjs turns the
# stream back into a database here, which is checked before it is kept.
#   backup-to-mac.sh            take a backup now
#   backup-to-mac.sh install    run it every Sunday at 04:00 (launchd; a missed run happens on wake)
#   backup-to-mac.sh uninstall  stop the schedule
# Settings, all optional: POLYPACK_APP (polypack), POLYPACK_BACKUP_DIR, POLYPACK_BACKUP_KEEP (4).
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.fly/bin:/usr/bin:/bin:/usr/sbin:/sbin"

APP="${POLYPACK_APP:-polypack}"
DEST="${POLYPACK_BACKUP_DIR:-$HOME/GitHub/PolyPack-backups/database}"
KEEP="${POLYPACK_BACKUP_KEEP:-4}"
HERE="${0:A:h}"
LABEL=com.polypack.backup
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/polypack-backup.log"

case "${1:-}" in
install)
  mkdir -p "${PLIST:h}" "${LOG:h}"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>${0:A}</string></array>
  <key>StartCalendarInterval</key><dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2> /dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  print "Scheduled: every Sunday at 04:00 into $DEST (log: $LOG)."
  exit 0
  ;;
uninstall)
  launchctl bootout "gui/$(id -u)/$LABEL" 2> /dev/null || true
  rm -f "$PLIST"
  print "Schedule removed. Backups already taken stay in $DEST."
  exit 0
  ;;
"") ;;
*)
  sed -n '2,10p' "$0"
  exit 2
  ;;
esac

print "$(date '+%Y-%m-%d %H:%M:%S') backup of $APP starting"
mkdir -p "$DEST"
work=$(mktemp -d "${TMPDIR:-/tmp}/polypack-backup.XXXXXX")
trap 'rm -rf "$work"' EXIT

# On the server, at low CPU priority: the dump script arrives base64-encoded on the command line
# (so that no quoting survives the trip) and its gzipped stream comes back on stdout.
started=$SECONDS
script=$(base64 < "$HERE/backup-dump.cjs" | tr -d '\n')
fly ssh console -q -a "$APP" -C "sh -c 'echo $script | base64 -d | nice -n 10 node --no-warnings -'" \
  > "$work/dump.ndjson.gz" 2> "$work/dump.err" ||
  { print -u2 "The dump failed: $(tail -3 "$work/dump.err")"; exit 1; }
print "streamed $(du -h "$work/dump.ndjson.gz" | cut -f1) in $((SECONDS - started)) s: $(tail -1 "$work/dump.err")"

# Here: rebuild the database from the stream (which checks every table's row count against the
# dump's own and runs quick_check), then check it again with the sqlite3 tool.
report=$(node "$HERE/backup-rebuild.mjs" "$work/dump.ndjson.gz" "$work/polypack.sqlite") ||
  { print -u2 "The stream could not be rebuilt into a database; nothing kept."; exit 1; }
check=$(sqlite3 "$work/polypack.sqlite" 'PRAGMA quick_check')
entries=$(sqlite3 "$work/polypack.sqlite" 'SELECT COUNT(*) FROM submissions')
[[ "$check" == ok && "$report" == *"\"submissions\":$entries"[,}]* ]] ||
  { print -u2 "The rebuilt copy does not match ($check, $entries entries; $report); nothing kept."; exit 1; }
rm -f "$work/dump.ndjson.gz"

name="polypack-$(date +%Y-%m-%d-%H%M).sqlite.gz"
gzip -6 -c "$work/polypack.sqlite" > "$work/$name"
mv "$work/$name" "$DEST/$name"
print "kept $DEST/$name ($(du -h "$DEST/$name" | cut -f1), $entries entries)"

# The newest $KEEP stay here; Time Machine keeps older ones as long as it keeps anything.
ls -1t "$DEST"/polypack-*.sqlite.gz | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
  print "removed old $old"
done
