import type { Config } from './types.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

// dotenv turns `KEY=` into an empty string, which should mean "not set".
function read(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function requireSecretKey(value: string | undefined): string {
  if (value === undefined) {
    throw new ConfigError('STRIPE_SECRET_KEY is missing; set it to your sk_test_ key.');
  }
  if (value.startsWith('sk_live_')) {
    throw new ConfigError(
      'STRIPE_SECRET_KEY is a live key (sk_live_); live keys are forbidden, use an sk_test_ key.',
    );
  }
  if (!value.startsWith('sk_test_')) {
    throw new ConfigError('STRIPE_SECRET_KEY must start with sk_test_.');
  }
  return value;
}

function requirePublishableKey(value: string | undefined): string {
  if (value === undefined) {
    throw new ConfigError('STRIPE_PUBLISHABLE_KEY is missing; set it to your pk_test_ key.');
  }
  if (!value.startsWith('pk_test_')) {
    throw new ConfigError('STRIPE_PUBLISHABLE_KEY must start with pk_test_.');
  }
  return value;
}

function parseWebhookSecret(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!value.startsWith('whsec_')) {
    throw new ConfigError('STRIPE_WEBHOOK_SECRET must start with whsec_.');
  }
  return value;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3000;
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    throw new ConfigError(`PORT must be an integer from 1 to 65535, got "${value}".`);
  }
  return port;
}

// The public origin that browsers are sent back to from hosted Checkout, e.g. an ngrok URL.
// The server itself still listens on 127.0.0.1; a tunnel forwards public traffic to it.
function parseBaseUrl(value: string | undefined, port: number): string {
  if (value === undefined) return `http://127.0.0.1:${port}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`BASE_URL must be an absolute http(s) URL, got "${value}".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`BASE_URL must use http or https, got "${value}".`);
  }
  // The app is served from the root, so a path would produce broken return URLs.
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigError(`BASE_URL must be just an origin such as https://example.ngrok-free.app, got "${value}".`);
  }
  return url.origin;
}

export function loadConfig(env: Env = process.env): Readonly<Config> {
  const port = parsePort(read(env, 'PORT'));
  return Object.freeze({
    stripeSecretKey: requireSecretKey(read(env, 'STRIPE_SECRET_KEY')),
    stripePublishableKey: requirePublishableKey(read(env, 'STRIPE_PUBLISHABLE_KEY')),
    webhookSecret: parseWebhookSecret(read(env, 'STRIPE_WEBHOOK_SECRET')),
    port,
    databasePath: read(env, 'DATABASE_PATH') ?? 'data/stripe-demo.db',
    baseUrl: parseBaseUrl(read(env, 'BASE_URL'), port),
  });
}
