import { loadConfig } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { createWebhookVerifier } from '../../src/webhook-verifier.ts';
import { createApp } from '../../src/app.ts';
import { createFakeGateway } from './fake-gateway.ts';
import type { FakeGateway } from './fake-gateway.ts';
import { sign } from './stripe-events.ts';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import type Stripe from 'stripe';
import type { Config, Logger, Outcome } from '../../src/types.ts';

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export interface TestServerOptions {
  databasePath?: string;
  /** `null` starts the app without a webhook secret. */
  webhookSecret?: string | null;
  gateway?: FakeGateway;
  logger?: Logger;
}

export interface PostWebhookOptions {
  secret?: string;
  timestamp?: number;
  /** `null` sends no stripe-signature header; a string overrides the computed one. */
  header?: string | null;
}

/** Either the success body or the error body the webhook route sends. */
export interface WebhookResponseBody {
  received?: boolean;
  outcome?: Outcome;
  error?: { message: string };
}

export interface WebhookResponse { status: number; body: WebhookResponseBody }

export interface TestServer {
  url: string;
  db: DatabaseSync;
  gateway: FakeGateway;
  config: Config;
  postWebhook(event: Stripe.Event, opts?: PostWebhookOptions): Promise<WebhookResponse>;
  close(): Promise<void>;
}

export async function startTestServer({
  databasePath = ':memory:',
  webhookSecret = 'whsec_test_secret',
  gateway = createFakeGateway(),
  logger = silentLogger,
}: TestServerOptions = {}): Promise<TestServer> {
  const config: Config = loadConfig({
    STRIPE_SECRET_KEY: 'sk_test_fake_key',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_fake_key',
    STRIPE_WEBHOOK_SECRET: webhookSecret ?? '',
    DATABASE_PATH: databasePath,
  });
  const db = openDb(databasePath);
  const app = createApp({ config, db, gateway, verifier: createWebhookVerifier(config.webhookSecret), logger });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  // Listening on a TCP port always yields an AddressInfo, never a pipe name.
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function postWebhook(
    event: Stripe.Event,
    { secret = webhookSecret ?? 'whsec_unset', timestamp, header }: PostWebhookOptions = {},
  ): Promise<WebhookResponse> {
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
    return { status: res.status, body: (await res.json()) as WebhookResponseBody };
  }

  async function close(): Promise<void> {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }

  return { url, db, gateway, config, postWebhook, close };
}
