/**
 * NaCl box mutual-pubkey crypto for the broker wire protocol.
 *
 * - Both sides have a curve25519 keypair (32-byte pub/priv).
 * - Pubkeys are exchanged out-of-band (CLI paste), not negotiated online.
 * - Every message is sealed with `nacl.box(plaintext, nonce, peerPub, mySecret)`.
 *   Authenticity is automatic: only the holder of the matching secret key can
 *   produce a ciphertext that decrypts under the peer's perspective.
 * - Timestamp + per-message nonce in the inner payload defends against replay.
 */
import nacl from 'tweetnacl'
import naclUtil from 'tweetnacl-util'
import { randomBytes } from 'crypto'
import type { SealedEnvelope, InnerPayload } from './types.js'

const { encodeBase64, decodeBase64 } = naclUtil

export interface KeyPair {
  publicKey: string  // base64
  secretKey: string  // base64
}

export function generateKeyPair(): KeyPair {
  const kp = nacl.box.keyPair()
  return {
    publicKey: encodeBase64(kp.publicKey),
    secretKey: encodeBase64(kp.secretKey),
  }
}

export function pubkeyFromSecret(secretKeyB64: string): string {
  const sk = decodeBase64(secretKeyB64)
  const kp = nacl.box.keyPair.fromSecretKey(sk)
  return encodeBase64(kp.publicKey)
}

const REPLAY_WINDOW_MS = 60_000

/**
 * Wraps `body` into a fully sealed envelope addressed to `peerPubB64`.
 */
export function seal<T>(body: T, peerPubB64: string, mySecretB64: string): SealedEnvelope {
  const peerPub = decodeBase64(peerPubB64)
  const mySecret = decodeBase64(mySecretB64)
  const myPub = nacl.box.keyPair.fromSecretKey(mySecret).publicKey

  const inner: InnerPayload<T> = {
    ts: Date.now(),
    nonce: randomBytes(16).toString('hex'),
    body,
  }

  const plaintext = naclUtil.decodeUTF8(JSON.stringify(inner))
  const nonceBytes = nacl.randomBytes(nacl.box.nonceLength)
  const ciphertext = nacl.box(plaintext, nonceBytes, peerPub, mySecret)

  return {
    from: encodeBase64(myPub),
    nonce: encodeBase64(nonceBytes),
    ciphertext: encodeBase64(ciphertext),
  }
}

export interface OpenResult<T> {
  body: T
  /** Sender's pubkey, verified by successful decryption. */
  senderPubkey: string
  /** Inner payload nonce (string), for the caller's replay cache. */
  innerNonce: string
}

/**
 * Decrypts and validates a SealedEnvelope. Throws if:
 * - Envelope claims a sender pubkey that isn't in `expectedSenderPubkeysB64`
 *   (when provided — pass `null` to accept any sender).
 * - Decryption fails (auth tag mismatch).
 * - Inner timestamp is outside the replay window.
 */
export function open<T>(
  envelope: SealedEnvelope,
  mySecretB64: string,
  expectedSenderPubkeysB64: string[] | null,
): OpenResult<T> {
  if (expectedSenderPubkeysB64 && !expectedSenderPubkeysB64.includes(envelope.from)) {
    throw new Error(`unknown sender pubkey: ${envelope.from}`)
  }

  const mySecret = decodeBase64(mySecretB64)
  const peerPub = decodeBase64(envelope.from)
  const nonce = decodeBase64(envelope.nonce)
  const ciphertext = decodeBase64(envelope.ciphertext)

  const plaintext = nacl.box.open(ciphertext, nonce, peerPub, mySecret)
  if (!plaintext) {
    throw new Error('decryption failed (bad ciphertext, nonce, or peer pubkey)')
  }

  const inner = JSON.parse(naclUtil.encodeUTF8(plaintext)) as InnerPayload<T>
  const skew = Math.abs(Date.now() - inner.ts)
  if (skew > REPLAY_WINDOW_MS) {
    throw new Error(`stale message: ${skew}ms skew`)
  }

  return {
    body: inner.body,
    senderPubkey: envelope.from,
    innerNonce: inner.nonce,
  }
}

/** In-process replay cache. 5-minute window, leaks small. */
export class ReplayCache {
  private seen = new Map<string, number>()
  private readonly windowMs = 5 * 60 * 1000

  check(nonce: string): boolean {
    this.gc()
    if (this.seen.has(nonce)) return false
    this.seen.set(nonce, Date.now())
    return true
  }

  private gc() {
    if (this.seen.size < 10000) return
    const cutoff = Date.now() - this.windowMs
    for (const [k, t] of this.seen) {
      if (t < cutoff) this.seen.delete(k)
    }
  }
}
