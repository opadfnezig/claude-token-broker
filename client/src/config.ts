import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { generateKeyPair, type KeyPair } from '@ctb/shared'

export interface Config {
  serverUrl: string
  serverPubkey: string
  callbackUrl: string
  callbackPort: number
  keysPath: string
  credentialsOutPath: string
  configOutPath: string
  syncIntervalMs: number
}

export function loadConfig(): Config {
  const must = (key: string): string => {
    const v = process.env[key]
    if (!v) throw new Error(`${key} is required`)
    return v
  }

  return {
    serverUrl: must('CTB_SERVER_URL'),
    serverPubkey: must('CTB_SERVER_PUBKEY'),
    callbackUrl: must('CTB_CALLBACK_URL'),
    callbackPort: Number(process.env.CTB_CALLBACK_PORT ?? 9991),
    keysPath: process.env.CTB_KEYS_PATH ?? '/data/client-keypair.json',
    credentialsOutPath: process.env.CTB_CREDENTIALS_OUT ?? '/out/credentials.json',
    configOutPath: process.env.CTB_CONFIG_OUT ?? '/out/claude.json',
    syncIntervalMs: Number(process.env.CTB_SYNC_INTERVAL_MS ?? 5 * 60 * 1000),
  }
}

export function loadOrInitKeyPair(path: string): KeyPair {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8'))
  }
  mkdirSync(dirname(path), { recursive: true })
  const kp = generateKeyPair()
  writeFileSync(path, JSON.stringify(kp, null, 2), { mode: 0o600 })
  return kp
}
