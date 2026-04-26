# claude-token-broker

A small daemon that keeps Claude OAuth credentials fresh on one host and
fans them out to N other hosts that each need to use Claude — without
sharing host filesystems, without staleness from Docker bind-mount inode
pinning, and without admin HTTP endpoints to lock down.

## Why

The Claude CLI refreshes its OAuth token via atomic-rename, which gives the
file a new inode. Docker single-file bind mounts pin the inode at mount
time, so containers consuming a refreshed credentials file see the OLD
(expired) version forever. Multi-host setups also need *something* to keep
the token fresh on every host without N independent logins.

The broker solves both:

- **One host** runs `claude` interactively (the broker host) — that's where
  refresh happens.
- **N hosts** run a tiny client that receives credential updates from the
  broker and writes them locally via truncate-write so containers'
  bind-mounted credentials always reflect the live token.

## Architecture

```
┌──── broker host ──────────────────────┐         ┌──── client host A ───┐
│                                       │         │                      │
│ systemd: ctb-refresh.service          │         │ ctb-client (docker)  │
│   ─ runs `claude -p ok` ~1h before    │         │   ─ POST /sync       │
│     token expiry                      │         │     on boot          │
│   ─ truncate-writes mirror to         │         │   ─ listens for      │
│     /var/lib/claude-token-broker/     │         │     POST /token      │
│       credentials.json                │   HTTPS │     pushes           │
│       claude.json                     │ ◄─────► │   ─ truncate-writes  │
│                                       │ NaCl box│     /var/lib/        │
│ docker: ctb-server                    │         │       agentforge-    │
│   ─ inotify on the mirror             │         │       creds/         │
│   ─ POST /sync (clients register)     │         │                      │
│   ─ pushes updates to all clients     │         └──────────────────────┘
│   ─ sqlite for clients + subscriptions│
│                                       │         (and B, C, D, ... etc)
└───────────────────────────────────────┘
```

### Crypto

NaCl box (curve25519+xsalsa20+poly1305) for every wire message. Mutual
pubkey: server has its keypair, each client has its own. Pubkeys are pasted
in `.env` files (no online pairing handshake — explicitly out of scope).

Replay protection: every inner payload has a 60-second timestamp window and
a per-message random nonce that the receiver caches.

Transport is plain HTTP because all auth + secrecy is application-level.
Add TLS at your edge (caddy/nginx) if you want it.

## Layout

| Package          | What it is                                                     |
|------------------|----------------------------------------------------------------|
| `shared/`        | NaCl box helpers + wire types. Used by server, client, CLI.    |
| `server/`        | Express server, sqlite, file watcher, install scripts.         |
| `client/`        | Express callback + on-boot sync + truncate-write writer.       |
| `cli/`           | `broker-cli`: local sqlite admin tool on the broker host.      |

## Deploy — broker host

Prereqs: `claude` CLI installed and logged in interactively; docker; `python3`,
`flock`.

```sh
# 1. Install the host-side refresh+mirror systemd service.
cd server
./install.sh                    # uses $(id -un) by default

# 2. Build and start the broker container.
cp .env.example .env            # tweak port if needed
./deploy.sh

# Note the server pubkey it prints — clients will need it.
```

`./install.sh` writes the loop script to `/usr/local/bin/`, generates a
systemd unit at `/etc/systemd/system/claude-token-broker-refresh.service`,
creates the mirror dir at `/var/lib/claude-token-broker/`, and enables the
service. Override the user with `CLAUDE_USER=...` if claude is logged in
under a different account.

## Deploy — each client host

Prereqs: docker. Get the broker server's pubkey beforehand.

```sh
cd client
cp .env.example .env
# Edit .env — set CTB_SERVER_URL, CTB_SERVER_PUBKEY, CTB_CALLBACK_URL.
./deploy.sh

# Note the client pubkey it prints. Send it to the broker admin.
```

On the broker host, allowlist the new client:

```sh
cd server
node ../cli/dist/index.js add my-client-name <client-pubkey>
# or with the data dir explicit:
CTB_DATA_DIR=./data npx broker-cli add my-client-name <client-pubkey>
```

The client will retry `/sync` with exponential backoff. As soon as it's
allowlisted, it'll succeed and start receiving token pushes.

## How other containers consume the credentials

The client writes `/var/lib/agentforge-creds/{credentials.json,claude.json}`
on its host (configurable via `CTB_CREDENTIALS_OUT`). Other containers on
the same host RO-mount these files at the user's `~/.claude/` path:

```yaml
volumes:
  - /var/lib/agentforge-creds/credentials.json:/home/<user>/.claude/.credentials.json:ro
  - /var/lib/agentforge-creds/claude.json:/home/<user>/.claude.json:ro
```

The client uses truncate-write (open + ftruncate + write), which preserves
the inode. Container bind mounts on the same path stay valid across every
update.

## Admin

`broker-cli` is a local-only tool that talks to the server's sqlite db:

```sh
broker-cli list                       # list clients + subscriptions
broker-cli add <name> <pubkey>        # allowlist a client
broker-cli remove <name>              # revoke a client
broker-cli pubkey                     # print the broker's own pubkey
```

There is no remote admin API. If you want to run admin from somewhere else,
SSH to the broker host and use the CLI.

## Caveats

- The broker host is the single point of failure. If it goes down, clients
  keep using the last-pushed token until expiry, then fail. Run a backup
  broker if you need HA.
- The broker has plaintext access to your refresh token. Treat the broker
  host like the keys-to-the-kingdom that it is.
- Sharing one set of OAuth credentials across multiple hosts is contrary
  to Anthropic's ToS. This project is offered as infrastructure; you are
  responsible for whether your use is permitted.
