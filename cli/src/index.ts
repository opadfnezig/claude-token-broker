#!/usr/bin/env node
/**
 * broker-cli — local admin tool for the broker server. Talks directly to the
 * sqlite db and the server's keypair file. No HTTP, no auth — assumes you
 * are on the broker host with read access to its data dir.
 *
 * Usage:
 *   broker-cli add <name> <pubkey>     Allowlist a client.
 *   broker-cli list                    List clients + active subscriptions.
 *   broker-cli remove <name>           Revoke a client.
 *   broker-cli pubkey                  Print the broker server's pubkey.
 *
 * Env:
 *   CTB_DATA_DIR  — server data dir (default ./data, expecting clients.sqlite
 *                   + server-keypair.json inside).
 */
import Database from 'better-sqlite3'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const dataDir = process.env.CTB_DATA_DIR ?? './data'
const dbPath = join(dataDir, 'clients.sqlite')
const keysPath = join(dataDir, 'server-keypair.json')

interface Cmd {
  args: string[]
}

function usage(code = 0): never {
  console.log(`broker-cli — local admin for the claude-token-broker server.

USAGE:
  broker-cli add <name> <pubkey>     Allowlist a client (overwrites if exists).
  broker-cli list                    List clients with subscription status.
  broker-cli remove <name>           Revoke a client (drops subscription too).
  broker-cli pubkey                  Print the broker server's pubkey.

Reads from CTB_DATA_DIR (default ./data).`)
  process.exit(code)
}

function openDb(): Database.Database {
  if (!existsSync(dbPath)) {
    console.error(`error: no db at ${dbPath} — is the server initialised?`)
    process.exit(1)
  }
  return new Database(dbPath)
}

function cmdAdd({ args }: Cmd): void {
  if (args.length !== 2) usage(1)
  const [name, pubkey] = args
  if (!/^[A-Za-z0-9+/=]{40,}$/.test(pubkey)) {
    console.error('error: pubkey does not look like base64 nacl box pubkey')
    process.exit(1)
  }
  const db = openDb()
  db.prepare(
    `INSERT INTO clients (pubkey, name, added_at) VALUES (?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET name = excluded.name`,
  ).run(pubkey, name, Date.now())
  console.log(`added: ${name} → ${pubkey.slice(0, 20)}...`)
}

function cmdList(): void {
  const db = openDb()
  const rows = db
    .prepare(
      `SELECT c.pubkey, c.name, c.added_at,
              s.callback_url, s.last_seen, s.fail_count
       FROM clients c
       LEFT JOIN subscriptions s USING (pubkey)
       ORDER BY c.added_at DESC`,
    )
    .all() as Array<{
    pubkey: string
    name: string
    added_at: number
    callback_url: string | null
    last_seen: number | null
    fail_count: number | null
  }>

  if (rows.length === 0) {
    console.log('(no clients)')
    return
  }
  for (const r of rows) {
    const sub = r.callback_url
      ? `subscribed → ${r.callback_url} (last_seen=${new Date(r.last_seen!).toISOString()}, fails=${r.fail_count})`
      : 'no subscription'
    console.log(`${r.name}  ${r.pubkey.slice(0, 20)}...  ${sub}`)
  }
}

function cmdRemove({ args }: Cmd): void {
  if (args.length !== 1) usage(1)
  const [name] = args
  const db = openDb()
  const r = db.prepare('DELETE FROM clients WHERE name = ?').run(name)
  if (r.changes === 0) {
    console.error(`error: no client named '${name}'`)
    process.exit(1)
  }
  console.log(`removed: ${name}`)
}

function cmdPubkey(): void {
  if (!existsSync(keysPath)) {
    console.error(`error: no keypair at ${keysPath} — is the server initialised?`)
    process.exit(1)
  }
  const kp = JSON.parse(readFileSync(keysPath, 'utf-8'))
  console.log(kp.publicKey)
}

const [, , sub, ...rest] = process.argv
const cmd: Cmd = { args: rest }

switch (sub) {
  case 'add':
    cmdAdd(cmd)
    break
  case 'list':
    cmdList()
    break
  case 'remove':
  case 'rm':
    cmdRemove(cmd)
    break
  case 'pubkey':
    cmdPubkey()
    break
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    usage(0)
    break
  default:
    console.error(`unknown command: ${sub}`)
    usage(1)
}
