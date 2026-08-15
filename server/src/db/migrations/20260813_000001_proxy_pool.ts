// Migration: outbound proxy pool (#821)
// Created: 2026-08-13
//
// DOWN: reversible
//
// One row per configured outbound proxy. type is the URL scheme (http, https,
// socks4, socks4a, socks5, socks5h); host/port are the socket endpoint and
// username/encrypted_password the optional auth (the password shares the
// AES-256-GCM layer of api_keys via lib/crypto.ts). Enabled rows participate in
// the pool; the router assigns them to a provider only after it repeatedly
// rate-limits (see services/proxy-pool.ts). status/latency_ms/last_checked_at
// are the cached result of the last connectivity probe against Google's
// generate_204 endpoint; 'unknown' means never probed.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT,
      encrypted_password TEXT,
      iv TEXT,
      auth_tag TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'unknown',
      latency_ms INTEGER,
      last_checked_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS proxies;');
}