#!/usr/bin/env bash
# Run the supply-audit against a self-managed local v8 stack.
#
# Why this exists: testkit's LocalTestEnvironment uses a testcontainers log-wait
# that is flaky in some Docker environments (it reports "Log stream ended and
# message Started not received" within ~1s, even though the stack is healthy).
# This script brings the same `compose.yml` stack up with plain `docker compose`,
# waits for it to be healthy, discovers the mapped ports, and points the audit at
# them via HB_*_PORT (see the `injected` branch in src/verify-supply.ts).
#
# Usage:  bash scripts/run-verify-supply.sh
# Env passthrough: MINT_AMOUNT, BURN_AMOUNT, HIDDEN_BURN_AMOUNT, SOFT_ASSERT.
set -euo pipefail

cd "$(dirname "$0")/.."
export TESTCONTAINERS_UID="${TESTCONTAINERS_UID:-vs}"
export NETWORK_ID="${NETWORK_ID:-undeployed}"
COMPOSE=(docker compose -f compose.yml)

cleanup() {
  echo "[run-verify-supply] tearing down stack..."
  "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[run-verify-supply] bringing up node + indexer + proof-server..."
"${COMPOSE[@]}" up -d

wait_healthy() {
  local svc="$1" name="${2}" tries="${3:-60}"
  echo "[run-verify-supply] waiting for $svc ($name) to be healthy..."
  for ((i = 1; i <= tries; i++)); do
    local status
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || echo "missing")
    if [[ "$status" == "healthy" ]]; then
      echo "[run-verify-supply]   $svc healthy after ${i}0s"
      return 0
    fi
    if [[ "$status" == "exited" || "$status" == "dead" ]]; then
      echo "[run-verify-supply]   $svc $status — logs:"; docker logs "$name" 2>&1 | tail -30
      return 1
    fi
    sleep 10
  done
  echo "[run-verify-supply]   $svc not healthy after $((tries * 10))s"; docker logs "$name" 2>&1 | tail -30
  return 1
}

# Wait for a log line instead of docker health (the proof-server's healthcheck
# shells out to curl, which isn't in its nix image, so it never reports healthy
# even though it is listening).
wait_log() {
  local name="$1" pattern="$2" tries="${3:-60}"
  echo "[run-verify-supply] waiting for $name log /$pattern/..."
  for ((i = 1; i <= tries; i++)); do
    if docker logs "$name" 2>&1 | grep -qE "$pattern"; then
      echo "[run-verify-supply]   $name ready after $((i * 5))s"
      return 0
    fi
    local status
    status=$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null || echo missing)
    if [[ "$status" == "exited" || "$status" == "dead" ]]; then
      echo "[run-verify-supply]   $name $status — logs:"; docker logs "$name" 2>&1 | tail -30; return 1
    fi
    sleep 5
  done
  echo "[run-verify-supply]   $name log not seen after $((tries * 5))s"; docker logs "$name" 2>&1 | tail -30; return 1
}

# node first (indexer depends on it); proof-server downloads ZK params on first
# boot so it can take a couple of minutes.
wait_healthy node "node_${TESTCONTAINERS_UID}" 30
wait_healthy indexer "indexer_${TESTCONTAINERS_UID}" 30
wait_log "proof-server_${TESTCONTAINERS_UID}" "listening on: 0\.0\.0\.0:6300" 60

port_of() { "${COMPOSE[@]}" port "$1" "$2" | sed 's/.*://'; }
HB_NODE_PORT="$(port_of node 9944)"
HB_INDEXER_PORT="$(port_of indexer 8088)"
HB_PS_PORT="$(port_of proof-server 6300)"
export HB_NODE_PORT HB_INDEXER_PORT HB_PS_PORT
echo "[run-verify-supply] ports -> node=$HB_NODE_PORT indexer=$HB_INDEXER_PORT proof-server=$HB_PS_PORT"

echo "[run-verify-supply] running the supply audit..."
pnpm verify-supply
