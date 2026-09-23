import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Stripe from 'stripe';
import type { Server } from 'node:http';
import { createWebhookRouter } from '../src/routes/webhook.ts';
import { createWebhookVerifier } from '../src/webhook-verifier.ts';
import { paymentIntentSucceeded, sign } from './helpers/stripe-events.ts';
import type { Logger, Outcome, WebhookProcessor } from '../src/types.ts';

const SECRET = 'whsec_test_secret';
const silentLogger: Logger = { info() {}, warn() {}, error() {} };

function stubProcessor(
  impl: (event: Stripe.Event) => Outcome = () => 'applied',
): WebhookProcessor & { calls: Stripe.Event[] } {
  const calls: Stripe.Event[] = [];
  return {
    calls,
    process(event: Stripe.Event) {
      calls.push(event);
      return impl(event);
    },
  };
}

type ServerOptions = { secret?: string | null; processor: WebhookProcessor; logger?: Logger; jsonAfter?: boolean };

async function withServer<T>(
  { secret = SECRET, processor, logger = silentLogger, jsonAfter = false }: ServerOptions,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(createWebhookRouter({ verifier: createWebhookVerifier(secret), processor, logger }));
  if (jsonAfter) app.use(express.json());
  const server: Server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(baseUrl: string, { body, header }: { body: string; header?: string }): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (header !== undefined) headers['stripe-signature'] = header;
  return fetch(`${baseUrl}/webhook`, { method: 'POST', headers, body });
}

test('a valid signature returns 200 with the outcome and passes the parsed event to the processor', async () => {
  const event = paymentIntentSucceeded({ orderId: 'ord_test_router', paymentIntentId: 'pi_test_router' });
  const processor = stubProcessor(() => 'applied');
  await withServer({ processor }, async (baseUrl) => {
    const res = await post(baseUrl, sign(event, SECRET));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true, outcome: 'applied' });
  });
  assert.equal(processor.calls.length, 1);
  assert.deepEqual(processor.calls[0], event);
});

test('a bad signature returns 400 and the processor is not called', async () => {
  const event = paymentIntentSucceeded({ orderId: 'ord_test_router' });
  const processor = stubProcessor();
  await withServer({ processor }, async (baseUrl) => {
    const res = await post(baseUrl, sign(event, 'whsec_wrong_secret'));
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(typeof json.error.message, 'string');
  });
  assert.equal(processor.calls.length, 0);
});

test('a missing signature header returns 400 and the processor is not called', async () => {
  const processor = stubProcessor();
  await withServer({ processor }, async (baseUrl) => {
    const { body } = sign(paymentIntentSucceeded({ orderId: 'ord_test_router' }), SECRET);
    const res = await post(baseUrl, { body });
    assert.equal(res.status, 400);
  });
  assert.equal(processor.calls.length, 0);
});

test('an expired timestamp returns 400 and the processor is not called', async () => {
  const processor = stubProcessor();
  await withServer({ processor }, async (baseUrl) => {
    const timestamp = Math.floor(Date.now() / 1000) - 3600;
    const res = await post(baseUrl, sign(paymentIntentSucceeded({ orderId: 'ord_test_router' }), SECRET, { timestamp }));
    assert.equal(res.status, 400);
  });
  assert.equal(processor.calls.length, 0);
});

test('a null secret returns 503 and the processor is not called', async () => {
  const processor = stubProcessor();
  await withServer({ secret: null, processor }, async (baseUrl) => {
    const res = await post(baseUrl, sign(paymentIntentSucceeded({ orderId: 'ord_test_router' }), SECRET));
    assert.equal(res.status, 503);
  });
  assert.equal(processor.calls.length, 0);
});

test('a processor that throws returns 500 and logs an error', async () => {
  const errors: unknown[][] = [];
  const logger: Logger = { ...silentLogger, error: (...args: unknown[]) => errors.push(args) };
  const processor = stubProcessor(() => {
    throw new Error('db exploded');
  });
  await withServer({ processor, logger }, async (baseUrl) => {
    const res = await post(baseUrl, sign(paymentIntentSucceeded({ orderId: 'ord_test_router' }), SECRET));
    assert.equal(res.status, 500);
  });
  assert.equal(processor.calls.length, 1);
  assert.equal(errors.length, 1);
});

test('mounting express.json() after the router still verifies against the raw body', async () => {
  const event = paymentIntentSucceeded({ orderId: 'ord_test_router' });
  const processor = stubProcessor(() => 'applied');
  await withServer({ processor, jsonAfter: true }, async (baseUrl) => {
    // Pretty-printed so a parsed-and-restringified body would no longer match the signature.
    const body = JSON.stringify(event, null, 2);
    const header = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET });
    const res = await post(baseUrl, { body, header });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true, outcome: 'applied' });
  });
  assert.deepEqual(processor.calls[0], event);
});
