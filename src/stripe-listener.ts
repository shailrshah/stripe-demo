import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Logger } from './types.ts';

export interface StripeListener {
  secret: string;
  stop(): void;
}

const redact = (line: string) => line.replace(/whsec_[A-Za-z0-9]+/g, 'whsec_…');

// Runs `stripe listen` as a child of the server so webhooks work from a single `npm start` (R8.5).
export function startStripeListener({ port, logger, command = 'stripe' }: {
  port: number;
  logger: Logger;
  command?: string;
}): StripeListener | null {
  const printed = spawnSync(command, ['listen', '--print-secret'], { encoding: 'utf8', timeout: 30_000 });
  if ((printed.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    logger.warn('Stripe CLI not found, so stripe listen was not started. Install it: brew install stripe/stripe-cli/stripe');
    return null;
  }
  const secret = (printed.stdout ?? '').trim();
  if (printed.status !== 0 || !/^whsec_[A-Za-z0-9]+$/.test(secret)) {
    logger.warn('Could not get a webhook secret from the Stripe CLI (try `stripe login`), so stripe listen was not started.');
    return null;
  }

  const child = spawn(command, ['listen', '--all-snapshot', '--forward-to', `127.0.0.1:${port}/webhook`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      if (line.trim()) logger.info(`[stripe] ${redact(line)}`);
    });
  }

  let stopping = false;
  child.on('exit', (code, signal) => {
    if (stopping) return;
    logger.warn(
      `\n!!! stripe listen exited (${signal ?? `code ${code}`}). Webhooks will NOT arrive, so orders will stay pending.\n` +
        '!!! Restart npm start, or run: stripe listen --all-snapshot --forward-to ' +
        `127.0.0.1:${port}/webhook\n`,
    );
  });

  return {
    secret,
    stop() {
      if (stopping) return;
      stopping = true;
      child.kill();
    },
  };
}
