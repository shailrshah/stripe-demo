import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type Stripe from 'stripe';
import { openDb } from '../src/db.ts';
import { createOrdersRepo } from '../src/orders.ts';
import { createEventLog } from '../src/event-log.ts';
import { createWebhookProcessor } from '../src/webhook-processor.ts';
import {
  checkoutSessionCompleted,
  checkoutSessionExpired,
  paymentIntentSucceeded,
  paymentIntentFailed,
  chargeRefunded,
  unhandled,
} from './helpers/stripe-events.ts';
import type { EventLog, Logger, OrderStatus, OrdersRepo, PaymentMethodKind } from '../src/types.ts';

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

function setup({ logger = silentLogger }: { logger?: Logger } = {}) {
  const db: DatabaseSync = openDb(':memory:');
  const orders: OrdersRepo = createOrdersRepo(db);
  const eventLog: EventLog = createEventLog(db);
  const processor = createWebhookProcessor({ db, orders, eventLog, logger });
  const newOrder = (method: PaymentMethodKind = 'checkout') =>
    orders.create({ productId: 'duck', amountCents: 500, method });
  const processedCount = () => db.prepare('SELECT COUNT(*) AS n FROM processed_events').get()?.n;
  const isMarked = (eventId: string) =>
    db.prepare('SELECT 1 FROM processed_events WHERE stripe_event_id = ?').get(eventId) !== undefined;
  return { db, orders, eventLog, processor, newOrder, processedCount, isMarked };
}

// Log entries for one Stripe event, oldest first.
function entriesFor(eventLog: EventLog, eventId: string) {
  return eventLog.list().filter((e) => e.stripeEventId === eventId).reverse();
}

test('applied: a handled event moves the order, marks it processed and logs the change', () => {
  const { db, orders, eventLog, processor, newOrder, isMarked } = setup();
  const order = newOrder('embedded');
  const event = paymentIntentSucceeded({ orderId: order.id });

  assert.equal(processor.process(event), 'applied');

  assert.equal(orders.get(order.id)?.status, 'paid');
  assert.equal(isMarked(event.id), true);
  const [entry, ...rest] = eventLog.list();
  assert.equal(rest.length, 0);
  assert.equal(entry.stripeEventId, event.id);
  assert.equal(entry.type, 'payment_intent.succeeded');
  assert.equal(entry.stripeCreatedAt, new Date(event.created * 1000).toISOString());
  assert.equal(entry.orderId, order.id);
  assert.equal(entry.outcome, 'applied');
  assert.equal(entry.detail, 'pending → paid');
  assert.equal(db.isTransaction, false);
  db.close();
});

test('ignored_duplicate: a resent event changes nothing but gets its own log row', () => {
  const { db, orders, eventLog, processor, newOrder, processedCount } = setup();
  const order = newOrder('embedded');
  const event = paymentIntentSucceeded({ orderId: order.id });
  processor.process(event);
  const before = orders.get(order.id);

  assert.equal(processor.process(event), 'ignored_duplicate');

  assert.deepEqual(orders.get(order.id), before);
  assert.equal(processedCount(), 1);
  const entries = entriesFor(eventLog, event.id);
  assert.deepEqual(
    entries.map((e) => [e.outcome, e.orderId, e.detail]),
    [
      ['applied', order.id, 'pending → paid'],
      ['ignored_duplicate', order.id, null],
    ],
  );
  db.close();
});

test('a duplicate is reported as such even when the status now allows the transition', () => {
  const { db, orders, processor, newOrder } = setup();
  const order = newOrder('embedded');
  const succeeded = paymentIntentSucceeded({ orderId: order.id });
  processor.process(succeeded);
  // Forced directly so that failed → paid would be allowed if the replay weren't caught.
  orders.setStatus(order.id, 'failed');

  assert.equal(processor.process(succeeded), 'ignored_duplicate');
  assert.equal(orders.get(order.id)?.status, 'failed');
  db.close();
});

