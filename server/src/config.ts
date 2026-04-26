import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { generateKeyPair, type KeyPair } from '@ctb/shared'

export interface Config {
  port: number
  dbPath: string
  credentialsPath: string
  keysPath: string
  pushTimeoutMs: number
  pushMaxFailures: number
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.CTB_PORT ?? 9990),
    dbPath: process.env.CTB_DB_PATH ?? '/data/clients.sqlite',
    credentialsPath: process.env.CTB_CREDENTIALS_PATH ?? '/mirror/credentials.json',
    keysPath: process.env.CTB_KEYS_PATH ?? '/data/server-keypair.json',
    pushTimeoutMs: Number(process.env.CTB_PUSH_TIMEOUT_MS ?? 5000),
    pushMaxFailures: Number(process.env.CTB_PUSH_MAX_FAILURES ?? 3),
  }
}

/** Load existing keypair from disk, generate+persist if missing. */
export function loadOrInitKeyPair(path: string): KeyPair {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8'))
  }
  mkdirSync(dirname(path), { recursive: true })
  const kp = generateKeyPair()
  writeFileSync(path, JSON.stringify(kp, null, 2), { mode: 0o600 })
  return kp
}
