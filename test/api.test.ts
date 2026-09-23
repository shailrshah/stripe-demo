import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../src/db.ts';
import { createOrdersRepo } from '../src/orders.ts';
import { createEventLog } from '../src/event-log.ts';
import { PRODUCTS } from '../src/catalog.ts';
import { createApiRouter } from '../src/routes/api.ts';
import { createFakeGateway } from './helpers/fake-gateway.ts';
import { paymentIntentSucceeded, checkoutSessionCompleted } from './helpers/stripe-events.ts';

const DASHBOARD = 'https://dashboard.stripe.com/test';

let server, baseUrl, db, orders, eventLog, gateway;
const logged = [];

before(async () => {
  db = openDb(':memory:');
  orders = createOrdersRepo(db);
  eventLog = createEventLog(db);
  gateway = createFakeGateway();
  const record = (...args) => logged.push(args.join(' '));
  const logger = { info: record, warn: record, error: record };

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    config: { stripePublishableKey: 'pk_test_fake_key', stripeSecretKey: 'sk_test_fake_key' },
    orders,
    eventLog,
    gateway,
    logger,
  }));
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: { message: err.message } });
  });

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
});

async function request(method, path, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, init);
  return { status: res.status, body: await res.json() };
}

const orderCount = () => db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;

function paidEmbeddedOrder() {
  const order = orders.create({ productId: 'beans', amountCents: 1250, method: 'embedded' });
  const pi = `pi_test_seed_${order.id}`;
  orders.attachPaymentIntent(order.id, pi);
  orders.setStatus(order.id, 'paid');
  return { ...order, stripePaymentIntentId: pi };
}

function sessionOnlyOrder(status = 'pending') {
  const order = orders.create({ productId: 'duck', amountCents: 500, method: 'checkout' });
  const cs = `cs_test_seed_${order.id}`;
  orders.attachCheckoutSession(order.id, cs);
  if (status !== 'pending') orders.setStatus(order.id, status);
  return { ...order, stripeCheckoutSessionId: cs };
}

test('GET /api/products lists every catalog product with a formatted price', async () => {
  const { status, body } = await request('GET', '/api/products');
  assert.equal(status, 200);
  assert.deepEqual(body, [
    { id: 'duck', name: 'Rubber Duck', description: 'For debugging conversations.', amountCents: 500, price: '$5.00' },
    { id: 'beans', name: 'Coffee Beans (1 lb)', description: 'Fuel for late-night deploys.', amountCents: 1250, price: '$12.50' },
    { id: 'keyboard', name: 'Mechanical Keyboard', description: 'Clicky. Very clicky.', amountCents: 8900, price: '$89.00' },
  ]);
  assert.equal(body.length, PRODUCTS.length);
});

test('GET /api/config returns only the publishable key', async () => {
  const { status, body } = await request('GET', '/api/config');
  assert.equal(status, 200);
  assert.deepEqual(body, { publishableKey: 'pk_test_fake_key' });
});

test('POST /api/payment-intents uses the catalog amount and returns only orderId and clientSecret', async () => {
  const callsBefore = gateway.calls.length;
  const { status, body } = await request('POST', '/api/payment-intents', { productId: 'keyboard', amountCents: 1 });

  assert.equal(status, 201);
  assert.deepEqual(Object.keys(body).sort(), ['clientSecret', 'orderId']);
  assert.match(body.clientSecret, /^pi_test_fake_\d+_secret_/);

  const newCalls = gateway.calls.slice(callsBefore);
  assert.equal(newCalls.length, 1);
  assert.equal(newCalls[0].method, 'createPaymentIntent');
  assert.equal(newCalls[0].args.orderId, body.orderId);
  assert.equal(newCalls[0].args.product.id, 'keyboard');
  assert.equal(newCalls[0].args.product.amountCents, 8900);

  const order = orders.get(body.orderId);
  assert.equal(order.method, 'embedded');
  assert.equal(order.status, 'pending');
  assert.equal(order.amountCents, 8900);
  assert.equal(order.productId, 'keyboard');
  assert.equal(order.stripePaymentIntentId, body.clientSecret.split('_secret_')[0]);

  assert.ok(logged.every((line) => !line.includes(body.clientSecret)), 'client secret must never be logged');
});

