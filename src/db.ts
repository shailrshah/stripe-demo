import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id                          TEXT PRIMARY KEY,
  product_id                  TEXT    NOT NULL,
  amount_cents                INTEGER NOT NULL CHECK (amount_cents > 0),
  currency                    TEXT    NOT NULL DEFAULT 'usd',
  method                      TEXT    NOT NULL CHECK (method IN ('checkout', 'embedded')),
  status                      TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'paid', 'failed', 'canceled', 'refunded')),
  stripe_checkout_session_id  TEXT UNIQUE,
  stripe_payment_intent_id    TEXT UNIQUE,
  created_at                  TEXT    NOT NULL,
  updated_at                  TEXT    NOT NULL
);

-- Dedupe ledger: exactly one row per Stripe event ever processed
CREATE TABLE IF NOT EXISTS processed_events (
  stripe_event_id  TEXT PRIMARY KEY,
  processed_at     TEXT NOT NULL
);

-- Audit log: one row per verified delivery, duplicates included
CREATE TABLE IF NOT EXISTS webhook_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_event_id    TEXT NOT NULL,
  type               TEXT NOT NULL,
  stripe_created_at  TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  order_id           TEXT REFERENCES orders(id),
  outcome            TEXT NOT NULL CHECK (outcome IN
                       ('applied', 'ignored_duplicate', 'ignored_transition',
                        'ignored_unknown_order', 'ignored_unhandled_type')),
  detail             TEXT
);
CREATE INDEX IF NOT EXISTS webhook_events_order_idx ON webhook_events(order_id);
`;

export function openDb(path) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}
