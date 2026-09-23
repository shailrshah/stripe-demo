import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './helpers/test-server.js';
import { paymentIntentSucceeded } from './helpers/stripe-events.js';

const dir = mkdtempSync(join(tmpdir(), 'stripe-demo-persist-'));
const databasePath = join(dir, 'data', 'stripe-demo.db');

let orderId;

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function getJson(url) {
  const res = await fetch(url);
  assert.equal(res.status, 200);
  return res.json();
}

test('orders, event log and dedupe ledger survive a server restart', async () => {
  assert.equal(existsSync(join(dir, 'data')), false);

  const a = await startTestServer({ databasePath });
  let event;
  try {
    assert.ok(existsSync(databasePath));

    const created = await fetch(`${a.url}/api/payment-intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'duck' }),
    });
    assert.equal(created.status, 201);
    ({ orderId } = await created.json());

    const { order } = await getJson(`${a.url}/api/orders/${orderId}`);
    event = paymentIntentSucceeded({ orderId, paymentIntentId: order.stripePaymentIntentId });
    const paid = await a.postWebhook(event);
    assert.equal(paid.status, 200);
    assert.equal(paid.body.outcome, 'applied');
  } finally {
    await a.close();
  }

  const b = await startTestServer({ databasePath });
  try {
    const reopened = await getJson(`${b.url}/api/orders/${orderId}`);
    assert.equal(reopened.order.status, 'paid');
    assert.equal(reopened.events.length, 1);
    assert.equal(reopened.events[0].stripeEventId, event.id);
    assert.equal(reopened.events[0].outcome, 'applied');

    const events = await getJson(`${b.url}/api/events`);
    assert.ok(events.some((e) => e.stripeEventId === event.id && e.outcome === 'applied'));

    const resent = await b.postWebhook(event);
    assert.equal(resent.status, 200);
    assert.equal(resent.body.outcome, 'ignored_duplicate');

    const afterResend = await getJson(`${b.url}/api/orders/${orderId}`);
    assert.equal(afterResend.order.status, 'paid');
    assert.deepEqual(
      afterResend.events.map((e) => [e.stripeEventId, e.outcome]),
      [
        [event.id, 'applied'],
        [event.id, 'ignored_duplicate'],
      ],
    );
  } finally {
    await b.close();
  }
});

test('reopening the same database again keeps the order listed', async () => {
  assert.ok(orderId, 'depends on the restart test having created an order');
  const c = await startTestServer({ databasePath });
  try {
    const orders = await getJson(`${c.url}/api/orders`);
    const order = orders.find((o) => o.id === orderId);
    assert.ok(order);
    assert.equal(order.status, 'paid');
  } finally {
    await c.close();
  }
});
