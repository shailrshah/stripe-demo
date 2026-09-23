import Stripe from 'stripe';

export function createStripeGateway(secretKey, { client } = {}) {
  const stripe = client ?? new Stripe(secretKey);

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
