import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { createOrdersRepo } from '../src/orders.ts';

function setup(start = '2026-01-01T00:00:00.000Z') {
  const clock = { ms: Date.parse(start) };
  const db = openDb(':memory:');
  const orders = createOrdersRepo(db, { now: () => new Date(clock.ms) });
  const tick = (ms = 1000) => {
    clock.ms += ms;
    return new Date(clock.ms).toISOString();
  };
  return { db, orders, tick };
}

test('create returns a pending camelCase order with timestamps from now', () => {
  const { db, orders } = setup();
  const order = orders.create({ productId: 'duck', amountCents: 500, method: 'checkout' });

  assert.match(order.id, /^ord_[0-9a-f]{16}$/);
  assert.equal(Object.getPrototypeOf(order), Object.prototype);
  assert.deepEqual(order, {
    id: order.id,
    productId: 'duck',
    amountCents: 500,
    currency: 'usd',
    method: 'checkout',
    status: 'pending',
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(orders.get(order.id), order);
  db.close();
});

test('create generates distinct ids', () => {
  const { db, orders } = setup();
  const a = orders.create({ productId: 'duck', amountCents: 500, method: 'checkout' });
  const b = orders.create({ productId: 'duck', amountCents: 500, method: 'embedded' });
  assert.notEqual(a.id, b.id);
  db.close();
});

test('attachCheckoutSession then findByCheckoutSession', () => {
  const { db, orders, tick } = setup();
  const order = orders.create({ productId: 'duck', amountCents: 500, method: 'checkout' });
  const later = tick();
  orders.attachCheckoutSession(order.id, 'cs_test_1');

  const found = orders.findByCheckoutSession('cs_test_1');
  assert.equal(found.id, order.id);
  assert.equal(found.stripeCheckoutSessionId, 'cs_test_1');
  assert.equal(found.updatedAt, later);
  assert.equal(Object.getPrototypeOf(found), Object.prototype);
  db.close();
});

test('attachPaymentIntent then findByPaymentIntent', () => {
  const { db, orders } = setup();
  const order = orders.create({ productId: 'duck', amountCents: 500, method: 'embedded' });
  orders.attachPaymentIntent(order.id, 'pi_test_1');

  const found = orders.findByPaymentIntent('pi_test_1');
  assert.equal(found.id, order.id);
  assert.equal(found.stripePaymentIntentId, 'pi_test_1');
  db.close();
});

test('attachPaymentIntent with the same id again is a no-op', () => {
  const { db, orders, tick } = setup();
  const order = orders.create({ productId: 'duck', amountCents: 500, method: 'embedded' });
  tick();
  orders.attachPaymentIntent(order.id, 'pi_test_1');
  const first = orders.get(order.id);

  tick();
  assert.doesNotThrow(() => orders.attachPaymentIntent(order.id, 'pi_test_1'));
  assert.deepEqual(orders.get(order.id), first);
  db.close();
});

test('get and find methods return undefined for unknown ids', () => {
  const { db, orders } = setup();
  orders.create({ productId: 'duck', amountCents: 500, method: 'checkout' });
  assert.equal(orders.get('ord_0000000000000000'), undefined);
  assert.equal(orders.findByCheckoutSession('cs_missing'), undefined);
  assert.equal(orders.findByPaymentIntent('pi_missing'), undefined);
  db.close();
});

test('list returns orders newest first', () => {
  const { db, orders, tick } = setup();
  assert.deepEqual(orders.list(), []);

  const first = orders.create({ productId: 'duck', amountCents: 500, method: 'checkout' });
  tick();
  const second = orders.create({ productId: 'mug', amountCents: 1200, method: 'embedded' });
  tick();
  const third = orders.create({ productId: 'duck', amountCents: 500, method: 'embedded' });

  const listed = orders.list();
  assert.deepEqual(
    listed.map((o) => o.id),
    [third.id, second.id, first.id],
  );
  assert.ok(listed.every((o) => Object.getPrototypeOf(o) === Object.prototype));
  db.close();
});

test('list breaks same-timestamp ties by insertion order, newest first', () => {
  const { db, orders } = setup();
  const first = orders.create({ productId: 'duck', amountCents: 500, method: 'checkout' });
  const second = orders.create({ productId: 'duck', amountCents: 500, method: 'checkout' });
  assert.deepEqual(
    orders.list().map((o) => o.id),
    [second.id, first.id],
  );
  db.close();
});

test('setStatus updates status and updatedAt only', () => {
  const { db, orders, tick } = setup();
  const order = orders.create({ productId: 'duck', amountCents: 500, method: 'checkout' });
  const later = tick(5000);
  orders.setStatus(order.id, 'paid');

  assert.deepEqual(orders.get(order.id), { ...order, status: 'paid', updatedAt: later });
  db.close();
});
