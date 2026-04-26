/**
 * Claude Token Broker — client.
 *
 * On boot:
 *   1. Load (or generate) own keypair.
 *   2. POST /sync to the broker with our callback URL → receive current token.
 *   3. Listen on callback port for token pushes.
 *   4. Re-sync periodically as a heartbeat (so the broker can detect us
 *      offline and clean up stale subscriptions; also self-heals if our
 *      subscription was dropped while we were offline).
 */
import express from 'express'
import {
  open,
  seal,
  ReplayCache,
  type SealedEnvelope,
  type SyncRequest,
  type SyncResponse,
  type TokenPush,
  type TokenPushAck,
} from '@ctb/shared'
import { loadConfig, loadOrInitKeyPair } from './config.js'
import { writeInPlace } from './writer.js'

const cfg = loadConfig()
const keypair = loadOrInitKeyPair(cfg.keysPath)
const replay = new ReplayCache()

const log = (msg: string, meta?: Record<string, unknown>) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...meta }))
}

function applyCredentials(b64: string): void {
  const buf = Buffer.from(b64, 'base64')
  writeInPlace(cfg.credentialsOutPath, buf)
  log('credentials written', { path: cfg.credentialsOutPath, bytes: buf.length })
}

async function syncOnce(): Promise<void> {
  const body: SyncRequest = { callback_url: cfg.callbackUrl }
  const envelope = seal(body, cfg.serverPubkey, keypair.secretKey)

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 10_000)
  let res: Response
  try {
    res = await fetch(`${cfg.serverUrl}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(t)
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`sync HTTP ${res.status}: ${txt.slice(0, 200)}`)
  }

  const sealedResp = (await res.json()) as SealedEnvelope
  const opened = open<SyncResponse>(sealedResp, keypair.secretKey, [cfg.serverPubkey])
  if (!replay.check(opened.innerNonce)) {
    throw new Error('replay on sync response')
  }
  applyCredentials(opened.body.credentials_json_b64)
}

async function syncWithRetry(): Promise<void> {
  let backoff = 1000
  for (let i = 0; i < 8; i++) {
    try {
      await syncOnce()
      log('sync ok')
      return
    } catch (err) {
      log('sync failed, retrying', {
        attempt: i + 1,
        error: err instanceof Error ? err.message : String(err),
        backoff_ms: backoff,
      })
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 30_000)
    }
  }
  log('sync gave up after retries')
}

const app = express()
app.use(express.json({ limit: '64kb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true, pubkey: keypair.publicKey })
})

app.post('/token', (req, res) => {
  const envelope = req.body as SealedEnvelope
  if (!envelope?.from || !envelope?.nonce || !envelope?.ciphertext) {
    res.status(400).json({ error: 'malformed envelope' })
    return
  }
  if (envelope.from !== cfg.serverPubkey) {
    log('push from unknown sender', { from: envelope.from })
    res.status(401).json({ error: 'unknown sender' })
    return
  }

  let opened
  try {
    opened = open<TokenPush>(envelope, keypair.secretKey, [cfg.serverPubkey])
  } catch (err) {
    log('push decrypt failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    res.status(401).json({ error: 'decrypt failed' })
    return
  }

  if (!replay.check(opened.innerNonce)) {
    res.status(409).json({ error: 'replay' })
    return
  }

  applyCredentials(opened.body.credentials_json_b64)
  const ack: TokenPushAck = { received_ts: Date.now() }
  res.json(ack)
})

app.listen(cfg.callbackPort, () => {
  log('client up', {
    callback_port: cfg.callbackPort,
    callback_url: cfg.callbackUrl,
    pubkey: keypair.publicKey,
  })

  // Initial sync, then periodic re-sync.
  void syncWithRetry()
  setInterval(() => void syncWithRetry(), cfg.syncIntervalMs)
})