test('duplicate takes precedence over unhandled type and unknown order', () => {
  const { db, eventLog, processor, processedCount } = setup();
  const unhandledEvent = unhandled('customer.created');
  const unknownEvent = paymentIntentSucceeded({ orderId: 'ord_missing' });
  processor.process(unhandledEvent);
  processor.process(unknownEvent);

  assert.equal(processor.process(unhandledEvent), 'ignored_duplicate');
  assert.equal(processor.process(unknownEvent), 'ignored_duplicate');

  assert.equal(processedCount(), 2);
  assert.deepEqual(
    entriesFor(eventLog, unknownEvent.id).map((e) => [e.outcome, e.orderId]),
    [
      ['ignored_unknown_order', null],
      ['ignored_duplicate', null],
    ],
  );
  db.close();
});

test('ignored_transition: a same-status event is logged as "already <status>"', () => {
  const { db, orders, eventLog, processor, newOrder } = setup();
  const order = newOrder('embedded');
  processor.process(paymentIntentSucceeded({ orderId: order.id }));
  const again = paymentIntentSucceeded({ orderId: order.id });

  assert.equal(processor.process(again), 'ignored_transition');

  assert.equal(orders.get(order.id)?.status, 'paid');
  const [entry] = entriesFor(eventLog, again.id);
  assert.equal(entry.detail, 'already paid');
  assert.equal(entry.orderId, order.id);
  db.close();
});

test('ignored_transition: a disallowed move is logged as "<from> → <to> not allowed"', () => {
  const { db, orders, eventLog, processor, newOrder, isMarked } = setup();
  const order = newOrder('checkout');
  processor.process(checkoutSessionExpired({ orderId: order.id }));
  const late = paymentIntentSucceeded({ orderId: order.id });

  assert.equal(processor.process(late), 'ignored_transition');

  assert.equal(orders.get(order.id)?.status, 'canceled');
  assert.equal(entriesFor(eventLog, late.id)[0].detail, 'canceled → paid not allowed');
  assert.equal(isMarked(late.id), true);
  db.close();
});

test('ignored_transition: a handled event that requests no status gets "no status change requested"', () => {
  const { db, orders, eventLog, processor, newOrder } = setup();
  const order = newOrder('checkout');
  const unpaid = checkoutSessionCompleted({ orderId: order.id, paymentStatus: 'unpaid' });

  assert.equal(processor.process(unpaid), 'ignored_transition');
  assert.equal(orders.get(order.id)?.status, 'pending');
  assert.equal(entriesFor(eventLog, unpaid.id)[0].detail, 'no status change requested');

  processor.process(paymentIntentSucceeded({ orderId: order.id }));
  const partial = chargeRefunded({ orderId: order.id, refunded: false });
  assert.equal(processor.process(partial), 'ignored_transition');
  assert.equal(orders.get(order.id)?.status, 'paid');
  assert.equal(entriesFor(eventLog, partial.id)[0].detail, 'no status change requested');
  db.close();
});

test('ignored_unknown_order: metadata pointing at a missing order logs a null orderId', () => {
  const { db, eventLog, processor, isMarked } = setup();
  const event = paymentIntentSucceeded({ orderId: 'ord_does_not_exist' });

  assert.equal(processor.process(event), 'ignored_unknown_order');

  const [entry] = entriesFor(eventLog, event.id);
  assert.equal(entry.orderId, null);
  assert.equal(entry.detail, null);
  assert.equal(isMarked(event.id), true);
  db.close();
});

test('ignored_unknown_order: an event with no metadata and no matching IDs', () => {
  const { db, orders, eventLog, processor, newOrder } = setup();
  const bystander = newOrder('embedded');
  const events = [
    checkoutSessionCompleted(),
    checkoutSessionExpired(),
    paymentIntentSucceeded(),
    paymentIntentFailed(),
    chargeRefunded(),
  ];

  for (const event of events) {
    const object = event.data.object;
    assert.deepEqual('metadata' in object ? object.metadata : undefined, {});
    assert.equal(processor.process(event), 'ignored_unknown_order', event.type);
    assert.equal(entriesFor(eventLog, event.id)[0].orderId, null);
  }
  assert.equal(orders.get(bystander.id)?.status, 'pending');
  db.close();
});

test('ignored_unhandled_type: acknowledged, marked processed, and takes precedence over unknown order', () => {
  const { db, eventLog, processor, isMarked } = setup();
  const event = unhandled('customer.created');

  assert.equal(processor.process(event), 'ignored_unhandled_type');

  const [entry] = entriesFor(eventLog, event.id);
  assert.equal(entry.type, 'customer.created');
  assert.equal(entry.orderId, null);
  assert.equal(entry.detail, null);
  assert.equal(isMarked(event.id), true);
  db.close();
});

