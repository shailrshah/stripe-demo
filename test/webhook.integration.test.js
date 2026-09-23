import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/test-server.js';
import {
  checkoutSessionCompleted,
  checkoutSessionExpired,
  paymentIntentSucceeded,
  paymentIntentFailed,
  chargeRefunded,
  unhandled,
  sign,
} from './helpers/stripe-events.js';

async function createEmbeddedOrder(srv) {
  const res = await fetch(`${srv.url}/api/payment-intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productId: 'duck' }),
  });
  assert.equal(res.status, 201);
  const { orderId } = await res.json();
  return getOrder(srv, orderId);
}

async function createCheckoutOrder(srv) {
  const res = await fetch(`${srv.url}/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'productId=duck',
    redirect: 'manual',
  });
  assert.equal(res.status, 303);
  const sessionId = new URL(res.headers.get('location')).pathname.split('/').pop();
  const orders = await (await fetch(`${srv.url}/api/orders`)).json();
  const order = orders.find((o) => o.stripeCheckoutSessionId === sessionId);
  assert.ok(order, 'checkout order should be listed');
  return order;
}

async function getOrder(srv, orderId) {
  const res = await fetch(`${srv.url}/api/orders/${orderId}`);
  assert.equal(res.status, 200);
  return (await res.json()).order;
}

function orderRow(srv, orderId) {
  return srv.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

function logRows(srv, stripeEventId) {
  return srv.db
    .prepare('SELECT * FROM webhook_events WHERE stripe_event_id = ? ORDER BY id')
    .all(stripeEventId);
}

function isProcessed(srv, stripeEventId) {
  return srv.db.prepare('SELECT 1 FROM processed_events WHERE stripe_event_id = ?').get(stripeEventId) !== undefined;
}

function count(srv, table) {
  return srv.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function assertApplied(res) {
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { received: true, outcome: 'applied' });
}

describe('signature verification', () => {
  let srv;
  let order;
  let event;

  before(async () => {
    srv = await startTestServer();
    order = await createEmbeddedOrder(srv);
  });
  after(async () => {
    await srv.close();
  });
  beforeEach(() => {
    event = paymentIntentSucceeded({ orderId: order.id, paymentIntentId: order.stripePaymentIntentId });
  });

  function assertRejected(res) {
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message);
    assert.equal(orderRow(srv, order.id).status, 'pending');
    assert.equal(count(srv, 'webhook_events'), 0);
    assert.equal(count(srv, 'processed_events'), 0);
  }

  test('rejects a body that differs from the signed one', async () => {
    const before = orderRow(srv, order.id);
    const { header } = sign(event, 'whsec_test_secret');
    const tampered = structuredClone(event);
    tampered.data.object.amount = 1;
    assertRejected(await srv.postWebhook(tampered, { header }));
    assert.deepEqual(orderRow(srv, order.id), before);
  });

  test('rejects a signature made with the wrong secret', async () => {
    const before = orderRow(srv, order.id);
    assertRejected(await srv.postWebhook(event, { secret: 'whsec_wrong_secret' }));
    assert.deepEqual(orderRow(srv, order.id), before);
  });

  test('rejects a request without a stripe-signature header', async () => {
    const before = orderRow(srv, order.id);
    assertRejected(await srv.postWebhook(event, { header: null }));
    assert.deepEqual(orderRow(srv, order.id), before);
  });

  test('rejects a timestamp older than the 300-second tolerance', async () => {
    const before = orderRow(srv, order.id);
    const timestamp = Math.floor(Date.now() / 1000) - 400;
    assertRejected(await srv.postWebhook(event, { timestamp }));
    assert.deepEqual(orderRow(srv, order.id), before);
  });

  test('accepts the same event once it is validly signed', async () => {
    assertApplied(await srv.postWebhook(event));
    assert.equal((await getOrder(srv, order.id)).status, 'paid');
  });
});

describe('no webhook secret configured', () => {
  let srv;
  before(async () => {
    srv = await startTestServer({ webhookSecret: null });
  });
  after(async () => {
    await srv.close();
  });

  test('returns 503 and writes nothing', async () => {
    const order = await createEmbeddedOrder(srv);
    const res = await srv.postWebhook(
      paymentIntentSucceeded({ orderId: order.id, paymentIntentId: order.stripePaymentIntentId }),
    );
    assert.equal(res.status, 503);
    assert.equal((await getOrder(srv, order.id)).status, 'pending');
    assert.equal(count(srv, 'webhook_events'), 0);
    assert.equal(count(srv, 'processed_events'), 0);
  });
});

