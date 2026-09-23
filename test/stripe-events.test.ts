import { test } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import {
  checkoutSessionCompleted,
  checkoutSessionExpired,
  paymentIntentSucceeded,
  paymentIntentFailed,
  chargeRefunded,
  unhandled,
  sign,
} from './helpers/stripe-events.ts';
import { createFakeGateway } from './helpers/fake-gateway.ts';
import type { Product } from '../src/types.ts';

const SECRET = 'whsec_test_secret';

function sessionOf(event: Stripe.Event): Stripe.Checkout.Session {
  assert.ok(event.type === 'checkout.session.completed' || event.type === 'checkout.session.expired');
  return event.data.object;
}

function paymentIntentOf(event: Stripe.Event): Stripe.PaymentIntent {
  assert.ok(event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.payment_failed');
  return event.data.object;
}

function chargeOf(event: Stripe.Event): Stripe.Charge {
  assert.ok(event.type === 'charge.refunded');
  return event.data.object;
}

const builders = {
  'checkout.session.completed': () => checkoutSessionCompleted({ orderId: 'ord_1' }),
  'checkout.session.expired': () => checkoutSessionExpired({ orderId: 'ord_1' }),
  'payment_intent.succeeded': () => paymentIntentSucceeded({ orderId: 'ord_1' }),
  'payment_intent.payment_failed': () => paymentIntentFailed({ orderId: 'ord_1' }),
  'charge.refunded': () => chargeRefunded({ orderId: 'ord_1' }),
  'customer.created': () => unhandled('customer.created'),
};

for (const [type, build] of Object.entries(builders)) {
  test(`${type} round-trips through constructEvent`, () => {
    const event = build();
    assert.equal(event.type, type);
    assert.equal(event.object, 'event');
    assert.match(event.id, /^evt_test_\d+$/);
    const { body, header } = sign(event, SECRET);
    assert.equal(body, JSON.stringify(event));
    assert.deepEqual(Stripe.webhooks.constructEvent(body, header, SECRET), event);
    assert.deepEqual(Stripe.webhooks.constructEvent(Buffer.from(body), header, SECRET), event);
  });
}

test('sign with a different secret fails verification', () => {
  const { body, header } = sign(paymentIntentSucceeded(), SECRET);
  assert.throws(() => Stripe.webhooks.constructEvent(body, header, 'whsec_other'));
});

test('sign honours an old timestamp, which fails the default tolerance', () => {
  const timestamp = Math.floor(Date.now() / 1000) - 3600;
  const { body, header } = sign(paymentIntentSucceeded(), SECRET, { timestamp });
  assert.match(header, new RegExp(`^t=${timestamp},`));
  assert.throws(() => Stripe.webhooks.constructEvent(body, header, SECRET), /timestamp/i);
});

test('checkout session objects carry realistic fields', () => {
  const e = checkoutSessionCompleted({ orderId: 'ord_1', sessionId: 'cs_x', paymentIntentId: 'pi_x' });
  const o = sessionOf(e);
  assert.equal(o.object, 'checkout.session');
  assert.equal(o.id, 'cs_x');
  assert.equal(o.payment_status, 'paid');
  assert.equal(o.payment_intent, 'pi_x');
  assert.deepEqual(o.metadata, { order_id: 'ord_1' });

  const unpaid = sessionOf(checkoutSessionCompleted({ paymentStatus: 'unpaid' }));
  assert.equal(unpaid.payment_status, 'unpaid');
  assert.match(unpaid.id, /^cs_test_\d+$/);
  assert.ok(typeof unpaid.payment_intent === 'string');
  assert.match(unpaid.payment_intent, /^pi_test_\d+$/);

  const expired = sessionOf(checkoutSessionExpired({ sessionId: 'cs_y' }));
  assert.equal(expired.object, 'checkout.session');
  assert.equal(expired.id, 'cs_y');
  assert.equal(expired.status, 'expired');
});

test('payment intent and charge objects carry realistic fields', () => {
  const pi = paymentIntentOf(paymentIntentSucceeded({ paymentIntentId: 'pi_x' }));
  assert.equal(pi.object, 'payment_intent');
  assert.equal(pi.id, 'pi_x');
  assert.equal(pi.status, 'succeeded');
  assert.equal(typeof pi.amount, 'number');

  const failed = paymentIntentOf(paymentIntentFailed());
  assert.equal(failed.object, 'payment_intent');
  assert.match(failed.id, /^pi_test_\d+$/);
  assert.ok(failed.last_payment_error);

  const ch = chargeOf(chargeRefunded({ paymentIntentId: 'pi_x', chargeId: 'ch_x' }));
  assert.equal(ch.object, 'charge');
  assert.equal(ch.id, 'ch_x');
  assert.equal(ch.payment_intent, 'pi_x');
  assert.equal(ch.refunded, true);
  assert.equal(ch.amount_refunded, ch.amount);

  const partial = chargeOf(chargeRefunded({ refunded: false }));
  assert.equal(partial.refunded, false);
  assert.ok(partial.amount_refunded < partial.amount);
  assert.match(partial.id, /^ch_test_\d+$/);
});

test('an undefined orderId leaves metadata empty, like stripe trigger', () => {
  for (const build of [checkoutSessionCompleted, checkoutSessionExpired, paymentIntentSucceeded, paymentIntentFailed, chargeRefunded]) {
    const object = build().data.object;
    assert.ok('metadata' in object);
    assert.deepEqual(object.metadata, {});
  }
});

test('generated IDs are unique', () => {
  const events = [...Array(5)].flatMap(() => Object.values(builders).map((b) => b()));
  const eventIds = new Set(events.map((e) => e.id));
  const objectIds = new Set(
    events.map((e) => {
      const object = e.data.object;
      assert.ok('id' in object);
      return object.id;
    }),
  );
  assert.equal(eventIds.size, events.length);
  assert.equal(objectIds.size, events.length);
});

test('a given id and created are kept, so tests can build duplicates', () => {
  const a = paymentIntentSucceeded({ id: 'evt_dup', created: 1700000000, paymentIntentId: 'pi_1' });
  const b = paymentIntentSucceeded({ id: 'evt_dup', created: 1700000000, paymentIntentId: 'pi_1' });
  assert.equal(a.id, 'evt_dup');
  assert.equal(a.created, 1700000000);
  assert.deepEqual(a, b);
  assert.equal(unhandled('x.y', { id: 'evt_u' }).id, 'evt_u');
});

test('created defaults to the current Unix seconds', () => {
  const before = Math.floor(Date.now() / 1000);
  const e = chargeRefunded();
  assert.ok(e.created >= before && e.created <= before + 1);
});

test('unhandled accepts a custom object', () => {
  const object = { id: 'cus_1', object: 'customer' };
  assert.deepEqual(unhandled('customer.created', { object }).data.object, object);
});

test('fake gateway returns sequential IDs and records calls', async () => {
  const gw = createFakeGateway();
  const product: Product = { id: 'duck', name: 'Duck', description: 'A duck', amountCents: 500, imageUrl: 'https://images.example.test/duck.jpg' };
  const s1 = await gw.createCheckoutSession({ orderId: 'ord_1', product, successUrl: 's', cancelUrl: 'c' });
  const s2 = await gw.createCheckoutSession({ orderId: 'ord_2', product, successUrl: 's', cancelUrl: 'c' });
  assert.deepEqual(s1, { id: 'cs_test_fake_1', url: 'https://checkout.stripe.test/c/pay/cs_test_fake_1' });
  assert.equal(s2.id, 'cs_test_fake_2');

  assert.deepEqual(await gw.createPaymentIntent({ orderId: 'ord_3', product }), {
    id: 'pi_test_fake_1',
    clientSecret: 'pi_test_fake_1_secret_x',
  });
  assert.equal((await gw.createPaymentIntent({ orderId: 'ord_4', product })).id, 'pi_test_fake_2');
  assert.deepEqual(await gw.createRefund({ paymentIntentId: 'pi_test_fake_1', orderId: 'ord_3' }), { id: 're_test_fake_1' });
  assert.equal(await gw.expireCheckoutSession('cs_test_fake_1'), undefined);

  assert.deepEqual(
    gw.calls.map((c) => c.method),
    ['createCheckoutSession', 'createCheckoutSession', 'createPaymentIntent', 'createPaymentIntent', 'createRefund', 'expireCheckoutSession'],
  );
  assert.deepEqual(gw.calls[0].args, { orderId: 'ord_1', product, successUrl: 's', cancelUrl: 'c' });
  assert.equal(gw.calls[5].args, 'cs_test_fake_1');
});

test('failNext rejects exactly once, only for that method', async () => {
  const gw = createFakeGateway();
  const product: Product = { id: 'duck', name: 'Duck', description: 'A duck', amountCents: 500, imageUrl: 'https://images.example.test/duck.jpg' };
  gw.failNext('createPaymentIntent');
  assert.deepEqual(await gw.createRefund({ paymentIntentId: 'pi_1', orderId: 'ord_1' }), { id: 're_test_fake_1' });
  await assert.rejects(gw.createPaymentIntent({ orderId: 'ord_1', product }), { message: 'fake gateway failure' });
  assert.equal((await gw.createPaymentIntent({ orderId: 'ord_1', product })).id, 'pi_test_fake_1');

  gw.failNext('expireCheckoutSession');
  await assert.rejects(gw.expireCheckoutSession('cs_1'), /fake gateway failure/);
  await gw.expireCheckoutSession('cs_1');
});

test('fake gateways are independent', async () => {
  const a = createFakeGateway();
  const b = createFakeGateway();
  await a.createRefund({ paymentIntentId: 'pi_1', orderId: 'ord_1' });
  assert.equal((await b.createRefund({ paymentIntentId: 'pi_1', orderId: 'ord_1' })).id, 're_test_fake_1');
  assert.equal(b.calls.length, 1);
});
