import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createStripeGateway } from '../src/stripe-gateway.js';
import { createWebhookVerifier } from '../src/webhook-verifier.js';
import { createApp } from '../src/app.js';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));

class E2ESetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'E2ESetupError';
  }
}

function loadKeys() {
  // Parse into a throwaway object so .env can't leak into process.env or supply a webhook secret.
  const parsed = {};
  dotenv.config({ path: envPath, processEnv: parsed, quiet: true });
  return { STRIPE_SECRET_KEY: parsed.STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY: parsed.STRIPE_PUBLISHABLE_KEY };
}

function runCli(args, { allowFailure = false } = {}) {
  const result = spawnSync('stripe', args, { encoding: 'utf8', timeout: 60_000 });
  if (result.error?.code === 'ENOENT') {
    throw new E2ESetupError('Stripe CLI not found. Install it with: brew install stripe/stripe-cli/stripe');
  }
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`stripe ${args[0]} ${args[1] ?? ''} failed (exit ${result.status}): ${result.stderr.trim()}`);
  }
  return result;
}

function startListener(port) {
  const child = spawn('stripe', ['listen', '--all-snapshot', '--forward-to', `127.0.0.1:${port}/webhook`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new E2ESetupError('stripe listen did not become ready within 30s. Is the CLI logged in (stripe login)?'));
    }, 30_000);
    const onData = (chunk) => {
      output += chunk;
      if (output.includes('Ready!')) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new E2ESetupError(`stripe listen exited early (code ${code}). Is the CLI logged in (stripe login)?`));
    });
  });
}

export async function startE2E() {
  runCli(['version']);

  const secret = runCli(['listen', '--print-secret'], { allowFailure: true }).stdout.trim();
  if (!secret.startsWith('whsec_')) {
    throw new E2ESetupError('Could not get a webhook secret from `stripe listen --print-secret`. Run `stripe login` first.');
  }

  const dir = mkdtempSync(join(tmpdir(), 'stripe-demo-e2e-'));
  const config = loadConfig({
    ...loadKeys(),
    STRIPE_WEBHOOK_SECRET: secret,
    DATABASE_PATH: join(dir, 'e2e.db'),
  });

  const logs = [];
  const record = (...args) => logs.push(args.map(String).join(' '));
  const logger = { info: record, warn: record, error: record };

  const db = openDb(config.databasePath);
  const app = createApp({
    config,
    db,
    gateway: createStripeGateway(config.stripeSecretKey),
    verifier: createWebhookVerifier(config.webhookSecret),
    logger,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  let listener;
  try {
    listener = await startListener(server.address().port);
  } catch (err) {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  async function api(method, path, body, { form = false } = {}) {
    const init = { method, redirect: 'manual', headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
      init.body = form ? new URLSearchParams(body).toString() : JSON.stringify(body);
    }
    const res = await fetch(`${url}${path}`, init);
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, body: parsed };
  }

  async function waitFor(fn, { what, timeout = 30_000 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out after ${timeout / 1000}s waiting for ${what}. Check that events reach stripe listen ` +
            'and that the CLI is logged into the same account as STRIPE_SECRET_KEY.\n' +
            `Recent app log:\n  ${logs.slice(-15).join('\n  ')}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async function stop() {
    listener.kill();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  return {
    url,
    db,
    stripe: new Stripe(config.stripeSecretKey),
    api,
    waitFor,
    stripeCli: (...args) => runCli(args),
    logs,
    stop,
  };
}
