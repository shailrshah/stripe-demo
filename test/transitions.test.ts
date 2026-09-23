import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';
import type { OrderStatus } from '../src/types.ts';
import { HANDLED_TYPES, canTransition, eventTarget } from '../src/transitions.ts';

const STATUSES: OrderStatus[] = ['pending', 'paid', 'failed', 'canceled', 'refunded'];
const ALLOWED_PAIRS = new Set([
  'pending>paid',
  'pending>failed',
  'pending>canceled',
  'failed>paid',
  'paid>refunded',
]);

function event(type: string, object: Record<string, unknown> = {}): Stripe.Event {
  return { id: 'evt_1', type, data: { object } } as unknown as Stripe.Event;
}

test('canTransition matches the ALLOWED table on the full 5x5 matrix', () => {
  let allowed = 0;
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const expected = ALLOWED_PAIRS.has(`${from}>${to}`);
      assert.equal(canTransition(from, to), expected, `${from} -> ${to}`);
      if (expected) allowed++;
    }
  }
  assert.equal(allowed, ALLOWED_PAIRS.size);
});

test('canTransition rejects every same-status pair', () => {
  for (const status of STATUSES) {
    assert.equal(canTransition(status, status), false, `${status} -> ${status}`);
  }
});

test('canTransition rejects unknown statuses', () => {
  // Statuses read from the database aren't checked at runtime, so bogus ones must be rejected.
  const status = (s: string) => s as OrderStatus;
  assert.equal(canTransition(status('shipped'), 'paid'), false);
  assert.equal(canTransition('pending', status('shipped')), false);
  assert.equal(canTransition(status('constructor'), 'paid'), false);
});

test('eventTarget maps each handled event to its status', () => {
  const cases: [Stripe.Event, OrderStatus][] = [
    [event('checkout.session.completed', { payment_status: 'paid' }), 'paid'],
    [event('payment_intent.succeeded'), 'paid'],
    [event('payment_intent.payment_failed'), 'failed'],
    [event('checkout.session.expired'), 'canceled'],
    [event('charge.refunded', { refunded: true }), 'refunded'],
  ];
  for (const [evt, expected] of cases) {
    assert.equal(eventTarget(evt), expected, evt.type);
  }
});

test('eventTarget returns null when a handled event requests no change', () => {
  assert.equal(eventTarget(event('checkout.session.completed', { payment_status: 'unpaid' })), null);
  assert.equal(eventTarget(event('charge.refunded', { refunded: false })), null);
});

test('eventTarget returns null for an unhandled type', () => {
  assert.equal(eventTarget(event('customer.created')), null);
});

test('HANDLED_TYPES lists exactly the five handled types and is frozen', () => {
  assert.deepEqual([...HANDLED_TYPES].sort(), [
    'charge.refunded',
    'checkout.session.completed',
    'checkout.session.expired',
    'payment_intent.payment_failed',
    'payment_intent.succeeded',
  ]);
  assert.ok(Object.isFrozen(HANDLED_TYPES));
  assert.ok(!HANDLED_TYPES.includes('customer.created'));
});
