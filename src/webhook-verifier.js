import Stripe from 'stripe';

export class WebhookSignatureError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'WebhookSignatureError';
  }
}

export class WebhookNotConfiguredError extends Error {
  constructor(message = 'Webhook signing secret is not configured', options) {
    super(message, options);
    this.name = 'WebhookNotConfiguredError';
  }
}

export function createWebhookVerifier(secret) {
  return {
    // Throws per call rather than at construction so the server can still start without a secret (R7.3).
    verify(rawBody, signatureHeader) {
      if (secret == null) throw new WebhookNotConfiguredError();
      try {
        return Stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
      } catch (err) {
        throw new WebhookSignatureError('Invalid webhook signature', { cause: err });
      }
    },
  };
}
