#!/usr/bin/env bash
# Keep host Claude OAuth credentials fresh and mirror them to a stable-inode
# location that the broker container watches.
#
# Two reasons we need the mirror:
#   1. Claude CLI atomic-renames its credentials.json on refresh (new inode).
#      Docker single-file bind mounts pin the inode at mount time and would
#      see a stale file forever.
#   2. We use truncate-write into the mirror. The watcher inside the broker
#      container fires on IN_MODIFY, not on rename-into-place.
#
# Env (set by the systemd unit installed by install.sh):
#   HOME                 — credentials live at $HOME/.claude/.credentials.json
#   MIRROR_DIR           — mirror destination, default /var/lib/claude-token-broker
#   CLAUDE_BIN           — claude CLI path, default `claude`
#   LEAD_SECONDS         — refresh this many seconds before expiry, default 3600
#   RETRY_SECONDS        — wait this long after a failure, default 300
#   MIRROR_POLL_SECONDS  — periodic re-mirror inside the wait window, default 15
set -u

HOST_CRED="${HOME:?HOME must be set}/.claude/.credentials.json"
HOST_CONFIG="$HOME/.claude.json"
MIRROR_DIR="${MIRROR_DIR:-/var/lib/claude-token-broker}"
MIRROR_CRED="$MIRROR_DIR/credentials.json"
MIRROR_CONFIG="$MIRROR_DIR/claude.json"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
LOCK="/tmp/claude-token-broker-refresh.lock"
LEAD_SECONDS="${LEAD_SECONDS:-3600}"
RETRY_SECONDS="${RETRY_SECONDS:-300}"
MIRROR_POLL_SECONDS="${MIRROR_POLL_SECONDS:-15}"

mirror_creds() {
  if [ -f "$HOST_CRED" ]; then
    cat "$HOST_CRED" > "$MIRROR_CRED"
    chmod 644 "$MIRROR_CRED"
  fi
  if [ -f "$HOST_CONFIG" ]; then
    cat "$HOST_CONFIG" > "$MIRROR_CONFIG"
    chmod 644 "$MIRROR_CONFIG"
  fi
}

trigger_refresh() {
  echo "[ctb-refresh] triggering refresh" >&2
  if flock -n "$LOCK" "$CLAUDE_BIN" -p "ok" --max-turns 1 >/dev/null 2>&1; then
    echo "[ctb-refresh] refresh ok" >&2
    return 0
  else
    echo "[ctb-refresh] refresh failed" >&2
    return 1
  fi
}

mirror_creds

while true; do
  if [ ! -f "$HOST_CRED" ]; then
    echo "[ctb-refresh] $HOST_CRED missing, sleeping ${RETRY_SECONDS}s" >&2
    sleep "$RETRY_SECONDS"
    continue
  fi

  expires_ms=$(python3 -c "import json; print(json.load(open('$HOST_CRED'))['claudeAiOauth'].get('expiresAt',0))" 2>/dev/null)
  expires_ms=${expires_ms:-0}
  now_ms=$(date +%s%3N)
  sleep_s=$(( (expires_ms - now_ms) / 1000 - LEAD_SECONDS ))

  if [ "$sleep_s" -gt 0 ]; then
    while [ "$sleep_s" -gt 0 ]; do
      chunk=$(( sleep_s < MIRROR_POLL_SECONDS ? sleep_s : MIRROR_POLL_SECONDS ))
      sleep "$chunk"
      mirror_creds
      sleep_s=$(( sleep_s - chunk ))
    done
  fi

  if trigger_refresh; then
    mirror_creds
  else
    sleep "$RETRY_SECONDS"
  fi
done
