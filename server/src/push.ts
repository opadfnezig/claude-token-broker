import { seal, type KeyPair } from '@ctb/shared'
import type { TokenPush, SealedEnvelope } from '@ctb/shared'
import type { BrokerDb } from './db.js'

export interface PushDeps {
  db: BrokerDb
  keypair: KeyPair
  pushTimeoutMs: number
  pushMaxFailures: number
  log: (msg: string, meta?: Record<string, unknown>) => void
}

/**
 * Broadcasts a token to every active subscription. Increments fail_count on
 * push failure; drops the subscription once it crosses pushMaxFailures so
 * dead clients stop costing us per-refresh roundtrips. Allowlist (clients
 * table) is NOT touched — the client just re-subscribes via /sync next time
 * it boots.
 */
export async function broadcastToken(
  credentialsJsonB64: string,
  deps: PushDeps,
): Promise<{ pushed: number; dropped: string[] }> {
  const subs = deps.db.listSubscriptions()
  const dropped: string[] = []
  let pushed = 0

  await Promise.all(
    subs.map(async (sub) => {
      const ok = await pushOne(sub.callback_url, sub.pubkey, credentialsJsonB64, deps)
      if (ok) {
        deps.db.resetFail(sub.pubkey)
        pushed++
      } else {
        const fc = deps.db.bumpFail(sub.pubkey)
        if (fc >= deps.pushMaxFailures) {
          deps.db.dropSubscription(sub.pubkey)
          dropped.push(sub.pubkey)
          deps.log('subscription dropped (too many failures)', {
            pubkey: sub.pubkey,
            url: sub.callback_url,
          })
        }
      }
    }),
  )

  return { pushed, dropped }
}

async function pushOne(
  url: string,
  clientPubkey: string,
  credentialsJsonB64: string,
  deps: PushDeps,
): Promise<boolean> {
  const body: TokenPush = {
    credentials_json_b64: credentialsJsonB64,
    server_ts: Date.now(),
  }
  const envelope: SealedEnvelope = seal(body, clientPubkey, deps.keypair.secretKey)

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), deps.pushTimeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
      signal: ctrl.signal,
    })
    clearTimeout(t)
    return res.ok
  } catch (err) {
    clearTimeout(t)
    deps.log('push failed', {
      url,
      pubkey: clientPubkey,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
