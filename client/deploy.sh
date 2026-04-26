#!/usr/bin/env bash
# Builds and starts the broker client container on this host.
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

: "${CTB_SERVER_URL:?CTB_SERVER_URL must be set in .env}"
: "${CTB_SERVER_PUBKEY:?CTB_SERVER_PUBKEY must be set in .env}"
: "${CTB_CALLBACK_URL:?CTB_CALLBACK_URL must be set in .env}"

OUT_DIR="${CTB_CREDENTIALS_OUT:-/var/lib/agentforge-creds}"

# Pre-create the credential files at the destination so docker can bind-mount
# them (file mounts require the source to exist).
sudo mkdir -p "$OUT_DIR"
sudo touch "$OUT_DIR/credentials.json" "$OUT_DIR/claude.json"
sudo chmod 644 "$OUT_DIR/credentials.json" "$OUT_DIR/claude.json"

mkdir -p data

echo "Building client image..."
docker compose build

echo "Starting broker client..."
docker compose up -d

echo "Waiting for /health..."
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${CTB_CALLBACK_PORT:-9991}/health" >/dev/null 2>&1; then
    pubkey=$(curl -fsS "http://127.0.0.1:${CTB_CALLBACK_PORT:-9991}/health" | sed -n 's/.*"pubkey":"\([^"]*\)".*/\1/p')
    echo "Client healthy."
    echo "Client pubkey: $pubkey"
    echo "Hand this pubkey to the broker admin:"
    echo "  broker-cli add <name> $pubkey"
    exit 0
  fi
  sleep 1
done

echo "Client did not become healthy. Recent logs:" >&2
docker compose logs --tail 100
exit 1
