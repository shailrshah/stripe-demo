import Stripe from 'stripe';
import type { WebhookVerifier } from './types.ts';

export class WebhookSignatureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WebhookSignatureError';
  }
}

export class WebhookNotConfiguredError extends Error {
  constructor(message = 'Webhook signing secret is not configured', options?: ErrorOptions) {
    super(message, options);
    this.name = 'WebhookNotConfiguredError';
  }
}

export function createWebhookVerifier(secret: string | null): WebhookVerifier {
  return {
    // Throws per call rather than at construction so the server can still start without a secret (R7.3).
    verify(rawBody, signatureHeader) {
      if (secret == null) throw new WebhookNotConfiguredError();
      try {
        // Stripe's types reject undefined, but it rejects '' with the same "no header" error at runtime.
        return Stripe.webhooks.constructEvent(rawBody, signatureHeader ?? '', secret);
      } catch (err) {
        throw new WebhookSignatureError('Invalid webhook signature', { cause: err });
      }
    },
  };
}
