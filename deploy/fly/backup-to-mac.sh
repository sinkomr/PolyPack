#!/bin/zsh
# Copies the live PolyPack database from Fly.io to this Mac, compressed, keeping the newest few.
# The copy is taken on the server with VACUUM INTO, which reads one consistent snapshot while the
# server goes on writing, then downloaded over `fly ssh sftp` and checked before it is kept.
#   backup-to-mac.sh            take a backup now
#   backup-to-mac.sh install    run it every Sunday at 04:00 (launchd; a missed run happens on wake)
#   backup-to-mac.sh uninstall  stop the schedule
# Settings, all optional: POLYPACK_APP (polypack), POLYPACK_BACKUP_DIR, POLYPACK_BACKUP_KEEP (4).
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.fly/bin:/usr/bin:/bin:/usr/sbin:/sbin"

APP="${POLYPACK_APP:-polypack}"
DEST="${POLYPACK_BACKUP_DIR:-$HOME/GitHub/PolyPack-backups/database}"
KEEP="${POLYPACK_BACKUP_KEEP:-4}"
REMOTE=/data/backup.sqlite
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
  sed -n '2,8p' "$0"
  exit 2
  ;;
esac

# Runs a Node script on the server. It is sent base64-encoded so that no quoting survives the trip.
remote_node() {
  fly ssh console -a "$APP" -C "sh -c 'echo $(print -rn -- "$1" | base64) | base64 -d | node --no-warnings -'" 2>&1 |
    grep -v '^Connecting to '
}

print "$(date '+%Y-%m-%d %H:%M:%S') backup of $APP starting"
mkdir -p "$DEST"
work=$(mktemp -d "${TMPDIR:-/tmp}/polypack-backup.XXXXXX")
cleanup() {
  remote_node "require('node:fs').rmSync('$REMOTE', { force: true })" > /dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

# On the server: room for a full copy, the copy itself, and a check of it.
made=$(remote_node "
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const live = '/data/polypack.sqlite', out = '$REMOTE';
fs.rmSync(out, { force: true });
const free = fs.statfsSync('/data');
if (free.bavail * free.bsize < fs.statSync(live).size * 1.05) {
  console.log(JSON.stringify({ error: 'not enough free space on /data for a copy' }));
  process.exit(1);
}
const started = Date.now();
const db = new DatabaseSync(live, { readOnly: true });
db.exec('PRAGMA busy_timeout = 30000');
db.prepare('VACUUM INTO ?').run(out);
db.close();
const copy = new DatabaseSync(out, { readOnly: true });
const check = Object.values(copy.prepare('PRAGMA quick_check').get())[0];
const entries = copy.prepare('SELECT COUNT(*) AS n FROM submissions').get().n;
console.log(JSON.stringify({ bytes: fs.statSync(out).size, entries, check, seconds: (Date.now() - started) / 1000 }));
")
print "server copy: $made"
[[ "$made" == *'"check":"ok"'* ]] || { print -u2 "The server copy failed its check; nothing kept."; exit 1; }

fly ssh sftp get -a "$APP" "$REMOTE" "$work/polypack.sqlite" > /dev/null
check=$(sqlite3 "$work/polypack.sqlite" 'PRAGMA quick_check')
entries=$(sqlite3 "$work/polypack.sqlite" 'SELECT COUNT(*) FROM submissions')
[[ "$check" == ok && "$made" == *"\"entries\":$entries,"* ]] ||
  { print -u2 "The downloaded copy does not match ($check, $entries entries); nothing kept."; exit 1; }

name="polypack-$(date +%Y-%m-%d-%H%M).sqlite.gz"
gzip -6 -c "$work/polypack.sqlite" > "$work/$name"
mv "$work/$name" "$DEST/$name"
print "kept $DEST/$name ($(du -h "$DEST/$name" | cut -f1), $entries entries)"

# The newest $KEEP stay here; Time Machine keeps older ones as long as it keeps anything.
ls -1t "$DEST"/polypack-*.sqlite.gz | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
  print "removed old $old"
done
