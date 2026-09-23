import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config.js';

const VALID = {
  STRIPE_SECRET_KEY: 'sk_test_51SecretValueThatMustNeverLeak',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_51PublishableValueXyz',
  STRIPE_WEBHOOK_SECRET: 'whsec_WebhookSecretValueAbc',
};

function load(overrides = {}) {
  const env = { ...VALID, ...overrides };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return loadConfig(env);
}

function assertConfigError(overrides, message) {
  assert.throws(() => load(overrides), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.equal(err.name, 'ConfigError');
    if (message) assert.match(err.message, message);
    return true;
  });
}

test('valid config gets the documented defaults', () => {
  const config = load();
  assert.deepEqual(config, {
    stripeSecretKey: VALID.STRIPE_SECRET_KEY,
    stripePublishableKey: VALID.STRIPE_PUBLISHABLE_KEY,
    webhookSecret: VALID.STRIPE_WEBHOOK_SECRET,
    port: 3000,
    databasePath: 'data/stripe-demo.db',
    baseUrl: 'http://127.0.0.1:3000',
  });
});

test('PORT and DATABASE_PATH override the defaults', () => {
  const config = load({ PORT: '4242', DATABASE_PATH: '/tmp/x.db' });
  assert.equal(config.port, 4242);
  assert.equal(config.baseUrl, 'http://127.0.0.1:4242');
  assert.equal(config.databasePath, '/tmp/x.db');
});

test('the returned object is frozen', () => {
  const config = load();
  assert.ok(Object.isFrozen(config));
  assert.throws(() => {
    config.port = 1;
  }, TypeError);
});

test('secret key must be present and start with sk_test_', () => {
  assertConfigError({ STRIPE_SECRET_KEY: undefined }, /STRIPE_SECRET_KEY is missing/);
  assertConfigError({ STRIPE_SECRET_KEY: '' }, /STRIPE_SECRET_KEY is missing/);
  assertConfigError({ STRIPE_SECRET_KEY: 'sk_live_abc123' }, /live keys are forbidden/);
  assertConfigError({ STRIPE_SECRET_KEY: 'rk_test_abc123' }, /must start with sk_test_/);
  assertConfigError({ STRIPE_SECRET_KEY: 'pk_test_abc123' }, /must start with sk_test_/);
});

test('publishable key must be present and start with pk_test_', () => {
  assertConfigError({ STRIPE_PUBLISHABLE_KEY: undefined }, /STRIPE_PUBLISHABLE_KEY is missing/);
  assertConfigError({ STRIPE_PUBLISHABLE_KEY: '' }, /STRIPE_PUBLISHABLE_KEY is missing/);
  assertConfigError({ STRIPE_PUBLISHABLE_KEY: 'pk_live_abc123' }, /must start with pk_test_/);
  assertConfigError({ STRIPE_PUBLISHABLE_KEY: 'sk_test_abc123' }, /must start with pk_test_/);
});

test('missing webhook secret gives null', () => {
  assert.equal(load({ STRIPE_WEBHOOK_SECRET: undefined }).webhookSecret, null);
  assert.equal(load({ STRIPE_WEBHOOK_SECRET: '' }).webhookSecret, null);
});

test('webhook secret without whsec_ throws', () => {
  assertConfigError({ STRIPE_WEBHOOK_SECRET: 'sec_abc123' }, /must start with whsec_/);
});

test('a bad PORT throws', () => {
  for (const PORT of ['0', '65536', '-1', '3000.5', 'abc', '30 00', '1e3']) {
    assertConfigError({ PORT }, /PORT must be an integer/);
  }
  assert.equal(load({ PORT: '1' }).port, 1);
  assert.equal(load({ PORT: '65535' }).port, 65535);
});

test('error messages never contain the rejected value', () => {
  const cases = [
    { STRIPE_SECRET_KEY: 'sk_live_fake_do_not_print' },
    { STRIPE_SECRET_KEY: 'xx_test_51OtherSecretValueDoNotPrint' },
    { STRIPE_PUBLISHABLE_KEY: 'pk_live_fake_do_not_print' },
    { STRIPE_WEBHOOK_SECRET: 'wh_51WebhookSecretValueDoNotPrint' },
  ];
  for (const overrides of cases) {
    const value = Object.values(overrides)[0];
    assert.throws(() => load(overrides), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(!err.message.includes(value), `message leaked ${value}`);
      assert.ok(!err.stack.includes(value), `stack leaked ${value}`);
      return true;
    });
  }
});

test('an invalid key error does not leak the other valid secrets', () => {
  assert.throws(() => load({ STRIPE_PUBLISHABLE_KEY: 'bad' }), (err) => {
    for (const secret of [VALID.STRIPE_SECRET_KEY, VALID.STRIPE_WEBHOOK_SECRET]) {
      assert.ok(!err.message.includes(secret));
    }
    return true;
  });
});
