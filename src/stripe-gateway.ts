import Stripe from 'stripe';
import type { Gateway } from './types.ts';

// Only the slice of the Stripe client the gateway calls, so tests can pass a small fake.
interface StripeClient {
  checkout: {
    sessions: {
      create(params: Stripe.Checkout.SessionCreateParams): Promise<{ id: string; url: string | null }>;
      expire(sessionId: string): Promise<unknown>;
    };
  };
  paymentIntents: {
    create(params: Stripe.PaymentIntentCreateParams): Promise<{ id: string; client_secret: string | null }>;
  };
  refunds: {
    create(params: Stripe.RefundCreateParams): Promise<{ id: string }>;
  };
}

export function createStripeGateway(secretKey: string, { client }: { client?: StripeClient } = {}): Gateway {
  const stripe: StripeClient = client ?? new Stripe(secretKey);

  return {
    async createCheckoutSession({ orderId, product, successUrl, cancelUrl }) {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: product.amountCents,
              product_data: { name: product.name, description: product.description },
            },
          },
        ],
        metadata: { order_id: orderId },
        payment_intent_data: { metadata: { order_id: orderId } },
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
      if (session.url === null) throw new Error(`Checkout Session ${session.id} has no url`);
      return { id: session.id, url: session.url };
    },

    async expireCheckoutSession(sessionId) {
      await stripe.checkout.sessions.expire(sessionId);
    },

    async createPaymentIntent({ orderId, product }) {
      const intent = await stripe.paymentIntents.create({
        amount: product.amountCents,
        currency: 'usd',
        metadata: { order_id: orderId },
        automatic_payment_methods: { enabled: true },
      });
      if (intent.client_secret === null) throw new Error(`PaymentIntent ${intent.id} has no client_secret`);
      return { id: intent.id, clientSecret: intent.client_secret };
    },

    async createRefund({ paymentIntentId, orderId }) {
      const refund = await stripe.refunds.create({
        payment_intent: paymentIntentId,
        metadata: { order_id: orderId },
      });
      return { id: refund.id };
    },
  };
}
