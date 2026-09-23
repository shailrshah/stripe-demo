import express from 'express';
import type Stripe from 'stripe';
import { WebhookNotConfiguredError, WebhookSignatureError } from '../webhook-verifier.ts';
import type { Logger, Outcome, WebhookProcessor, WebhookVerifier } from '../types.ts';

export function createWebhookRouter({ verifier, processor, logger }: {
  verifier: WebhookVerifier; processor: WebhookProcessor; logger: Logger;
}): express.Router {
  const router = express.Router();

  // The signature covers the exact bytes Stripe sent, so this route must parse its own raw body.
  router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    let event: Stripe.Event;
    try {
      event = verifier.verify(req.body, req.get('stripe-signature'));
    } catch (err) {
      if (err instanceof WebhookNotConfiguredError) {
        return res.status(503).json({ error: { message: err.message } });
      }
      if (err instanceof WebhookSignatureError) {
        logger.warn(`Rejected webhook: ${err.message}`);
        return res.status(400).json({ error: { message: err.message } });
      }
      throw err;
    }

    let outcome: Outcome;
    try {
      outcome = processor.process(event);
    } catch (err) {
      logger.error(`Webhook processing failed for ${event.type} ${event.id}:`, err);
      return res.status(500).json({ error: { message: 'Webhook processing failed' } });
    }
    res.status(200).json({ received: true, outcome });
  });

  return router;
}