describe('R4.2 transitions', () => {
  let srv;
  beforeEach(async () => {
    srv = await startTestServer();
  });
  afterEach(async () => {
    await srv.close();
  });

  test('checkout.session.completed (paid) → paid, and backfills the PaymentIntent', async () => {
    const order = await createCheckoutOrder(srv);
    assert.equal(order.stripePaymentIntentId, null);
    const event = checkoutSessionCompleted({ orderId: order.id, sessionId: order.stripeCheckoutSessionId });
    assertApplied(await srv.postWebhook(event));

    const after = await getOrder(srv, order.id);
    assert.equal(after.status, 'paid');
    assert.equal(after.stripePaymentIntentId, event.data.object.payment_intent);
    const [row] = logRows(srv, event.id);
    assert.equal(row.order_id, order.id);
    assert.equal(row.outcome, 'applied');
    assert.equal(row.detail, 'pending → paid');
  });

  test('payment_intent.succeeded → paid', async () => {
    const order = await createEmbeddedOrder(srv);
    assertApplied(
      await srv.postWebhook(paymentIntentSucceeded({ orderId: order.id, paymentIntentId: order.stripePaymentIntentId })),
    );
    assert.equal((await getOrder(srv, order.id)).status, 'paid');
  });

  test('payment_intent.payment_failed → failed', async () => {
    const order = await createEmbeddedOrder(srv);
    assertApplied(
      await srv.postWebhook(paymentIntentFailed({ orderId: order.id, paymentIntentId: order.stripePaymentIntentId })),
    );
    assert.equal((await getOrder(srv, order.id)).status, 'failed');
  });

  test('checkout.session.expired → canceled', async () => {
    const order = await createCheckoutOrder(srv);
    assertApplied(
      await srv.postWebhook(checkoutSessionExpired({ orderId: order.id, sessionId: order.stripeCheckoutSessionId })),
    );
    assert.equal((await getOrder(srv, order.id)).status, 'canceled');
  });

  test('charge.refunded without metadata resolves through charge.payment_intent → refunded', async () => {
    const order = await createEmbeddedOrder(srv);
    const pi = order.stripePaymentIntentId;
    assertApplied(await srv.postWebhook(paymentIntentSucceeded({ orderId: order.id, paymentIntentId: pi })));

    const refund = chargeRefunded({ paymentIntentId: pi });
    assert.deepEqual(refund.data.object.metadata, {});
    assertApplied(await srv.postWebhook(refund));

    assert.equal((await getOrder(srv, order.id)).status, 'refunded');
    const [row] = logRows(srv, refund.id);
    assert.equal(row.order_id, order.id);
    assert.equal(row.detail, 'paid → refunded');
  });

  test('failed → paid when a retry succeeds', async () => {
    const order = await createEmbeddedOrder(srv);
    const pi = order.stripePaymentIntentId;
    assertApplied(await srv.postWebhook(paymentIntentFailed({ orderId: order.id, paymentIntentId: pi })));
    assert.equal((await getOrder(srv, order.id)).status, 'failed');

    const retry = paymentIntentSucceeded({ orderId: order.id, paymentIntentId: pi });
    assertApplied(await srv.postWebhook(retry));
    assert.equal((await getOrder(srv, order.id)).status, 'paid');
    assert.equal(logRows(srv, retry.id)[0].detail, 'failed → paid');
  });
});

describe('Checkout sends two events per payment', () => {
  let srv;
  beforeEach(async () => {
    srv = await startTestServer();
  });
  afterEach(async () => {
    await srv.close();
  });

  async function deliver(order, first) {
    const pi = 'pi_test_checkout_pair';
    const completed = checkoutSessionCompleted({
      orderId: order.id,
      sessionId: order.stripeCheckoutSessionId,
      paymentIntentId: pi,
    });
    // Checkout copies payment_intent_data.metadata onto the PaymentIntent, so it carries order_id too.
    const succeeded = paymentIntentSucceeded({ orderId: order.id, paymentIntentId: pi });
    const events = first === 'session' ? [completed, succeeded] : [succeeded, completed];
    const outcomes = [];
    for (const event of events) {
      const res = await srv.postWebhook(event);
      assert.equal(res.status, 200);
      outcomes.push(res.body.outcome);
    }
    return { outcomes, events };
  }

  for (const first of ['session', 'payment_intent']) {
    test(`exactly one is applied when the ${first} event arrives first`, async () => {
      const order = await createCheckoutOrder(srv);
      const { outcomes, events } = await deliver(order, first);

      assert.deepEqual(outcomes, ['applied', 'ignored_transition']);
      assert.equal(logRows(srv, events[1].id)[0].detail, 'already paid');
      const after = await getOrder(srv, order.id);
      assert.equal(after.status, 'paid');
      assert.equal(after.stripePaymentIntentId, 'pi_test_checkout_pair');
      assert.equal(
        srv.db.prepare(`SELECT COUNT(*) AS n FROM webhook_events WHERE order_id = ? AND outcome = 'applied'`).get(order.id).n,
        1,
      );
    });
  }
});

