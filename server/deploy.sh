#!/usr/bin/env bash
# Builds and starts the broker server container. Run install.sh first to
# set up the host-side refresh service.
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "ERROR: .env missing. Copy .env.example → .env and fill it in." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if ! systemctl is-active --quiet claude-token-broker-refresh.service; then
  echo "WARN: claude-token-broker-refresh.service is not active." >&2
  echo "      Run ./install.sh first or expect missing credentials." >&2
fi

mkdir -p data

echo "Building broker server image..."
docker compose build

echo "Starting broker server..."
docker compose up -d

echo "Waiting for /health..."
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${CTB_PORT:-9990}/health" >/dev/null 2>&1; then
    pubkey=$(curl -fsS "http://127.0.0.1:${CTB_PORT:-9990}/health" | sed -n 's/.*"pubkey":"\([^"]*\)".*/\1/p')
    echo "Broker server healthy."
    echo "Server pubkey: $pubkey"
    echo "Hand this pubkey to each client (CTB_SERVER_PUBKEY in client .env)."
    exit 0
  fi
  sleep 1
done

echo "Broker did not become healthy. Recent logs:" >&2
docker compose logs --tail 100
exit 1
