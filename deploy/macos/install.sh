#!/bin/zsh
# One-time setup on the Mac that hosts PolyPack: writes the settings file with a random admin token,
# builds the site, and registers two launchd jobs (the server, restarted if it dies and started at
# boot; the nightly database backup). Safe to run again after `git pull`.
set -eu
REPO="${0:A:h:h:h}"
STATE="$HOME/.polypack"
ENV_FILE="$STATE/env"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

mkdir -p "$STATE/backups" "$STATE/logs"
if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  cat > "$ENV_FILE" <<SETTINGS
PORT=8787
HOST=127.0.0.1
DATABASE_PATH=$STATE/polypack.sqlite
ADMIN_TOKEN=$(openssl rand -hex 32)
TRUST_PROXY=1
SETTINGS
  echo "Wrote $ENV_FILE with a new random ADMIN_TOKEN (read it with: grep ADMIN_TOKEN $ENV_FILE)"
fi

cd "$REPO"
npm ci
npm run build

job() {
  local label="$1" body="$2" plist="/Library/LaunchDaemons/$1.plist"
  print -r -- "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
  <key>Label</key><string>$label</string>
  <key>UserName</key><string>$USER</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>$HOME</string></dict>
  <key>StandardOutPath</key><string>$STATE/logs/$label.log</string>
  <key>StandardErrorPath</key><string>$STATE/logs/$label.log</string>
$body
</dict></plist>" | sudo tee "$plist" > /dev/null
  sudo launchctl bootout system "$plist" 2> /dev/null || true
  sudo launchctl bootstrap system "$plist"
}

job org.polypack.server "  <key>ProgramArguments</key><array><string>$REPO/deploy/macos/start.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>"

job org.polypack.backup "  <key>ProgramArguments</key><array><string>$REPO/deploy/macos/backup.sh</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>10</integer></dict>"

sleep 3
curl -fsS "http://127.0.0.1:8787/" > /dev/null && echo "PolyPack is answering on http://127.0.0.1:8787" || echo "Not answering yet; see $STATE/logs/org.polypack.server.log"