describe('idempotency and ordering', () => {
  let srv;
  beforeEach(async () => {
    srv = await startTestServer();
  });
  afterEach(async () => {
    await srv.close();
  });

  test('a duplicate delivery is ignored and leaves the DB otherwise unchanged', async () => {
    const order = await createEmbeddedOrder(srv);
    const event = paymentIntentSucceeded({ orderId: order.id, paymentIntentId: order.stripePaymentIntentId });
    assertApplied(await srv.postWebhook(event));
    const orderAfterFirst = orderRow(srv, order.id);
    const processedAfterFirst = count(srv, 'processed_events');

    const dup = await srv.postWebhook(event);
    assert.equal(dup.status, 200);
    assert.deepEqual(dup.body, { received: true, outcome: 'ignored_duplicate' });

    assert.deepEqual(orderRow(srv, order.id), orderAfterFirst);
    assert.equal(count(srv, 'processed_events'), processedAfterFirst);
    const rows = logRows(srv, event.id);
    assert.deepEqual(rows.map((r) => r.outcome), ['applied', 'ignored_duplicate']);
    assert.ok(rows.every((r) => r.order_id === order.id));
  });

  test('payment_failed arriving after paid is ignored and the order stays paid', async () => {
    const order = await createEmbeddedOrder(srv);
    const pi = order.stripePaymentIntentId;
    const failed = paymentIntentFailed({ orderId: order.id, paymentIntentId: pi, created: Math.floor(Date.now() / 1000) - 60 });
    assertApplied(await srv.postWebhook(paymentIntentSucceeded({ orderId: order.id, paymentIntentId: pi })));

    const res = await srv.postWebhook(failed);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'ignored_transition');
    assert.equal((await getOrder(srv, order.id)).status, 'paid');
    const [row] = logRows(srv, failed.id);
    assert.equal(row.detail, 'paid → failed not allowed');
    assert.ok(isProcessed(srv, failed.id));
  });
});

describe('events that change nothing', () => {
  let srv;
  before(async () => {
    srv = await startTestServer();
  });
  after(async () => {
    await srv.close();
  });

  test('an event for an unknown order is acknowledged and logged without an order', async () => {
    const order = await createEmbeddedOrder(srv);
    const event = paymentIntentSucceeded({ orderId: 'no_such_order', paymentIntentId: 'pi_test_unknown' });
    const res = await srv.postWebhook(event);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { received: true, outcome: 'ignored_unknown_order' });

    const rows = logRows(srv, event.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].order_id, null);
    assert.equal(rows[0].type, 'payment_intent.succeeded');
    assert.ok(isProcessed(srv, event.id));
    assert.equal((await getOrder(srv, order.id)).status, 'pending');
  });

  test('an unhandled event type is acknowledged and logged without an order', async () => {
    const event = unhandled('customer.created');
    const res = await srv.postWebhook(event);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { received: true, outcome: 'ignored_unhandled_type' });

    const rows = logRows(srv, event.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].order_id, null);
    assert.equal(rows[0].type, 'customer.created');
    assert.ok(isProcessed(srv, event.id));
  });

  test('the events API lists every logged outcome', async () => {
    const events = await (await fetch(`${srv.url}/api/events`)).json();
    assert.deepEqual(
      events.map((e) => e.outcome).sort(),
      ['ignored_unhandled_type', 'ignored_unknown_order'],
    );
  });
});

describe('processing failure', () => {
  let srv;
  before(async () => {
    srv = await startTestServer();
  });
  after(async () => {
    await srv.close();
  });

  test('returns 500, rolls back, and a resend is then applied', async () => {
    const order = await createEmbeddedOrder(srv);
    const before = orderRow(srv, order.id);
    const event = paymentIntentSucceeded({ orderId: order.id, paymentIntentId: order.stripePaymentIntentId });

    // The log insert is the processor's last write, so failing it proves the earlier status update was rolled back.
    srv.db.exec(`CREATE TEMP TRIGGER fail_log BEFORE INSERT ON webhook_events BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    const failed = await srv.postWebhook(event);
    assert.equal(failed.status, 500);
    assert.equal(isProcessed(srv, event.id), false);
    assert.deepEqual(orderRow(srv, order.id), before);
    assert.equal(count(srv, 'webhook_events'), 0);

    srv.db.exec('DROP TRIGGER fail_log');
    assertApplied(await srv.postWebhook(event));
    assert.equal((await getOrder(srv, order.id)).status, 'paid');
    assert.ok(isProcessed(srv, event.id));
    assert.deepEqual(logRows(srv, event.id).map((r) => r.outcome), ['applied']);
  });
});
