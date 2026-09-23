import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { createEventLog } from '../src/event-log.ts';

const NOW = '2026-01-01T00:00:00.000Z';

function insertOrder(db, id) {
  db.prepare(
    `INSERT INTO orders (id, product_id, amount_cents, method, created_at, updated_at)
     VALUES (?, 'duck', 500, 'checkout', ?, ?)`,
  ).run(id, NOW, NOW);
}

function makeEvent(id, overrides = {}) {
  return { id, type: 'payment_intent.succeeded', created: 1767225600, ...overrides };
}

function setup() {
  const db = openDb(':memory:');
  let tick = 0;
  const now = () => new Date(Date.parse(NOW) + 1000 * tick++);
  return { db, eventLog: createEventLog(db, { now }) };
}

test('isProcessed and markProcessed track event IDs', () => {
  const { db, eventLog } = setup();
  assert.equal(eventLog.isProcessed('evt_1'), false);
  eventLog.markProcessed('evt_1');
  assert.equal(eventLog.isProcessed('evt_1'), true);
  assert.equal(eventLog.isProcessed('evt_2'), false);

  const row = db.prepare('SELECT * FROM processed_events').get();
  assert.equal(row.stripe_event_id, 'evt_1');
  assert.equal(row.processed_at, NOW);
  db.close();
});

test('marking the same event twice throws a constraint error', () => {
  const { db, eventLog } = setup();
  eventLog.markProcessed('evt_1');
  assert.throws(() => eventLog.markProcessed('evt_1'), {
    code: 'ERR_SQLITE_ERROR',
    message: /UNIQUE constraint failed/,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM processed_events').get().n, 1);
  db.close();
});

test('append stores every field', () => {
  const { db, eventLog } = setup();
  insertOrder(db, 'ord_a');
  eventLog.append({
    event: makeEvent('evt_1', { type: 'charge.refunded', created: 1767225600 }),
    orderId: 'ord_a',
    outcome: 'applied',
    detail: 'paid → refunded',
  });

  const [entry] = eventLog.list();
  assert.deepEqual(entry, {
    id: entry.id,
    stripeEventId: 'evt_1',
    type: 'charge.refunded',
    stripeCreatedAt: '2026-01-01T00:00:00.000Z',
    receivedAt: NOW,
    orderId: 'ord_a',
    outcome: 'applied',
    detail: 'paid → refunded',
  });
  assert.equal(typeof entry.id, 'number');
  db.close();
});

test('append accepts a null orderId and a missing detail', () => {
  const { db, eventLog } = setup();
  eventLog.append({ event: makeEvent('evt_1'), orderId: null, outcome: 'ignored_unknown_order' });
  const [entry] = eventLog.list();
  assert.equal(entry.orderId, null);
  assert.equal(entry.detail, null);
  assert.equal(entry.outcome, 'ignored_unknown_order');
  db.close();
});

test('append keeps duplicate deliveries of the same event', () => {
  const { db, eventLog } = setup();
  eventLog.append({ event: makeEvent('evt_1'), orderId: null, outcome: 'ignored_unknown_order' });
  eventLog.append({ event: makeEvent('evt_1'), orderId: null, outcome: 'ignored_duplicate' });
  assert.deepEqual(
    eventLog.list().map((e) => e.outcome),
    ['ignored_duplicate', 'ignored_unknown_order'],
  );
  db.close();
});

test('list is newest first and respects limit', () => {
  const { db, eventLog } = setup();
  for (const id of ['evt_1', 'evt_2', 'evt_3']) {
    eventLog.append({ event: makeEvent(id), orderId: null, outcome: 'ignored_unhandled_type' });
  }
  assert.deepEqual(eventLog.list().map((e) => e.stripeEventId), ['evt_3', 'evt_2', 'evt_1']);
  assert.deepEqual(eventLog.list({ limit: 2 }).map((e) => e.stripeEventId), ['evt_3', 'evt_2']);
  db.close();
});

test('list defaults to 200 entries', () => {
  const { db, eventLog } = setup();
  for (let i = 0; i < 205; i++) {
    eventLog.append({ event: makeEvent(`evt_${i}`), orderId: null, outcome: 'ignored_unhandled_type' });
  }
  const entries = eventLog.list();
  assert.equal(entries.length, 200);
  assert.equal(entries[0].stripeEventId, 'evt_204');
  db.close();
});

test('listForOrder is oldest first and only includes that order', () => {
  const { db, eventLog } = setup();
  insertOrder(db, 'ord_a');
  insertOrder(db, 'ord_b');
  eventLog.append({ event: makeEvent('evt_1'), orderId: 'ord_a', outcome: 'applied' });
  eventLog.append({ event: makeEvent('evt_2'), orderId: 'ord_b', outcome: 'applied' });
  eventLog.append({ event: makeEvent('evt_3'), orderId: null, outcome: 'ignored_unknown_order' });
  eventLog.append({ event: makeEvent('evt_4'), orderId: 'ord_a', outcome: 'ignored_transition' });

  assert.deepEqual(eventLog.listForOrder('ord_a').map((e) => e.stripeEventId), ['evt_1', 'evt_4']);
  assert.deepEqual(eventLog.listForOrder('ord_b').map((e) => e.stripeEventId), ['evt_2']);
  assert.deepEqual(eventLog.listForOrder('ord_missing'), []);
  db.close();
});
