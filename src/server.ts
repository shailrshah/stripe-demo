import 'dotenv/config';
import { ConfigError, loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { createStripeGateway } from './stripe-gateway.ts';
import { createWebhookVerifier } from './webhook-verifier.ts';
import { startStripeListener } from './stripe-listener.ts';
import { createApp } from './app.ts';
import type { Config } from './types.ts';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}

const db = openDb(config.databasePath);
const gateway = createStripeGateway(config.stripeSecretKey);
const listenCommand = `stripe listen --all-snapshot --forward-to 127.0.0.1:${config.port}/webhook`;

// The listener's own secret wins: it's the one that signs what this listener forwards (R8.5).
const listener = process.env.STRIPE_LISTEN === 'false' ? null : startStripeListener({ port: config.port, logger: console });
const webhookSecret = listener?.secret ?? config.webhookSecret;
const verifier = createWebhookVerifier(webhookSecret);

if (!webhookSecret) {
  console.warn(
    [
      '',
      '!!! No webhook secret: STRIPE_WEBHOOK_SECRET is not set and stripe listen was not started.',
      '!!! Every webhook will be rejected (503), so orders will stay pending. Run the command below,',
      '!!! copy the whsec_ it prints into .env, and restart.',
      '',
    ].join('\n'),
  );
}

if (listener) {
  process.on('exit', () => listener.stop());
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      listener.stop();
      process.exit(0);
    });
  }
}

const app = createApp({ config, db, gateway, verifier, logger: console });

app.listen(config.port, '127.0.0.1', () => {
  console.log(`Stripe demo running at http://127.0.0.1:${config.port}${config.basePath}/`);
  if (config.baseUrl !== `http://127.0.0.1:${config.port}`) console.log(`Public URL (BASE_URL): ${config.baseUrl}/`);
  console.log(listener
    ? 'Webhooks: stripe listen started automatically (set STRIPE_LISTEN=false to run it yourself).'
    : `Forward webhooks with: ${listenCommand}`);
});
