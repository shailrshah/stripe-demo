import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStripeListener } from '../src/stripe-listener.ts';
import type { Logger } from '../src/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'stripe-listener-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// A stand-in for the Stripe CLI: `listen --print-secret` prints a secret, plain `listen` behaves per `listenBody`.
function fakeCli(name: string, { printSecret, listenBody }: { printSecret: string; listenBody: string }): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nif [ "$2" = "--print-secret" ]; then\n${printSecret}\nfi\n${listenBody}\n`);
  chmodSync(path, 0o755);
  return path;
}

function recordingLogger() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  const logger: Logger = { info: record, warn: record, error: record };
  return { lines, logger };
}

async function waitFor(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const FORWARDING = `echo "> Ready! Your webhook signing secret is whsec_fakeSecret123 (^C to quit)"
echo "--> payment_intent.created [evt_test_1]"
exec sleep 30`;

test('returns the CLI secret and relays listener output with the secret redacted', async () => {
  const command = fakeCli('ok', { printSecret: 'echo whsec_fakeSecret123; exit 0', listenBody: FORWARDING });
  const { lines, logger } = recordingLogger();

  const listener = startStripeListener({ port: 3999, logger, command });
  assert.ok(listener);
  assert.equal(listener.secret, 'whsec_fakeSecret123');

  await waitFor(() => lines.some((l) => l.includes('payment_intent.created')), 'forwarded event line');
  assert.ok(lines.some((l) => l.startsWith('[stripe] > Ready!')));
  assert.ok(lines.every((l) => !l.includes('fakeSecret123')), 'secret must be redacted from output');

  listener.stop();
  listener.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(lines.every((l) => !l.includes('exited')), 'a deliberate stop must not warn');
});

test('warns loudly when the listener exits on its own', async () => {
  const command = fakeCli('dies', { printSecret: 'echo whsec_fakeSecret123; exit 0', listenBody: 'exit 3' });
  const { lines, logger } = recordingLogger();

  const listener = startStripeListener({ port: 3999, logger, command });
  assert.ok(listener);
  await waitFor(() => lines.some((l) => l.includes('stripe listen exited')), 'exit warning');
  assert.ok(lines.some((l) => l.includes('code 3') && l.includes('Webhooks will NOT arrive')));
});

test('returns null with a warning when the CLI is not installed', () => {
  const { lines, logger } = recordingLogger();
  assert.equal(startStripeListener({ port: 3999, logger, command: join(dir, 'missing') }), null);
  assert.match(lines.join('\n'), /Stripe CLI not found/);
});

test('returns null with a warning when the CLI cannot provide a secret', () => {
  for (const [name, printSecret] of [['fails', 'echo "not logged in" >&2; exit 1'], ['garbage', 'echo nope; exit 0']]) {
    const command = fakeCli(name, { printSecret, listenBody: FORWARDING });
    const { lines, logger } = recordingLogger();
    assert.equal(startStripeListener({ port: 3999, logger, command }), null, name);
    assert.match(lines.join('\n'), /stripe login/, name);
  }
});