test('POST /api/payment-intents rejects an unknown or missing product without writing or calling Stripe', async () => {
  const ordersBefore = orderCount();
  const callsBefore = gateway.calls.length;

  for (const payload of [{ productId: 'nope' }, {}]) {
    const { status, body } = await request('POST', '/api/payment-intents', payload);
    assert.equal(status, 400);
    assert.equal(typeof body.error.message, 'string');
  }
  const res = await fetch(`${baseUrl}/api/payment-intents`, { method: 'POST' });
  assert.equal(res.status, 400);

  assert.equal(orderCount(), ordersBefore);
  assert.equal(gateway.calls.length, callsBefore);
});

test('POST /api/payment-intents returns 502 when the gateway fails', async () => {
  gateway.failNext('createPaymentIntent');
  const { status, body } = await request('POST', '/api/payment-intents', { productId: 'duck' });
  assert.equal(status, 502);
  assert.equal(typeof body.error.message, 'string');
});

test('GET /api/orders enriches every order with productName, price and dashboardUrl', async () => {
  const paid = paidEmbeddedOrder();
  const session = sessionOnlyOrder();

  const { status, body } = await request('GET', '/api/orders');
  assert.equal(status, 200);
  for (const order of body) {
    assert.ok('productName' in order && 'price' in order && 'dashboardUrl' in order);
  }

  const byId = Object.fromEntries(body.map((o) => [o.id, o]));
  assert.equal(byId[paid.id].productName, 'Coffee Beans (1 lb)');
  assert.equal(byId[paid.id].price, '$12.50');
  assert.equal(byId[paid.id].dashboardUrl, `${DASHBOARD}/payments/${paid.stripePaymentIntentId}`);
  assert.equal(byId[session.id].productName, 'Rubber Duck');
  assert.equal(byId[session.id].price, '$5.00');
  assert.equal(byId[session.id].dashboardUrl, `${DASHBOARD}/checkout/sessions/${session.stripeCheckoutSessionId}`);
  assert.equal(byId[session.id].method, 'checkout');
  assert.equal(byId[session.id].status, 'pending');

  const createdAt = body.map((o) => o.createdAt);
  assert.deepEqual(createdAt, [...createdAt].sort().reverse());
});

test('GET /api/orders/:id returns the enriched order and its events with Dashboard links', async () => {
  const paid = paidEmbeddedOrder();
  const first = paymentIntentSucceeded({ orderId: paid.id, paymentIntentId: paid.stripePaymentIntentId });
  const second = paymentIntentSucceeded({ orderId: paid.id, paymentIntentId: paid.stripePaymentIntentId });
  eventLog.append({ event: first, orderId: paid.id, outcome: 'applied' });
  eventLog.append({ event: second, orderId: paid.id, outcome: 'ignored_transition', detail: 'paid -> paid' });

  const { status, body } = await request('GET', `/api/orders/${paid.id}`);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['events', 'order']);
  assert.equal(body.order.id, paid.id);
  assert.equal(body.order.status, 'paid');
  assert.equal(body.order.productName, 'Coffee Beans (1 lb)');
  assert.equal(body.order.price, '$12.50');
  assert.equal(body.order.dashboardUrl, `${DASHBOARD}/payments/${paid.stripePaymentIntentId}`);

  assert.deepEqual(body.events.map((e) => e.stripeEventId), [first.id, second.id]);
  for (const e of body.events) {
    assert.equal(e.dashboardUrl, `${DASHBOARD}/events/${e.stripeEventId}`);
    assert.equal(e.orderId, paid.id);
  }
  assert.equal(body.events[1].outcome, 'ignored_transition');
});

