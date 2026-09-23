import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';

const tempRoot = mkdtempSync(join(tmpdir(), 'stripe-demo-db-'));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

const NOW = '2026-01-01T00:00:00.000Z';

function insertOrder(db: DatabaseSync, overrides: Record<string, string | number> = {}) {
  const row = {
    id: 'ord_0123456789abcdef',
    product_id: 'duck',
    amount_cents: 500,
    method: 'checkout',
    status: 'pending',
    ...overrides,
  };
  db.prepare(
    `INSERT INTO orders (id, product_id, amount_cents, method, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.product_id, row.amount_cents, row.method, row?.status, NOW, NOW);
}

function insertEvent(db: DatabaseSync, outcome: string) {
  db.prepare(
    `INSERT INTO webhook_events (stripe_event_id, type, stripe_created_at, received_at, outcome)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('evt_1', 'payment_intent.succeeded', NOW, NOW, outcome);
}

test('creates all three tables and the index', () => {
  const db = openDb(':memory:');
  const names = (type: string) =>
    db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type).map((r) => r.name);
  const tables = names('table');
  for (const t of ['orders', 'processed_events', 'webhook_events']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  assert.ok(names('index').includes('webhook_events_order_idx'));
  db.close();
});

test('sets the pragmas on a file DB', () => {
  const db = openDb(join(tempRoot, 'pragmas.db'));
  assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA busy_timeout').get()?.timeout, 5000);
  db.close();
});

test('applies column defaults', () => {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO orders (id, product_id, amount_cents, method, created_at, updated_at)
     VALUES ('ord_x', 'duck', 500, 'embedded', ?, ?)`,
  ).run(NOW, NOW);
  const row = db.prepare("SELECT currency, status FROM orders WHERE id = 'ord_x'").get();
  assert.equal(row?.currency, 'usd');
  assert.equal(row?.status, 'pending');
  db.close();
});

test('CHECK constraints reject bad values', () => {
  const db = openDb(':memory:');
  const constraint = { code: 'ERR_SQLITE_ERROR', message: /CHECK constraint failed/ };
  assert.throws(() => insertOrder(db, { status: 'shipped' }), constraint);
  assert.throws(() => insertOrder(db, { method: 'cash' }), constraint);
  assert.throws(() => insertOrder(db, { amount_cents: 0 }), constraint);
  assert.throws(() => insertOrder(db, { amount_cents: -1 }), constraint);
  assert.throws(() => insertEvent(db, 'maybe'), constraint);

  insertOrder(db);
  insertEvent(db, 'applied');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get()?.n, 1);
  db.close();
});

test('reopening a file DB keeps its rows', () => {
  const path = join(tempRoot, 'persist.db');
  const first = openDb(path);
  insertOrder(first);
  first.prepare('INSERT INTO processed_events VALUES (?, ?)').run('evt_1', NOW);
  first.close();

  const second = openDb(path);
  const order = second.prepare('SELECT * FROM orders').get();
  assert.equal(order?.id, 'ord_0123456789abcdef');
  assert.equal(order?.amount_cents, 500);
  assert.equal(second.prepare('SELECT COUNT(*) AS n FROM processed_events').get()?.n, 1);
  second.close();

  const third = openDb(path);
  assert.equal(third.prepare('SELECT COUNT(*) AS n FROM orders').get()?.n, 1);
  third.close();
});

test('creates a missing parent directory', () => {
  const dir = join(tempRoot, 'nested', 'data');
  assert.equal(existsSync(dir), false);
  const db = openDb(join(dir, 'stripe-demo.db'));
  assert.ok(existsSync(dir));
  db.close();
});
