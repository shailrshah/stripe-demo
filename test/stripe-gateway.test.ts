import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStripeGateway } from '../src/stripe-gateway.ts';

const PRODUCT = {
  id: 'duck',
  name: 'Rubber Duck',
  description: 'For debugging conversations.',
  amountCents: 500,
};

function fakeClient() {
  const calls = [];
  const record = (name, result) => async (...args) => {
    calls.push({ name, args });
    return result;
  };
  const client = {
    checkout: {
      sessions: {
        create: record('checkout.sessions.create', {
          id: 'cs_test_1',
          url: 'https://checkout.stripe.com/c/pay/cs_test_1',
          object: 'checkout.session',
          status: 'open',
        }),
        expire: record('checkout.sessions.expire', {
          id: 'cs_test_1',
          object: 'checkout.session',
          status: 'expired',
        }),
      },
    },
    paymentIntents: {
      create: record('paymentIntents.create', {
        id: 'pi_test_1',
        client_secret: 'pi_test_1_secret_abc',
        object: 'payment_intent',
        amount: 500,
      }),
    },
    refunds: {
      create: record('refunds.create', {
        id: 're_test_1',
        object: 'refund',
        status: 'succeeded',
      }),
    },
  };
  return { client, calls };
}

test('createCheckoutSession sends the exact parameters and returns { id, url }', async () => {
  const { client, calls } = fakeClient();
  const gateway = createStripeGateway('sk_test_dummy', { client });

  const result = await gateway.createCheckoutSession({
    orderId: 'ord_1',
    product: PRODUCT,
    successUrl: 'http://127.0.0.1:3000/success.html?order_id=ord_1',
    cancelUrl: 'http://127.0.0.1:3000/cancel?order_id=ord_1',
  });

  assert.deepEqual(result, { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'checkout.sessions.create');
  assert.deepEqual(calls[0].args, [
    {
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: 500,
            product_data: { name: 'Rubber Duck', description: 'For debugging conversations.' },
          },
        },
      ],
      metadata: { order_id: 'ord_1' },
      payment_intent_data: { metadata: { order_id: 'ord_1' } },
      success_url: 'http://127.0.0.1:3000/success.html?order_id=ord_1',
      cancel_url: 'http://127.0.0.1:3000/cancel?order_id=ord_1',
    },
  ]);
});

test('expireCheckoutSession expires the session and returns nothing', async () => {
  const { client, calls } = fakeClient();
  const gateway = createStripeGateway('sk_test_dummy', { client });

  const result = await gateway.expireCheckoutSession('cs_test_1');

  assert.equal(result, undefined);
  assert.deepEqual(calls, [{ name: 'checkout.sessions.expire', args: ['cs_test_1'] }]);
});

test('createPaymentIntent sends the exact parameters and returns { id, clientSecret }', async () => {
  const { client, calls } = fakeClient();
  const gateway = createStripeGateway('sk_test_dummy', { client });

  const result = await gateway.createPaymentIntent({ orderId: 'ord_2', product: PRODUCT });

  assert.deepEqual(result, { id: 'pi_test_1', clientSecret: 'pi_test_1_secret_abc' });
  assert.deepEqual(calls, [
    {
      name: 'paymentIntents.create',
      args: [
        {
          amount: 500,
          currency: 'usd',
          metadata: { order_id: 'ord_2' },
          automatic_payment_methods: { enabled: true },
        },
      ],
    },
  ]);
});

test('createRefund sends the exact parameters and returns { id }', async () => {
  const { client, calls } = fakeClient();
  const gateway = createStripeGateway('sk_test_dummy', { client });

  const result = await gateway.createRefund({ paymentIntentId: 'pi_test_1', orderId: 'ord_3' });

  assert.deepEqual(result, { id: 're_test_1' });
  assert.deepEqual(calls, [
    {
      name: 'refunds.create',
      args: [{ payment_intent: 'pi_test_1', metadata: { order_id: 'ord_3' } }],
    },
  ]);
});

test('constructing without a client builds a real one without calling Stripe', () => {
  const gateway = createStripeGateway('sk_test_dummy');
  for (const name of [
    'createCheckoutSession',
    'expireCheckoutSession',
    'createPaymentIntent',
    'createRefund',
  ]) {
    assert.equal(typeof gateway[name], 'function', `missing ${name}`);
  }
});
