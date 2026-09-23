import { loadConfig } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { createWebhookVerifier } from '../../src/webhook-verifier.ts';
import { createApp } from '../../src/app.ts';
import { createFakeGateway } from './fake-gateway.ts';
import { sign } from './stripe-events.ts';

export const silentLogger = { info() {}, warn() {}, error() {} };

export async function startTestServer({
  databasePath = ':memory:',
  webhookSecret = 'whsec_test_secret',
  gateway = createFakeGateway(),
  logger = silentLogger,
} = {}) {
  const config = loadConfig({
    STRIPE_SECRET_KEY: 'sk_test_fake_key',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_fake_key',
    STRIPE_WEBHOOK_SECRET: webhookSecret ?? '',
    DATABASE_PATH: databasePath,
  });
  const db = openDb(databasePath);
  const app = createApp({ config, db, gateway, verifier: createWebhookVerifier(config.webhookSecret), logger });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  // `header: null` sends no stripe-signature header; a string overrides the computed one.
  async function postWebhook(event, { secret = webhookSecret ?? 'whsec_unset', timestamp, header } = {}) {
    const signed = sign(event, secret, { timestamp });
    const signature = header === undefined ? signed.header : header;
    const res = await fetch(`${url}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signature === null ? {} : { 'stripe-signature': signature }),
      },
      body: signed.body,
    });
    return { status: res.status, body: await res.json() };
  }

  async function close() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }

  return { url, db, gateway, config, postWebhook, close };
}
