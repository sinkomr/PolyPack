#!/bin/zsh
# Runs scripts/batch-search.ts in Claude Managed Agents cloud sandboxes (beta) and fetches the results.
# Needs ANTHROPIC_API_KEY in the environment and jq. Each session has a short name of your choosing:
#   start <name> <cents> '<batch arguments>'   start a session capped at <cents> (US cents)
#   status [name]                              state and spending of one session, or of all
#   nudge [name]                               wake a session whose supervisor stopped (all idle ones by default)
#   watch <name> | stop <name> | fetch <name> | delete <name>
# Ids are kept in ~/.polypack/managed/ so that later subcommands find the sessions.
set -euo pipefail
HERE="${0:A:h}"
STATE="$HOME/.polypack/managed"
API=https://api.anthropic.com/v1
mkdir -p "$STATE/sessions"

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
named() {
  local file="$STATE/sessions/${1:?give the session name}"
  [[ -r "$file" ]] || { print -u2 "No session named $1 (see $STATE/sessions)."; exit 2; }
  cat "$file"
}

command="${1:-}"
[[ $# -gt 0 ]] && shift
case "$command" in
start)
  name="${1:?give a session name, e.g. phase1a}"
  cents="${2:?give the spending cap in US cents, e.g. 1000 for \$10}"
  args="${3:-}"
  [[ -n "$args" ]] || { print -u2 "Give the batch-search arguments, in single quotes, after the cap."; exit 2; }
  [[ ! -e "$STATE/sessions/$name" ]] || { print -u2 "A session named $name exists; delete it or pick another name."; exit 2; }

  # One environment and one agent serve every session; they are created on first use.
  # The sandbox may reach this site and, through allow_package_managers, GitHub and npm; nothing else.
  if [[ ! -s "$STATE/environment" ]]; then
    api POST /environments -d '{"name":"polypack-batch","config":{"type":"cloud","networking":{"type":"limited","allowed_hosts":["polypack.fly.dev"],"allow_package_managers":true}}}' |
      jq -r .id > "$STATE/environment"
  fi
  # A small, cheap model only supervises: the search itself runs in the shell.
  if [[ ! -s "$STATE/agent" ]]; then
    jq -n --rawfile system "$HERE/system.md" '{name:"polypack-batch-runner", model:"claude-haiku-5-5", system:$system,
        tools:[{type:"agent_toolset_20260401", default_config:{enabled:false},
                configs:[{name:"bash",enabled:true},{name:"read",enabled:true}]}]}' |
      api POST /agents --data @- | jq -r .id > "$STATE/agent"
  fi

  # A read-only token for the repository, from ~/.polypack/github-token if it is there.
  if [[ -r "$STATE/../github-token" ]]; then
    token="$(<"$STATE/../github-token")"
  else
    read -s "token?Read-only GitHub token for sinkomr/PolyPack (input hidden): "
    print
  fi
  id=$(jq -n --arg agent "$(<"$STATE/agent")" --arg env "$(<"$STATE/environment")" --arg tok "$token" \
      --arg cents "$cents" --arg title "PolyPack batch $name" \
    '{agent:$agent, environment_id:$env, title:$title,
      budget:{type:"limit", max_list_cost:{amount:$cents, currency:"USD"}},
      resources:[{type:"github_repository", url:"https://github.com/sinkomr/PolyPack", mount_path:"/workspace/PolyPack", authorization_token:$tok}]}' |
    api POST /sessions --data @- | jq -r .id)
  unset token
  print -r -- "$id" > "$STATE/sessions/$name"

  # Events are only delivered to a stream that is open, so it starts before the task is sent.
  nohup curl -sS -N "$API/sessions/$id/events/stream?beta=true" \
    -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" -H "accept: text/event-stream" \
    > "$STATE/events-$id.sse" 2> /dev/null &
  sleep 2

  task="$(<"$HERE/task.md")"
  task="${task//\{\{ARGS\}\}/$args}"
  jq -n --arg text "$task" '{events:[{type:"user.message", content:[{type:"text", text:$text}]}]}' |
    api POST "/sessions/$id/events?beta=true" --data @- > /dev/null
  print "Started session $name ($id) with a cap of $cents cents."
  ;;
status)
  for name in ${1:-$(ls "$STATE/sessions")}; do
    api GET "/sessions/$(named "$name")" |
      jq -c --arg name "$name" '{session: $name, status, active_hours: ((.usage.active_seconds // 0) / 3600 | . * 100 | round / 100),
        cost_cents: (.usage.list_cost.amount // "0"), cap_cents: .budget.max_list_cost.amount}'
  done
  ;;
nudge)
  # A supervisor that ends its turn (for instance after a crashed check) leaves the session idle,
  # and an idle sandbox stops running the batch. A new message wakes it; the batch resumes from runs.jsonl.
  nudge='Your previous turn ended while the batch should still be working. Check whether the process in /mnt/session/outputs/batch.pid is alive. If it is not, and the last lines of run.log do not show the batch finishing, start it again with exactly the same command as before (it resumes from runs.jsonl, so nothing is repeated). Then go on with the 5-minute check cycle. If a check fails or is interrupted, run it again; do not end your turn until the batch has finished.'
  for name in ${1:-$(ls "$STATE/sessions")}; do
    id=$(named "$name")
    state=$(api GET "/sessions/$id" | jq -r .status)
    if [[ -n "${1:-}" || "$state" == idle ]]; then
      jq -n --arg text "$nudge" '{events:[{type:"user.message", content:[{type:"text", text:$text}]}]}' |
        api POST "/sessions/$id/events?beta=true" --data @- > /dev/null
      print "$name: was $state, nudged"
    else
      print "$name: $state"
    fi
  done
  ;;
watch)
  # The agent's replies only, as they arrive. The stream may close after about an hour; status still works.
  tail -n +1 -f "$STATE/events-$(named "${1:-}").sse" |
    sed -un 's/^data: //p' | jq -r --unbuffered 'select(.type == "agent.message") | .content[]? | select(.type == "text") | .text'
  ;;
stop)
  api POST "/sessions/$(named "${1:-}")/events?beta=true" -d '{"events":[{"type":"user.interrupt"}]}' > /dev/null
  print "Interrupt sent. A background search may keep running until the session is deleted."
  ;;
fetch)
  id=$(named "${1:-}")
  out="$STATE/outputs-${1}"
  mkdir -p "$out/best"
  # The listing comes in pages; follow them to the end.
  after=""
  count=0
  while :; do
    page=$(api GET "/files?scope_id=$id&limit=1000${after:+&after_id=$after}")
    while IFS=$'\t' read -r fid fname; do
      [[ -n "$fid" ]] || continue
      # the best configurations go in best/, the logs at the top
      if [[ "$fname" == *.json && "$fname" != */runs.jsonl ]]; then dest="$out/best/${fname:t}"; else dest="$out/${fname:t}"; fi
      api GET "/files/$fid/content" -o "$dest"
      count=$((count + 1))
    done < <(print -r -- "$page" | jq -r '.data[] | "\(.id)\t\(.filename)"')
    [[ "$(print -r -- "$page" | jq -r '.has_more // false')" == true ]] || break
    after=$(print -r -- "$page" | jq -r '.last_id')
  done
  print "Fetched $count file(s) into $out"
  ;;
delete)
  api DELETE "/sessions/$(named "${1:-}")" > /dev/null
  rm -f "$STATE/sessions/$1"
  print "Session $1 deleted, with its sandbox and files. Fetch first if you want them."
  ;;
*)
  sed -n '2,7p' "$0"
  exit 2
  ;;
esac
