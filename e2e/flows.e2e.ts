import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startE2E } from './harness.ts';
import type { E2E } from './harness.ts';
import type { EventLogRow, Order, OrderStatus } from '../src/types.ts';

interface OrderDetail {
  order: Order;
  events: EventLogRow[];
}

const TIMEOUT = 60_000;

describe('end-to-end against Stripe test mode', { concurrency: false }, () => {
  let e2e: E2E;
  let paidOrderId: string | undefined;

  before(async () => {
    e2e = await startE2E();
  });

  after(async () => {
    await e2e?.stop();
  });

  const getOrder = async (orderId: string) => (await e2e.api('GET', `/api/orders/${orderId}`)).body as OrderDetail;

  const waitForStatus = (orderId: string, status: OrderStatus) =>
    e2e.waitFor(
      async () => {
        const detail = await getOrder(orderId);
        return detail.order.status === status && detail;
      },
      { what: `order ${orderId} to become ${status}` },
    );

  async function createEmbeddedOrder(body: Record<string, string> = { productId: 'duck' }) {
    const res = await e2e.api('POST', '/api/payment-intents', body);
    assert.equal(res.status, 201);
    const { orderId } = res.body as { orderId: string };
    const paymentIntentId = (await getOrder(orderId)).order.stripePaymentIntentId;
    assert.ok(paymentIntentId, 'embedded order has no PaymentIntent id');
    return { orderId, paymentIntentId };
  }

  const confirm = (paymentIntentId: string, paymentMethod: string) =>
    e2e.stripe.paymentIntents.confirm(paymentIntentId, {
      payment_method: paymentMethod,
      return_url: `${e2e.url}/success.html`,
    });

  const applied = (detail: OrderDetail, type: string) => detail.events.filter((ev) => ev.type === type && ev.outcome === 'applied');

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

    await assert.rejects(confirm(paymentIntentId, 'pm_card_chargeDeclinedInsufficientFunds'), (err: unknown) => {
      assert.ok(err instanceof Error && 'code' in err && 'decline_code' in err, `unexpected error: ${err}`);
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

  test('a custom-amount donation is paid for exactly the chosen amount', { timeout: TIMEOUT }, async () => {
    const { orderId, paymentIntentId } = await createEmbeddedOrder({ productId: 'donation', amount: '12.34' });

    const intent = await e2e.stripe.paymentIntents.retrieve(paymentIntentId);
    assert.equal(intent.amount, 1234);
    assert.equal(intent.metadata.order_id, orderId);

    await confirm(paymentIntentId, 'pm_card_visa');
    const detail = await waitForStatus(orderId, 'paid');
    assert.equal(detail.order.productId, 'donation');
    assert.equal(detail.order.amountCents, 1234);
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
    assert.match(res.headers.get('location') ?? '', /^https:\/\/checkout\.stripe\.com\//);

    const orders = (await e2e.api('GET', '/api/orders')).body as Order[];
    const order = orders.find((o) => o.method === 'checkout' && o.status === 'pending');
    assert.ok(order, 'checkout order not found');

    const page = await e2e.api('GET', `/cancel?order_id=${order.id}`);
    assert.equal(page.status, 200);
    // What the cancel page's script does in the browser: loading the page alone changes nothing.
    const cancel = await e2e.api('POST', `/api/orders/${order.id}/cancel`);
    assert.equal(cancel.status, 202);

    const detail = await waitForStatus(order.id, 'canceled');
    assert.equal(applied(detail, 'checkout.session.expired').length, 1);
  });

  test('a real resend of a processed event is ignored as a duplicate', { timeout: TIMEOUT }, async () => {
    // A const keeps the narrowing inside the waitFor closure below.
    const orderId = paidOrderId;
    assert.ok(orderId, 'depends on the embedded payment test');
    const [original] = applied(await getOrder(orderId), 'payment_intent.succeeded');

    e2e.stripeCli('events', 'resend', original.stripeEventId, '--confirm');

    const detail = await e2e.waitFor(
      async () => {
        const d = await getOrder(orderId);
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
        const events = (await e2e.api('GET', '/api/events')).body as EventLogRow[];
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
