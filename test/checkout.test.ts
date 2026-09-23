import { test, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import { createOrdersRepo } from '../src/orders.ts';
import { createFakeGateway } from './helpers/fake-gateway.ts';
import { createCheckoutRouter } from '../src/routes/checkout.ts';
import type { Config, Logger } from '../src/types.ts';

const BASE_URL = 'http://127.0.0.1:3000';
const CONFIG: Config = {
  stripeSecretKey: 'sk_test_fake_key',
  stripePublishableKey: 'pk_test_fake_key',
  webhookSecret: null,
  port: 0,
  databasePath: ':memory:',
  baseUrl: BASE_URL,
};
const CANCEL_STUB = '<!doctype html><title>stub cancel</title>';
const silentLogger: Logger = { info() {}, warn() {}, error() {} };

const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-test-'));
fs.writeFileSync(path.join(publicDir, 'cancel.html'), CANCEL_STUB);
after(() => fs.rmSync(publicDir, { recursive: true, force: true }));

async function setup(t: TestContext) {
  const db = openDb(':memory:');
  const orders = createOrdersRepo(db);
  const gateway = createFakeGateway();
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(createCheckoutRouter({ config: CONFIG, orders, gateway, logger: silentLogger, publicDir }));

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => {
    server.close();
    db.close();
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  const url = `http://127.0.0.1:${address.port}`;

  const postCheckout = (form: Record<string, string>): Promise<Response> =>
    fetch(`${url}/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
    });
  const getCancel = (query = ''): Promise<Response> => fetch(`${url}/cancel${query}`, { redirect: 'manual' });
  const orderCount = () => db.prepare('SELECT COUNT(*) AS n FROM orders').get()?.n;
  const onlyOrderId = (): string => {
    const row = db.prepare('SELECT id FROM orders').get();
    assert.ok(typeof row?.id === 'string');
    return row.id;
  };
  const callsTo = (method: string) => gateway.calls.filter((c) => c.method === method);

  return { orders, gateway, postCheckout, getCancel, orderCount, onlyOrderId, callsTo };
}

test('POST /checkout with a valid product redirects 303 to the session URL', async (t) => {
  const { postCheckout } = await setup(t);
  const res = await postCheckout({ productId: 'duck' });

  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://checkout.stripe.test/c/pay/cs_test_fake_1');
});

test('POST /checkout creates a checkout order with the session attached', async (t) => {
  const { orders, onlyOrderId, postCheckout } = await setup(t);
  await postCheckout({ productId: 'beans' });

  const id = onlyOrderId();
  const order = orders.get(id);
  assert.ok(order);
  assert.equal(order.method, 'checkout');
  assert.equal(order.status, 'pending');
  assert.equal(order.productId, 'beans');
  assert.equal(order.amountCents, 1250);
  assert.equal(order.stripeCheckoutSessionId, 'cs_test_fake_1');
});

test('POST /checkout calls the gateway with the catalog amount and both return URLs', async (t) => {
  const { onlyOrderId, postCheckout, callsTo } = await setup(t);
  await postCheckout({ productId: 'keyboard', amountCents: '1' });

  const id = onlyOrderId();
  const calls = callsTo('createCheckoutSession');
  assert.equal(calls.length, 1);
  const args = calls[0].args;
  assert.equal(args.orderId, id);
  assert.equal(args.product.id, 'keyboard');
  assert.equal(args.product.amountCents, 8900);
  assert.equal(args.successUrl, `${BASE_URL}/success.html?order_id=${id}`);
  assert.equal(args.cancelUrl, `${BASE_URL}/cancel?order_id=${id}`);
});

test('POST /checkout with an unknown or missing product gives 400 with no order and no gateway call', async (t) => {
  const { gateway, postCheckout, orderCount } = await setup(t);

  const forms: Record<string, string>[] = [{ productId: 'unicorn' }, {}];
  for (const form of forms) {
    const res = await postCheckout(form);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error.message, 'string');
  }
  assert.equal(orderCount(), 0);
  assert.equal(gateway.calls.length, 0);
});

test('POST /checkout gives 502 when the gateway fails', async (t) => {
  const { gateway, postCheckout } = await setup(t);
  gateway.failNext('createCheckoutSession');

  const res = await postCheckout({ productId: 'duck' });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(typeof body.error.message, 'string');
});

test('GET /cancel on a pending order expires its session once and serves the page', async (t) => {
  const { onlyOrderId, postCheckout, getCancel, callsTo } = await setup(t);
  await postCheckout({ productId: 'duck' });
  const id = onlyOrderId();

  const res = await getCancel(`?order_id=${id}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), CANCEL_STUB);
  assert.deepEqual(callsTo('expireCheckoutSession'), [
    { method: 'expireCheckoutSession', args: 'cs_test_fake_1' },
  ]);
});

test('GET /cancel does not expire a paid order, an unknown order or a missing order_id', async (t) => {
  const { orders, onlyOrderId, postCheckout, getCancel, callsTo } = await setup(t);
  await postCheckout({ productId: 'duck' });
  const id = onlyOrderId();
  orders.setStatus(id, 'paid');

  for (const query of [`?order_id=${id}`, '?order_id=ord_does_not_exist', '']) {
    const res = await getCancel(query);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), CANCEL_STUB);
  }
  assert.equal(callsTo('expireCheckoutSession').length, 0);
});

test('GET /cancel still serves the page when expiring the session fails', async (t) => {
  const { onlyOrderId, gateway, postCheckout, getCancel, callsTo } = await setup(t);
  await postCheckout({ productId: 'duck' });
  const id = onlyOrderId();
  gateway.failNext('expireCheckoutSession');

  const res = await getCancel(`?order_id=${id}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), CANCEL_STUB);
  assert.equal(callsTo('expireCheckoutSession').length, 1);
});
