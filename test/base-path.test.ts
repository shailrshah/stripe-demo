import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './helpers/test-server.ts';
import { paymentIntentSucceeded } from './helpers/stripe-events.ts';

const PUBLIC = 'https://demo.example.test/stripe-demo';

let srv: TestServer;

before(async () => {
  srv = await startTestServer({ baseUrl: PUBLIC });
});

after(async () => {
  await srv.close();
});

const get = (path: string) => fetch(`${srv.url}${path}`, { redirect: 'manual' });

test('the root and the bare prefix redirect to the prefix with a trailing slash', async () => {
  for (const [path, location] of [['/', '/stripe-demo/'], ['/stripe-demo', '/stripe-demo/'], ['/stripe-demo?x=1', '/stripe-demo/?x=1']]) {
    const res = await get(path);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get('location'), location, path);
  }
});

test('pages, assets and the API are served under the prefix', async () => {
  const page = await get('/stripe-demo/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /index\.js/);
  assert.equal((await get('/stripe-demo/styles.css')).status, 200);
  assert.equal((await get('/stripe-demo/orders.html')).status, 200);
  assert.equal((await get('/stripe-demo/api/products')).status, 200);
});

test('site routes are not served outside the prefix', async () => {
  assert.equal((await get('/api/products')).status, 404);
  assert.equal((await get('/orders.html')).status, 404);
});

test('Checkout return URLs use the public URL including the prefix', async () => {
  const res = await fetch(`${srv.url}/stripe-demo/checkout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'productId=duck',
  });
  assert.equal(res.status, 303);
  const [call] = srv.gateway.calls.filter((c) => c.method === 'createCheckoutSession');
  assert.ok(call?.method === 'createCheckoutSession');
  assert.match(call.args.successUrl, /^https:\/\/demo\.example\.test\/stripe-demo\/success\.html\?order_id=ord_/);
  assert.match(call.args.cancelUrl, /^https:\/\/demo\.example\.test\/stripe-demo\/cancel\?order_id=ord_/);
});

test('the webhook stays at the root, so stripe listen needs no change', async () => {
  const created = await fetch(`${srv.url}/stripe-demo/api/payment-intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productId: 'duck' }),
  });
  const { orderId } = (await created.json()) as { orderId: string };
  const detail = (await (await get(`/stripe-demo/api/orders/${orderId}`)).json()) as {
    order: { stripePaymentIntentId: string };
  };

  const webhook = await srv.postWebhook(
    paymentIntentSucceeded({ orderId, paymentIntentId: detail.order.stripePaymentIntentId }),
  );
  assert.equal(webhook.status, 200);
  assert.equal(webhook.body.outcome, 'applied');
});