test('ignored_unhandled_type: a resolvable order is recorded but not changed', () => {
  const { db, orders, eventLog, processor, newOrder } = setup();
  const order = newOrder('embedded');
  const event = unhandled('payment_intent.created', {
    object: { id: 'pi_test_other', object: 'payment_intent', metadata: { order_id: order.id } },
  });

  assert.equal(processor.process(event), 'ignored_unhandled_type');

  assert.equal(orders.get(order.id)?.status, 'pending');
  assert.equal(entriesFor(eventLog, event.id)[0].orderId, order.id);
  db.close();
});

test('every R4.2 transition lands in the DB', () => {
  const { db, orders, processor, newOrder } = setup();
  const cases: [(id: string) => Stripe.Event, OrderStatus][] = [
    [(id) => checkoutSessionCompleted({ orderId: id }), 'paid'],
    [(id) => paymentIntentSucceeded({ orderId: id }), 'paid'],
    [(id) => paymentIntentFailed({ orderId: id }), 'failed'],
    [(id) => checkoutSessionExpired({ orderId: id }), 'canceled'],
  ];
  for (const [build, expected] of cases) {
    const order = newOrder();
    assert.equal(processor.process(build(order.id)), 'applied');
    assert.equal(orders.get(order.id)?.status, expected);
  }

  const order = newOrder();
  processor.process(paymentIntentSucceeded({ orderId: order.id }));
  assert.equal(processor.process(chargeRefunded({ orderId: order.id })), 'applied');
  assert.equal(orders.get(order.id)?.status, 'refunded');
  db.close();
});

test('resolution falls back to the Checkout Session ID', () => {
  const { db, orders, eventLog, processor, newOrder } = setup();
  const order = newOrder('checkout');
  orders.attachCheckoutSession(order.id, 'cs_test_lookup');
  const event = checkoutSessionExpired({ sessionId: 'cs_test_lookup' });

  assert.equal(processor.process(event), 'applied');
  assert.equal(orders.get(order.id)?.status, 'canceled');
  assert.equal(entriesFor(eventLog, event.id)[0].orderId, order.id);
  db.close();
});

test('resolution falls back to the PaymentIntent ID', () => {
  const { db, orders, processor, newOrder } = setup();
  const order = newOrder('embedded');
  orders.attachPaymentIntent(order.id, 'pi_test_lookup');

  assert.equal(processor.process(paymentIntentFailed({ paymentIntentId: 'pi_test_lookup' })), 'applied');
  assert.equal(orders.get(order.id)?.status, 'failed');
  db.close();
});

test("resolution falls back to a charge's payment_intent", () => {
  const { db, orders, processor, newOrder } = setup();
  const order = newOrder('embedded');
  orders.attachPaymentIntent(order.id, 'pi_test_charge');
  processor.process(paymentIntentSucceeded({ paymentIntentId: 'pi_test_charge' }));

  assert.equal(processor.process(chargeRefunded({ paymentIntentId: 'pi_test_charge' })), 'applied');
  assert.equal(orders.get(order.id)?.status, 'refunded');
  db.close();
});

test('a metadata order_id that does not exist falls through to the ID lookups', () => {
  const { db, orders, processor, newOrder } = setup();
  const order = newOrder('embedded');
  orders.attachPaymentIntent(order.id, 'pi_test_fallthrough');
  const event = paymentIntentSucceeded({ orderId: 'ord_missing', paymentIntentId: 'pi_test_fallthrough' });

  assert.equal(processor.process(event), 'applied');
  assert.equal(orders.get(order.id)?.status, 'paid');
  db.close();
});

test('checkout.session.completed backfills the PaymentIntent so a later refund resolves', () => {
  const { db, orders, eventLog, processor, newOrder } = setup();
  const order = newOrder('checkout');
  orders.attachCheckoutSession(order.id, 'cs_test_backfill');

  processor.process(checkoutSessionCompleted({ sessionId: 'cs_test_backfill', paymentIntentId: 'pi_test_backfill' }));
  assert.equal(orders.get(order.id)?.stripePaymentIntentId, 'pi_test_backfill');

  const refund = chargeRefunded({ paymentIntentId: 'pi_test_backfill' });
  assert.equal(processor.process(refund), 'applied');
  assert.equal(orders.get(order.id)?.status, 'refunded');
  assert.equal(entriesFor(eventLog, refund.id)[0].orderId, order.id);
  db.close();
});

