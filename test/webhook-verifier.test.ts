import { test } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import {
  createWebhookVerifier,
  WebhookSignatureError,
  WebhookNotConfiguredError,
} from '../src/webhook-verifier.ts';

const SECRET = 'whsec_test_secret';
const EVENT = { id: 'evt_1', object: 'event', type: 'payment_intent.succeeded', data: { object: {} } };
const PAYLOAD = JSON.stringify(EVENT);

function sign(payload, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
}

function assertSignatureError(fn) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof WebhookSignatureError);
    assert.equal(err.name, 'WebhookSignatureError');
    assert.ok(err.cause instanceof Error);
    return true;
  });
}

test('a valid signature returns the event', () => {
  const verifier = createWebhookVerifier(SECRET);
  const event = verifier.verify(Buffer.from(PAYLOAD), sign(PAYLOAD));
  assert.deepEqual(event, EVENT);
});

test('a tampered body throws WebhookSignatureError', () => {
  const verifier = createWebhookVerifier(SECRET);
  const header = sign(PAYLOAD);
  const tampered = PAYLOAD.replace('evt_1', 'evt_2');
  assertSignatureError(() => verifier.verify(Buffer.from(tampered), header));
});

test('the wrong secret throws WebhookSignatureError', () => {
  const verifier = createWebhookVerifier(SECRET);
  const header = sign(PAYLOAD, { secret: 'whsec_other_secret' });
  assertSignatureError(() => verifier.verify(Buffer.from(PAYLOAD), header));
});

test('a missing header throws WebhookSignatureError', () => {
  const verifier = createWebhookVerifier(SECRET);
  assertSignatureError(() => verifier.verify(Buffer.from(PAYLOAD), undefined));
});

test('a timestamp older than 300 seconds throws WebhookSignatureError', () => {
  const verifier = createWebhookVerifier(SECRET);
  const header = sign(PAYLOAD, { timestamp: Math.floor(Date.now() / 1000) - 301 });
  assertSignatureError(() => verifier.verify(Buffer.from(PAYLOAD), header));
});

test('a null secret throws WebhookNotConfiguredError', () => {
  const verifier = createWebhookVerifier(null);
  assert.throws(
    () => verifier.verify(Buffer.from(PAYLOAD), sign(PAYLOAD)),
    (err) => err instanceof WebhookNotConfiguredError && err.name === 'WebhookNotConfiguredError',
  );
});
