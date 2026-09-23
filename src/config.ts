export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// dotenv turns `KEY=` into an empty string, which should mean "not set".
function read(env, name) {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function requireSecretKey(value) {
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

function requirePublishableKey(value) {
  if (value === undefined) {
    throw new ConfigError('STRIPE_PUBLISHABLE_KEY is missing; set it to your pk_test_ key.');
  }
  if (!value.startsWith('pk_test_')) {
    throw new ConfigError('STRIPE_PUBLISHABLE_KEY must start with pk_test_.');
  }
  return value;
}

function parseWebhookSecret(value) {
  if (value === undefined) return null;
  if (!value.startsWith('whsec_')) {
    throw new ConfigError('STRIPE_WEBHOOK_SECRET must start with whsec_.');
  }
  return value;
}

function parsePort(value) {
  if (value === undefined) return 3000;
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    throw new ConfigError(`PORT must be an integer from 1 to 65535, got "${value}".`);
  }
  return port;
}

export function loadConfig(env = process.env) {
  const port = parsePort(read(env, 'PORT'));
  return Object.freeze({
    stripeSecretKey: requireSecretKey(read(env, 'STRIPE_SECRET_KEY')),
    stripePublishableKey: requirePublishableKey(read(env, 'STRIPE_PUBLISHABLE_KEY')),
    webhookSecret: parseWebhookSecret(read(env, 'STRIPE_WEBHOOK_SECRET')),
    port,
    databasePath: read(env, 'DATABASE_PATH') ?? 'data/stripe-demo.db',
    baseUrl: `http://127.0.0.1:${port}`,
  });
}
