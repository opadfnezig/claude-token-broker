import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

export interface ClientRow {
  pubkey: string
  name: string
  added_at: number
}

export interface SubscriptionRow {
  pubkey: string
  callback_url: string
  last_seen: number
  fail_count: number
}

export class BrokerDb {
  private db: Database.Database

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        pubkey     TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        added_at   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        pubkey       TEXT PRIMARY KEY REFERENCES clients(pubkey) ON DELETE CASCADE,
        callback_url TEXT NOT NULL,
        last_seen    INTEGER NOT NULL,
        fail_count   INTEGER NOT NULL DEFAULT 0
      );
    `)
  }

  addClient(name: string, pubkey: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO clients (pubkey, name, added_at) VALUES (?, ?, ?)')
      .run(pubkey, name, Date.now())
  }

  removeClient(name: string): boolean {
    const r = this.db.prepare('DELETE FROM clients WHERE name = ?').run(name)
    return r.changes > 0
  }

  removeClientByPubkey(pubkey: string): boolean {
    const r = this.db.prepare('DELETE FROM clients WHERE pubkey = ?').run(pubkey)
    return r.changes > 0
  }

  listClients(): ClientRow[] {
    return this.db.prepare('SELECT * FROM clients ORDER BY added_at DESC').all() as ClientRow[]
  }

  getClient(pubkey: string): ClientRow | null {
    return (
      (this.db.prepare('SELECT * FROM clients WHERE pubkey = ?').get(pubkey) as ClientRow) ?? null
    )
  }

  upsertSubscription(pubkey: string, callbackUrl: string): void {
    this.db
      .prepare(
        `INSERT INTO subscriptions (pubkey, callback_url, last_seen, fail_count)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(pubkey) DO UPDATE SET
           callback_url = excluded.callback_url,
           last_seen    = excluded.last_seen,
           fail_count   = 0`,
      )
      .run(pubkey, callbackUrl, Date.now())
  }

  listSubscriptions(): SubscriptionRow[] {
    return this.db.prepare('SELECT * FROM subscriptions').all() as SubscriptionRow[]
  }

  listSubscriptionsWithNames(): (SubscriptionRow & { name: string })[] {
    return this.db
      .prepare(
        `SELECT s.*, c.name AS name
         FROM subscriptions s
         JOIN clients c USING (pubkey)`,
      )
      .all() as (SubscriptionRow & { name: string })[]
  }

  bumpFail(pubkey: string): number {
    const r = this.db
      .prepare(
        `UPDATE subscriptions
         SET fail_count = fail_count + 1
         WHERE pubkey = ?
         RETURNING fail_count`,
      )
      .get(pubkey) as { fail_count: number } | undefined
    return r?.fail_count ?? 0
  }

  resetFail(pubkey: string): void {
    this.db
      .prepare('UPDATE subscriptions SET fail_count = 0, last_seen = ? WHERE pubkey = ?')
      .run(Date.now(), pubkey)
  }

  dropSubscription(pubkey: string): void {
    this.db.prepare('DELETE FROM subscriptions WHERE pubkey = ?').run(pubkey)
  }
}
