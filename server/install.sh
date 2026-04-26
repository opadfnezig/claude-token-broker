#!/usr/bin/env bash
# Installs the host-side systemd refresh service. Run on the broker host
# AFTER you have done an interactive `claude` login as the user that owns
# the credentials. The service:
#
#   1. Refreshes ~/.claude/.credentials.json ~1h before expiry.
#   2. Mirrors content into /var/lib/claude-token-broker/ via truncate-write.
#
# The Dockerized server then watches the mirror and pushes changes to
# subscribed clients.
#
# Env overrides:
#   CLAUDE_USER  — user that owns the credentials (default: $(id -un))
#   MIRROR_DIR   — mirror destination (default: /var/lib/claude-token-broker)
set -euo pipefail

cd "$(dirname "$0")"

CLAUDE_USER="${CLAUDE_USER:-$(id -un)}"
CLAUDE_HOME=$(getent passwd "$CLAUDE_USER" | cut -d: -f6)
MIRROR_DIR="${MIRROR_DIR:-/var/lib/claude-token-broker}"

if [[ -z "$CLAUDE_HOME" ]] || [[ ! -d "$CLAUDE_HOME" ]]; then
  echo "ERROR: home dir for user '$CLAUDE_USER' not found." >&2
  exit 1
fi

if [[ ! -f "$CLAUDE_HOME/.claude/.credentials.json" ]]; then
  echo "ERROR: $CLAUDE_HOME/.claude/.credentials.json missing." >&2
  echo "       Run 'claude' interactively as $CLAUDE_USER first to log in." >&2
  exit 1
fi

CLAUDE_BIN=$(sudo -u "$CLAUDE_USER" -i which claude 2>/dev/null || true)
if [[ -z "$CLAUDE_BIN" ]]; then
  echo "WARN: 'claude' CLI not in $CLAUDE_USER's PATH; service may fail." >&2
  CLAUDE_BIN="claude"
fi

echo "Installing claude-token-broker-refresh.service (user=$CLAUDE_USER, mirror=$MIRROR_DIR)..."
sudo install -m 755 refresh.sh /usr/local/bin/claude-token-broker-refresh.sh
sudo mkdir -p "$MIRROR_DIR"
sudo touch "$MIRROR_DIR/credentials.json" "$MIRROR_DIR/claude.json"
sudo chown "$CLAUDE_USER:$CLAUDE_USER" "$MIRROR_DIR" \
                                       "$MIRROR_DIR/credentials.json" \
                                       "$MIRROR_DIR/claude.json"
sudo chmod 644 "$MIRROR_DIR/credentials.json" "$MIRROR_DIR/claude.json"

sudo tee /etc/systemd/system/claude-token-broker-refresh.service > /dev/null <<EOF
[Unit]
Description=Refresh Claude OAuth token + mirror for claude-token-broker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$CLAUDE_USER
Environment=HOME=$CLAUDE_HOME
Environment=MIRROR_DIR=$MIRROR_DIR
Environment=CLAUDE_BIN=$CLAUDE_BIN
ExecStart=/usr/local/bin/claude-token-broker-refresh.sh
Restart=on-failure
RestartSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now claude-token-broker-refresh.service

echo "claude-token-broker-refresh.service active."
echo "Next: cp .env.example .env && docker compose up -d"
