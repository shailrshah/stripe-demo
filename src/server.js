import 'dotenv/config';
import { ConfigError, loadConfig } from './config.js';
import { openDb } from './db.js';
import { createStripeGateway } from './stripe-gateway.js';
import { createWebhookVerifier } from './webhook-verifier.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}

const db = openDb(config.databasePath);
const gateway = createStripeGateway(config.stripeSecretKey);
const verifier = createWebhookVerifier(config.webhookSecret);

if (!config.webhookSecret) {
  console.warn(
    [
      '',
      '!!! STRIPE_WEBHOOK_SECRET is not set. Every webhook will be rejected (503),',
      '!!! so orders will stay pending. Run the command below, copy the whsec_ it',
      '!!! prints into .env, and restart.',
      '',
    ].join('\n'),
  );
}

const app = createApp({ config, db, gateway, verifier, logger: console });

app.listen(config.port, '127.0.0.1', () => {
  console.log(`Stripe demo running at ${config.baseUrl}`);
  console.log(`Forward webhooks with: stripe listen --all-snapshot --forward-to 127.0.0.1:${config.port}/webhook`);
});
