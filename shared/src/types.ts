/**
 * Wire types shared by server and client. All strings are base64.
 *
 * Every wire message is a SealedEnvelope: outer auth via NaCl box (mutual
 * pubkey crypto) + inner JSON payload. Replay protection via timestamp +
 * nonce.
 */

export interface SealedEnvelope {
  /** Sender's NaCl box public key (base64). */
  from: string
  /** Random 24-byte nonce, base64. */
  nonce: string
  /** Encrypted JSON payload (encrypted with nacl.box, base64). */
  ciphertext: string
}

/** Plaintext that goes inside SealedEnvelope.ciphertext. */
export interface InnerPayload<T = unknown> {
  /** Unix ms. Receiver rejects if abs(now - ts) > 60_000. */
  ts: number
  /** Random 32-char nonce. Receiver caches recent ones to reject replays. */
  nonce: string
  body: T
}

/** Client → Server: register/refresh subscription, get current token. */
export interface SyncRequest {
  /** Where the server should POST token updates. */
  callback_url: string
}

export interface SyncResponse {
  /** Current claudeAiOauth credentials JSON, base64-encoded so we don't
   * have nested escaping fun. */
  credentials_json_b64: string
  /** Echoed for clock-skew diagnostics. */
  server_ts: number
}

/** Server → Client: token update push. */
export interface TokenPush {
  credentials_json_b64: string
  server_ts: number
}

export interface TokenPushAck {
  /** Echoed back for the server's log. No real semantic content. */
  received_ts: number
}
