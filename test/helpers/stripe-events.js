import Stripe from 'stripe';

const API_VERSION = '2026-08-26.dahlia';
const AMOUNT = 500;

let counter = 0;
const nextId = (prefix) => `${prefix}_test_${++counter}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function metadataFor(orderId) {
  return orderId === undefined ? {} : { order_id: orderId };
}

function envelope(type, object, { id, created } = {}) {
  const ts = created ?? nowSeconds();
  return {
    id: id ?? nextId('evt'),
    object: 'event',
    api_version: API_VERSION,
    type,
    created: ts,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  };
}

function session({ orderId, sessionId, paymentIntentId, paymentStatus, status, created }) {
  return {
    id: sessionId ?? nextId('cs'),
    object: 'checkout.session',
    mode: 'payment',
    status,
    payment_status: paymentStatus,
    payment_intent: paymentIntentId === undefined ? nextId('pi') : paymentIntentId,
    amount_total: AMOUNT,
    currency: 'usd',
    livemode: false,
    created: created ?? nowSeconds(),
    metadata: metadataFor(orderId),
  };
}

function paymentIntent({ orderId, paymentIntentId, status, lastPaymentError = null, created }) {
  return {
    id: paymentIntentId ?? nextId('pi'),
    object: 'payment_intent',
    amount: AMOUNT,
    amount_received: status === 'succeeded' ? AMOUNT : 0,
    currency: 'usd',
    status,
    last_payment_error: lastPaymentError,
    livemode: false,
    created: created ?? nowSeconds(),
    metadata: metadataFor(orderId),
  };
}

export function checkoutSessionCompleted({ orderId, sessionId, paymentIntentId, paymentStatus = 'paid', id, created } = {}) {
  const object = session({ orderId, sessionId, paymentIntentId, paymentStatus, status: 'complete', created });
  return envelope('checkout.session.completed', object, { id, created });
}

export function checkoutSessionExpired({ orderId, sessionId, id, created } = {}) {
  const object = session({ orderId, sessionId, paymentIntentId: null, paymentStatus: 'unpaid', status: 'expired', created });
  return envelope('checkout.session.expired', object, { id, created });
}

export function paymentIntentSucceeded({ orderId, paymentIntentId, id, created } = {}) {
  const object = paymentIntent({ orderId, paymentIntentId, status: 'succeeded', created });
  return envelope('payment_intent.succeeded', object, { id, created });
}

export function paymentIntentFailed({ orderId, paymentIntentId, id, created } = {}) {
  const object = paymentIntent({
    orderId,
    paymentIntentId,
    status: 'requires_payment_method',
    lastPaymentError: { code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.' },
    created,
  });
  return envelope('payment_intent.payment_failed', object, { id, created });
}

export function chargeRefunded({ orderId, paymentIntentId, chargeId, refunded = true, id, created } = {}) {
  const object = {
    id: chargeId ?? nextId('ch'),
    object: 'charge',
    amount: AMOUNT,
    amount_captured: AMOUNT,
    amount_refunded: refunded ? AMOUNT : AMOUNT / 2,
    currency: 'usd',
    captured: true,
    paid: true,
    refunded,
    status: 'succeeded',
    payment_intent: paymentIntentId ?? nextId('pi'),
    livemode: false,
    created: created ?? nowSeconds(),
    metadata: metadataFor(orderId),
  };
  return envelope('charge.refunded', object, { id, created });
}

export function unhandled(type, { id, created, object = { id: nextId('obj'), object: 'unknown', metadata: {} } } = {}) {
  return envelope(type, object, { id, created });
}

export function sign(event, secret, { timestamp } = {}) {
  const body = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload: body, secret, timestamp });
  return { body, header };
}
