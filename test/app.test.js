import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer } from './helpers/test-server.js';
import { paymentIntentSucceeded } from './helpers/stripe-events.js';

const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url));

let srv;

before(async () => {
  srv = await startTestServer();
});

after(async () => {
  await srv.close();
});

test('serves the catalog page at /', async () => {
  const res = await fetch(`${srv.url}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /index\.js/);
});

test('serves the API through the assembled app', async () => {
  const res = await fetch(`${srv.url}/api/products`);
  assert.equal(res.status, 200);
  const products = await res.json();
  assert.ok(products.length > 0);
  assert.ok(products.every((p) => typeof p.price === 'string'));
});

test('unknown API routes return a JSON 404', async () => {
  const res = await fetch(`${srv.url}/api/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: { message: 'Not found' } });
});

test('malformed JSON bodies return a JSON 400', async () => {
  const res = await fetch(`${srv.url}/api/payment-intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error.message);
});

test('an embedded payment becomes paid only after its signed webhook', async () => {
  const created = await fetch(`${srv.url}/api/payment-intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productId: 'duck' }),
  });
  assert.equal(created.status, 201);
  const { orderId } = await created.json();

  const before = await (await fetch(`${srv.url}/api/orders/${orderId}`)).json();
  assert.equal(before.order.status, 'pending');

  const webhook = await srv.postWebhook(
    paymentIntentSucceeded({ orderId, paymentIntentId: before.order.stripePaymentIntentId }),
  );
  assert.equal(webhook.status, 200);
  assert.equal(webhook.body.outcome, 'applied');

  const afterPay = await (await fetch(`${srv.url}/api/orders/${orderId}`)).json();
  assert.equal(afterPay.order.status, 'paid');
  assert.equal(afterPay.events.length, 1);
  assert.equal(afterPay.events[0].outcome, 'applied');
});

test('server refuses to start with a live secret key and does not echo it', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'stripe-demo-live-'));
  try {
    const result = spawnSync(process.execPath, [serverPath], {
      cwd,
      env: {
        PATH: process.env.PATH,
        STRIPE_SECRET_KEY: 'sk_live_fake_do_not_print',
        STRIPE_PUBLISHABLE_KEY: 'pk_test_fake_key',
        DATABASE_PATH: join(cwd, 'db.sqlite'),
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /live keys are forbidden/);
    assert.doesNotMatch(result.stderr + result.stdout, /fake_do_not_print/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
