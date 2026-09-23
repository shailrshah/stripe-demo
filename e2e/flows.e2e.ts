import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startE2E } from './harness.ts';

const TIMEOUT = 60_000;

describe('end-to-end against Stripe test mode', { concurrency: false }, () => {
  let e2e;
  let paidOrderId;

  before(async () => {
    e2e = await startE2E();
  });

  after(async () => {
    await e2e?.stop();
  });

  const getOrder = async (orderId) => (await e2e.api('GET', `/api/orders/${orderId}`)).body;

  const waitForStatus = (orderId, status) =>
    e2e.waitFor(
      async () => {
        const detail = await getOrder(orderId);
        return detail.order.status === status && detail;
      },
      { what: `order ${orderId} to become ${status}` },
    );

  async function createEmbeddedOrder() {
    const res = await e2e.api('POST', '/api/payment-intents', { productId: 'duck' });
    assert.equal(res.status, 201);
    const detail = await getOrder(res.body.orderId);
    return { orderId: res.body.orderId, paymentIntentId: detail.order.stripePaymentIntentId };
  }

  const confirm = (paymentIntentId, paymentMethod) =>
    e2e.stripe.paymentIntents.confirm(paymentIntentId, {
      payment_method: paymentMethod,
      return_url: `${e2e.url}/success.html`,
    });

  const applied = (detail, type) => detail.events.filter((ev) => ev.type === type && ev.outcome === 'applied');

  test('embedded payment succeeds and is marked paid by webhook', { timeout: TIMEOUT }, async () => {
    const { orderId, paymentIntentId } = await createEmbeddedOrder();
    assert.equal((await getOrder(orderId)).order.status, 'pending');

    await confirm(paymentIntentId, 'pm_card_visa');
    const detail = await waitForStatus(orderId, 'paid');

    assert.equal(applied(detail, 'payment_intent.succeeded').length, 1);
    paidOrderId = orderId;
  });

  test('a declined card fails the order and a retry pays it', { timeout: TIMEOUT }, async () => {
    const { orderId, paymentIntentId } = await createEmbeddedOrder();

    await assert.rejects(confirm(paymentIntentId, 'pm_card_chargeDeclinedInsufficientFunds'), (err) => {
      assert.equal(err.code, 'card_declined');
      assert.equal(err.decline_code, 'insufficient_funds');
      return true;
    });
    await waitForStatus(orderId, 'failed');

    await confirm(paymentIntentId, 'pm_card_visa');
    const detail = await waitForStatus(orderId, 'paid');

    const details = detail.events.filter((ev) => ev.outcome === 'applied').map((ev) => ev.detail);
    assert.ok(details.includes('pending → failed'), details.join(', '));
    assert.ok(details.includes('failed → paid'), details.join(', '));
  });

  test('refunding a paid order is confirmed by charge.refunded', { timeout: TIMEOUT }, async () => {
    assert.ok(paidOrderId, 'depends on the embedded payment test');
    const res = await e2e.api('POST', `/api/orders/${paidOrderId}/refund`);
    assert.equal(res.status, 202);

    const detail = await waitForStatus(paidOrderId, 'refunded');
    assert.equal(applied(detail, 'charge.refunded').length, 1);
  });

  test('cancelling Checkout expires the session and cancels the order', { timeout: TIMEOUT }, async () => {
    const res = await e2e.api('POST', '/checkout', { productId: 'beans' }, { form: true });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /^https:\/\/checkout\.stripe\.com\//);

    const orders = (await e2e.api('GET', '/api/orders')).body;
    const order = orders.find((o) => o.method === 'checkout' && o.status === 'pending');
    assert.ok(order, 'checkout order not found');

    const cancel = await e2e.api('GET', `/cancel?order_id=${order.id}`);
    assert.equal(cancel.status, 200);

    const detail = await waitForStatus(order.id, 'canceled');
    assert.equal(applied(detail, 'checkout.session.expired').length, 1);
  });

  test('a real resend of a processed event is ignored as a duplicate', { timeout: TIMEOUT }, async () => {
    assert.ok(paidOrderId, 'depends on the embedded payment test');
    const [original] = applied(await getOrder(paidOrderId), 'payment_intent.succeeded');

    e2e.stripeCli('events', 'resend', original.stripeEventId, '--confirm');

    const detail = await e2e.waitFor(
      async () => {
        const d = await getOrder(paidOrderId);
        return d.events.some((ev) => ev.stripeEventId === original.stripeEventId && ev.outcome === 'ignored_duplicate') && d;
      },
      { what: `resent ${original.stripeEventId} to be logged as a duplicate` },
    );
    assert.equal(detail.order.status, 'refunded');
  });

  test('stripe trigger events are logged against no order', { timeout: TIMEOUT }, async () => {
    const since = new Date().toISOString();
    e2e.stripeCli('trigger', 'payment_intent.succeeded');

    await e2e.waitFor(
      async () => {
        const events = (await e2e.api('GET', '/api/events')).body;
        return events.some(
          (ev) =>
            ev.type === 'payment_intent.succeeded' &&
            ev.receivedAt >= since &&
            ev.orderId === null &&
            ev.outcome === 'ignored_unknown_order',
        );
      },
      { what: 'the triggered payment_intent.succeeded to be logged as ignored_unknown_order' },
    );
  });
});
