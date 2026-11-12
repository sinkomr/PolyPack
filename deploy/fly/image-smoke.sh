#!/usr/bin/env bash
# Builds the production image (./Dockerfile) and checks that the server in it starts, answers,
# takes an entry, keeps it over a restart and stops cleanly, and that the operator's tools run in
# it. CI runs this before a deploy (job `image`); it needs only Docker and curl.
#
#   deploy/fly/image-smoke.sh [image tag]
set -euo pipefail

tag="${1:-polypack:smoke}"
name="polypack-smoke-$$"
port=18080
data="$(mktemp -d)"
chmod 777 "$data"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; docker run --rm -v "$data:/data" --entrypoint sh "$tag" -c "rm -rf /data/*" >/dev/null 2>&1 || true; rmdir "$data" 2>/dev/null || true' EXIT

docker build -t "$tag" .

start() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  # as on Fly: the volume at /data, the settings of fly.toml, 1 GB of memory
  docker run -d --name "$name" --memory 1g -p "127.0.0.1:$port:8080" -v "$data:/data" \
    -e CLIENT_IP_HEADER=fly-client-ip -e SNAPSHOT_DIR=/data/snapshot "$tag" >/dev/null
  for _ in $(seq 1 60); do
    if curl --silent --fail --max-time 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  docker logs "$name" || true
  echo "the server did not answer /api/health within 30 s" >&2
  return 1
}

fail() {
  echo "FAILED: $1" >&2
  docker logs "$name" 2>&1 | tail -40 >&2 || true
  exit 1
}

start
[ "$(curl --silent --fail "http://127.0.0.1:$port/api/health")" = '{"ok":true}' ] || fail "/api/health does not answer {\"ok\":true}"
[ "$(docker logs "$name" 2>&1 | grep -c '^\[spaces\] ')" = 8 ] || fail "the log does not have the eight [spaces] lines"
docker logs "$name" 2>&1 | grep -q '^PolyPack server on ' || fail "the log does not have the server's line"
curl --silent --fail "http://127.0.0.1:$port/" | grep -qi '<!doctype html' || fail "/ is not the website"
curl --silent --fail "http://127.0.0.1:$port/api/spaces" >/dev/null || fail "/api/spaces does not answer"

# eleven squares two apart: a valid entry of an open problem
entry='{"N":4,"M":4,"P":11,"name":"image smoke test","pieces":[{"x":0,"y":0,"theta":0},{"x":2,"y":0,"theta":0},{"x":4,"y":0,"theta":0},{"x":6,"y":0,"theta":0},{"x":0,"y":2,"theta":0},{"x":2,"y":2,"theta":0},{"x":4,"y":2,"theta":0},{"x":6,"y":2,"theta":0},{"x":0,"y":4,"theta":0},{"x":2,"y":4,"theta":0},{"x":4,"y":4,"theta":0}]}'
answer="$(curl --silent --fail -X POST -H 'content-type: application/json' -d "$entry" "http://127.0.0.1:$port/api/submit")"
case "$answer" in
  '{"valid":true,"reasons":[],"score":7.414213562373095,"rank":1,"leader":true,'*'"id":1,'*) ;;
  *) fail "the entry was not taken: $answer" ;;
esac

# the operator's tool reads the database beside the running server (docs/DEPLOY_FLY.md)
docker exec "$name" node --no-warnings /app/apps/server/scripts/db-space.mjs >/dev/null || fail "db-space.mjs does not run in the image"

# SIGTERM, as a deploy sends it: the server stops by itself, with status 0
docker stop --time 10 "$name" >/dev/null
[ "$(docker inspect --format '{{.State.ExitCode}}' "$name")" = 0 ] || fail "the server did not stop with status 0"

# and the entry is there after a restart on the same volume
start
curl --silent --fail "http://127.0.0.1:$port/api/submissions/1" | grep -q '"name":"image smoke test"' || fail "the entry is not there after a restart"
docker stop --time 10 "$name" >/dev/null
echo "image smoke test passed"