test('GET /api/orders/:id links a session-only order to its Checkout Session', async () => {
  const session = sessionOnlyOrder();
  const { status, body } = await request('GET', `/api/orders/${session.id}`);
  assert.equal(status, 200);
  assert.equal(body.order.productName, 'Rubber Duck');
  assert.equal(body.order.price, '$5.00');
  assert.equal(body.order.dashboardUrl, `${DASHBOARD}/checkout/sessions/${session.stripeCheckoutSessionId}`);
  assert.deepEqual(body.events, []);
});

test('GET /api/orders/:id returns 404 for an unknown order', async () => {
  const { status, body } = await request('GET', '/api/orders/ord_missing');
  assert.equal(status, 404);
  assert.equal(typeof body.error.message, 'string');
});

test('POST /api/orders/:id/refund requests a refund for a paid order and leaves its status alone', async () => {
  const paid = paidEmbeddedOrder();
  const callsBefore = gateway.calls.length;

  const { status, body } = await request('POST', `/api/orders/${paid.id}/refund`);
  assert.equal(status, 202);
  assert.deepEqual(Object.keys(body), ['refundId']);
  assert.match(body.refundId, /^re_test_fake_\d+$/);

  const newCalls = gateway.calls.slice(callsBefore);
  assert.deepEqual(newCalls, [
    { method: 'createRefund', args: { paymentIntentId: paid.stripePaymentIntentId, orderId: paid.id } },
  ]);
  assert.equal(orders.get(paid.id).status, 'paid');
});

test('POST /api/orders/:id/refund returns 409 unless the order is paid with a PaymentIntent', async () => {
  const pending = orders.create({ productId: 'duck', amountCents: 500, method: 'embedded' });
  orders.attachPaymentIntent(pending.id, `pi_test_seed_${pending.id}`);
  const paidSessionOnly = sessionOnlyOrder('paid');
  const callsBefore = gateway.calls.length;

  for (const [order, expectedStatus] of [[pending, 'pending'], [paidSessionOnly, 'paid']]) {
    const { status, body } = await request('POST', `/api/orders/${order.id}/refund`);
    assert.equal(status, 409);
    assert.equal(typeof body.error.message, 'string');
    assert.equal(orders.get(order.id).status, expectedStatus);
  }
  assert.equal(gateway.calls.length, callsBefore);
});

test('POST /api/orders/:id/refund returns 404 for an unknown order', async () => {
  const { status, body } = await request('POST', '/api/orders/ord_missing/refund');
  assert.equal(status, 404);
  assert.equal(typeof body.error.message, 'string');
});

test('POST /api/orders/:id/refund returns 502 when the gateway fails', async () => {
  const paid = paidEmbeddedOrder();
  gateway.failNext('createRefund');
  const { status, body } = await request('POST', `/api/orders/${paid.id}/refund`);
  assert.equal(status, 502);
  assert.equal(typeof body.error.message, 'string');
  assert.equal(orders.get(paid.id).status, 'paid');
});

test('GET /api/events lists the event log newest first with Dashboard links', async () => {
  const order = sessionOnlyOrder();
  const older = checkoutSessionCompleted({ orderId: order.id, sessionId: order.stripeCheckoutSessionId });
  const newer = paymentIntentSucceeded();
  eventLog.append({ event: older, orderId: order.id, outcome: 'applied' });
  eventLog.append({ event: newer, outcome: 'ignored_unknown_order' });

  const { status, body } = await request('GET', '/api/events');
  assert.equal(status, 200);
  assert.deepEqual(body.slice(0, 2).map((e) => e.stripeEventId), [newer.id, older.id]);
  for (const e of body) {
    assert.equal(e.dashboardUrl, `${DASHBOARD}/events/${e.stripeEventId}`);
  }
  assert.equal(body[0].orderId, null);
  assert.equal(body[0].type, 'payment_intent.succeeded');
  assert.equal(body[1].orderId, order.id);
});
