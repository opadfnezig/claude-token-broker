/**
 * Claude Token Broker — server.
 *
 * Single public endpoint: POST /sync — clients register a callback URL and
 * receive the current credentials. Whenever the watched mirror file changes,
 * the broker pushes the new credentials to every registered client.
 */
import express from 'express'
import {
  open,
  seal,
  ReplayCache,
  type SealedEnvelope,
  type SyncRequest,
  type SyncResponse,
} from '@ctb/shared'
import { loadConfig, loadOrInitKeyPair } from './config.js'
import { BrokerDb } from './db.js'
import { broadcastToken } from './push.js'
import { startWatcher, readCredentialsB64 } from './watcher.js'

const cfg = loadConfig()
const keypair = loadOrInitKeyPair(cfg.keysPath)
const db = new BrokerDb(cfg.dbPath)
const replay = new ReplayCache()

const log = (msg: string, meta?: Record<string, unknown>) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...meta }))
}

const app = express()
app.use(express.json({ limit: '64kb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true, pubkey: keypair.publicKey })
})

app.post('/sync', (req, res) => {
  const envelope = req.body as SealedEnvelope
  if (!envelope?.from || !envelope?.nonce || !envelope?.ciphertext) {
    res.status(400).json({ error: 'malformed envelope' })
    return
  }

  // Allowlist check — only registered client pubkeys are accepted.
  const client = db.getClient(envelope.from)
  if (!client) {
    log('sync rejected (unknown pubkey)', { from: envelope.from })
    res.status(401).json({ error: 'unknown client' })
    return
  }

  let opened
  try {
    opened = open<SyncRequest>(envelope, keypair.secretKey, [envelope.from])
  } catch (err) {
    log('sync decrypt failed', {
      from: envelope.from,
      error: err instanceof Error ? err.message : String(err),
    })
    res.status(401).json({ error: 'decrypt failed' })
    return
  }

  if (!replay.check(opened.innerNonce)) {
    res.status(409).json({ error: 'replay' })
    return
  }

  if (!opened.body.callback_url || typeof opened.body.callback_url !== 'string') {
    res.status(400).json({ error: 'missing callback_url' })
    return
  }

  db.upsertSubscription(envelope.from, opened.body.callback_url)
  log('sync', { name: client.name, callback: opened.body.callback_url })

  const credsB64 = readCredentialsB64(cfg.credentialsPath)
  if (!credsB64) {
    res.status(503).json({ error: 'credentials not yet available' })
    return
  }

  const respBody: SyncResponse = { credentials_json_b64: credsB64, server_ts: Date.now() }
  const sealed = seal(respBody, envelope.from, keypair.secretKey)
  res.json(sealed)
})

// Watcher → broadcast on every credential change.
startWatcher({
  path: cfg.credentialsPath,
  debounceMs: 500,
  onChange: async (credsB64) => {
    const result = await broadcastToken(credsB64, {
      db,
      keypair,
      pushTimeoutMs: cfg.pushTimeoutMs,
      pushMaxFailures: cfg.pushMaxFailures,
      log,
    })
    log('broadcast', result)
  },
  log,
})

app.listen(cfg.port, () => {
  log('server up', { port: cfg.port, pubkey: keypair.publicKey })
})
