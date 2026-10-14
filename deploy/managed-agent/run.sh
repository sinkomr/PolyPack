#!/bin/zsh
# Runs scripts/batch-search.ts in a Claude Managed Agents cloud sandbox (beta) and fetches its results.
# Needs ANTHROPIC_API_KEY in the environment and jq. Subcommands:
#   start <cents> '<batch arguments>'   create environment, agent and a session capped at <cents>, start the job
#   status | watch | stop | fetch | delete
# Ids are kept in ~/.polypack/managed/ so that later subcommands find the session.
set -euo pipefail
HERE="${0:A:h}"
STATE="$HOME/.polypack/managed"
API=https://api.anthropic.com/v1
mkdir -p "$STATE"

[[ -n "${ANTHROPIC_API_KEY:-}" ]] || { print -u2 "Set ANTHROPIC_API_KEY first (it is never printed)."; exit 2; }
api() {
  # not "path": in zsh that name is PATH itself, and a local of it hides every command
  local method="$1" endpoint="$2"
  shift 2
  curl -fsS -X "$method" "$API$endpoint" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" "$@"
}
session() { cat "$STATE/session"; }

case "${1:-}" in
start)
  cents="${2:?give the spending cap in US cents, e.g. 1000 for \$10}"
  shift 2
  args="${1:-}"
  [[ -n "$args" ]] || { print -u2 "Give the batch-search arguments, in single quotes, after the cap."; exit 2; }

  # The sandbox may reach this site and, through allow_package_managers, GitHub and npm; nothing else.
  api POST /environments -d '{"name":"polypack-batch","config":{"type":"cloud","networking":{"type":"limited","allowed_hosts":["polypack.fly.dev"],"allow_package_managers":true}}}' |
    jq -r .id > "$STATE/environment"

  # A small, cheap model only supervises: the search itself runs in the shell.
  jq -n --rawfile system "$HERE/system.md" '{name:"polypack-batch-runner", model:"claude-haiku-5-5", system:$system,
      tools:[{type:"agent_toolset_20260401", default_config:{enabled:false},
              configs:[{name:"bash",enabled:true},{name:"read",enabled:true}]}]}' |
    api POST /agents --data @- | jq -r .id > "$STATE/agent"

  # A read-only token for the repository, from ~/.polypack/github-token if it is there.
  if [[ -r "$STATE/../github-token" ]]; then
    token="$(<"$STATE/../github-token")"
  else
    read -s "token?Read-only GitHub token for sinkomr/PolyPack (input hidden): "
    print
  fi
  jq -n --arg agent "$(cat "$STATE/agent")" --arg env "$(cat "$STATE/environment")" --arg tok "$token" --arg cents "$cents" \
    '{agent:$agent, environment_id:$env, title:"PolyPack batch search",
      budget:{type:"limit", max_list_cost:{amount:$cents, currency:"USD"}},
      resources:[{type:"github_repository", url:"https://github.com/sinkomr/PolyPack", mount_path:"/workspace/PolyPack", authorization_token:$tok}]}' |
    api POST /sessions --data @- | jq -r .id > "$STATE/session"
  unset token

  # Events are only delivered to a stream that is open, so it starts before the task is sent.
  nohup curl -sS -N "$API/sessions/$(session)/events/stream?beta=true" \
    -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" -H "accept: text/event-stream" \
    > "$STATE/events-$(session).sse" 2> /dev/null &
  sleep 2

  task="$(<"$HERE/task.md")"
  task="${task//\{\{ARGS\}\}/$args}"
  jq -n --arg text "$task" '{events:[{type:"user.message", content:[{type:"text", text:$text}]}]}' |
    api POST "/sessions/$(session)/events?beta=true" --data @- > /dev/null
  print "Started session $(session) with a cap of $cents cents."
  print "Follow it with: $0 watch"
  ;;
status)
  api GET "/sessions/$(session)" | jq '{status, usage: (.usage // null), budget: (.budget // null)}'
  ;;
watch)
  # The agent's replies only, as they arrive.
  tail -n +1 -f "$STATE/events-$(session).sse" |
    sed -un 's/^data: //p' | jq -r --unbuffered 'select(.type == "agent.message") | .content[]? | select(.type == "text") | .text'
  ;;
stop)
  api POST "/sessions/$(session)/events?beta=true" -d '{"events":[{"type":"user.interrupt"}]}' > /dev/null
  print "Interrupt sent. A background search may keep running until the session is deleted."
  ;;
fetch)
  mkdir -p "$STATE/outputs-$(session)"
  api GET "/files?scope_id=$(session)" | jq -r '.data[] | "\(.id)\t\(.filename)"' |
    while IFS=$'\t' read -r id name; do
      api GET "/files/$id/content" -o "$STATE/outputs-$(session)/${name:t}"
      print "fetched ${name:t}"
    done
  ;;
delete)
  api DELETE "/sessions/$(session)" > /dev/null
  print "Session deleted, with its sandbox and files. Fetch first if you want them."
  ;;
*)
  sed -n '2,6p' "$0"
  exit 2
  ;;
esac