test('a checkout order learns its PaymentIntent from whichever event arrives first', () => {
  const { db, orders, processor, newOrder } = setup();
  const order = newOrder('checkout');
  processor.process(paymentIntentSucceeded({ orderId: order.id, paymentIntentId: 'pi_test_late' }));
  assert.equal(orders.get(order.id)?.stripePaymentIntentId, 'pi_test_late');

  const completed = checkoutSessionCompleted({ orderId: order.id, paymentIntentId: 'pi_test_late' });
  assert.equal(processor.process(completed), 'ignored_transition');
  assert.equal(orders.get(order.id)?.stripePaymentIntentId, 'pi_test_late');
  db.close();
});

test('the backfill never overwrites an existing PaymentIntent and tolerates a null one', () => {
  const { db, orders, processor, newOrder } = setup();
  const kept = newOrder('checkout');
  orders.attachPaymentIntent(kept.id, 'pi_test_original');
  processor.process(checkoutSessionCompleted({ orderId: kept.id, paymentIntentId: 'pi_test_other' }));
  assert.equal(orders.get(kept.id)?.stripePaymentIntentId, 'pi_test_original');

  const none = newOrder('checkout');
  assert.equal(processor.process(checkoutSessionCompleted({ orderId: none.id, paymentIntentId: null })), 'applied');
  assert.equal(orders.get(none.id)?.stripePaymentIntentId, null);
  db.close();
});

test('an expanded payment_intent object is read by its ID for backfill and charge resolution', () => {
  const { db, orders, processor, newOrder } = setup();
  const order = newOrder('checkout');
  const session = unhandled('checkout.session.completed', {
    object: {
      id: 'cs_test_expanded',
      object: 'checkout.session',
      payment_status: 'paid',
      payment_intent: { id: 'pi_test_expanded', object: 'payment_intent' },
      metadata: { order_id: order.id },
    },
  });
  assert.equal(processor.process(session), 'applied');
  assert.equal(orders.get(order.id)?.stripePaymentIntentId, 'pi_test_expanded');

  const charge = unhandled('charge.refunded', {
    object: {
      id: 'ch_test_expanded',
      object: 'charge',
      refunded: true,
      payment_intent: { id: 'pi_test_expanded', object: 'payment_intent' },
      metadata: {},
    },
  });
  assert.equal(processor.process(charge), 'applied');
  assert.equal(orders.get(order.id)?.status, 'refunded');
  db.close();
});

for (const [label, first, second] of [
  ['session first', 'session', 'intent'],
  ['intent first', 'intent', 'session'],
] as const) {
  test(`checkout's two events in either order end at paid with one applied entry (${label})`, () => {
    const { db, orders, eventLog, processor, newOrder } = setup();
    const order = newOrder('checkout');
    const build = {
      session: () => checkoutSessionCompleted({ orderId: order.id, paymentIntentId: 'pi_test_pair' }),
      intent: () => paymentIntentSucceeded({ orderId: order.id, paymentIntentId: 'pi_test_pair' }),
    };

    assert.equal(processor.process(build[first]()), 'applied');
    assert.equal(processor.process(build[second]()), 'ignored_transition');

    assert.equal(orders.get(order.id)?.status, 'paid');
    const entries = eventLog.listForOrder(order.id);
    assert.deepEqual(
      entries.map((e) => [e.outcome, e.detail]),
      [
        ['applied', 'pending → paid'],
        ['ignored_transition', 'already paid'],
      ],
    );
    db.close();
  });
}

test('failed → paid on a retry', () => {
  const { db, orders, eventLog, processor, newOrder } = setup();
  const order = newOrder('embedded');
  processor.process(paymentIntentFailed({ orderId: order.id }));
  assert.equal(orders.get(order.id)?.status, 'failed');

  const retry = paymentIntentSucceeded({ orderId: order.id });
  assert.equal(processor.process(retry), 'applied');
  assert.equal(orders.get(order.id)?.status, 'paid');
  assert.equal(entriesFor(eventLog, retry.id)[0].detail, 'failed → paid');
  db.close();
});

test('out of order: payment_failed after paid is ignored and the order stays paid', () => {
  const { db, orders, eventLog, processor, newOrder, isMarked } = setup();
  const order = newOrder('embedded');
  processor.process(paymentIntentSucceeded({ orderId: order.id }));
  const late = paymentIntentFailed({ orderId: order.id });

  assert.equal(processor.process(late), 'ignored_transition');

  assert.equal(orders.get(order.id)?.status, 'paid');
  assert.equal(entriesFor(eventLog, late.id)[0].detail, 'paid → failed not allowed');
  assert.equal(isMarked(late.id), true);
  db.close();
});

test('rollback: a failing log insert undoes the status change and the processed mark', () => {
  const { db, orders, eventLog, processor, newOrder, processedCount } = setup();
  const order = newOrder('embedded');
  const event = paymentIntentSucceeded({ orderId: order.id });
  db.exec(`CREATE TEMP TRIGGER fail_log BEFORE INSERT ON webhook_events BEGIN SELECT RAISE(ABORT, 'boom'); END;`);

  assert.throws(() => processor.process(event), /boom/);

  assert.equal(db.isTransaction, false);
  assert.equal(orders.get(order.id)?.status, 'pending');
  assert.equal(processedCount(), 0);
  assert.equal(eventLog.list().length, 0);

  db.exec('DROP TRIGGER fail_log');
  assert.equal(processor.process(event), 'applied');
  assert.equal(orders.get(order.id)?.status, 'paid');
  assert.equal(processedCount(), 1);
  db.close();
});

test('logs one info line per event with type, ID, outcome and detail only', () => {
  const lines: string[] = [];
  const logger: Logger = {
    info: (...args) => lines.push(args.join(' ')),
    warn: () => assert.fail('unexpected warn'),
    error: () => assert.fail('unexpected error'),
  };
  const { db, processor, newOrder } = setup({ logger });
  const order = newOrder('embedded');
  const event = paymentIntentSucceeded({ orderId: order.id, paymentIntentId: 'pi_test_secretish' });
  const unknown = unhandled('customer.created');

  processor.process(event);
  processor.process(event);
  processor.process(unknown);

  assert.equal(lines.length, 3);
  for (const text of ['payment_intent.succeeded', event.id, 'applied', 'pending → paid']) {
    assert.ok(lines[0].includes(text), `expected "${text}" in: ${lines[0]}`);
  }
  assert.ok(lines[1].includes('ignored_duplicate'));
  assert.ok(lines[2].includes('customer.created') && lines[2].includes('ignored_unhandled_type'));
  for (const line of lines) {
    assert.ok(!line.includes('pi_test_secretish'), line);
    assert.ok(!line.includes(order.id), line);
  }
  db.close();
});

test('recovers an embedded order whose PaymentIntent ID was never saved, so it can still be refunded', () => {
  // Simulates the server failing after Stripe created the PaymentIntent but before the ID was saved locally.
  const { db, orders, processor, newOrder } = setup();
  const order = newOrder('embedded');
  assert.equal(order.stripePaymentIntentId, null);

  assert.equal(processor.process(paymentIntentSucceeded({ orderId: order.id, paymentIntentId: 'pi_test_lost' })), 'applied');
  assert.equal(orders.get(order.id)?.stripePaymentIntentId, 'pi_test_lost');

  // A refund event carries no order metadata; it can only be matched through the recovered PaymentIntent ID.
  assert.equal(processor.process(chargeRefunded({ paymentIntentId: 'pi_test_lost' })), 'applied');
  assert.equal(orders.get(order.id)?.status, 'refunded');
  db.close();
});

test('never links a PaymentIntent ID that another order already owns', () => {
  const { db, orders, processor, newOrder } = setup();
  const owner = newOrder('embedded');
  orders.attachPaymentIntent(owner.id, 'pi_test_taken');
  const other = newOrder('embedded');

  assert.equal(processor.process(paymentIntentSucceeded({ orderId: other.id, paymentIntentId: 'pi_test_taken' })), 'applied');
  assert.equal(orders.get(other.id)?.stripePaymentIntentId, null);
  assert.equal(orders.get(owner.id)?.stripePaymentIntentId, 'pi_test_taken');
  db.close();
});
