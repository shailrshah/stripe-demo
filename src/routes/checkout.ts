import express from 'express';
import { getProduct } from '../catalog.ts';
import type { Config, Gateway, Logger, OrdersRepo } from '../types.ts';

export function createCheckoutRouter({ config, orders, gateway, logger, publicDir }: {
  config: Config; orders: OrdersRepo; gateway: Gateway; logger: Logger; publicDir: string;
}): express.Router {
  const router = express.Router();

  router.post('/checkout', async (req, res) => {
    const productId: unknown = req.body?.productId;
    const product = typeof productId === 'string' ? getProduct(productId) : undefined;
    if (!product) {
      return res.status(400).json({ error: { message: 'Unknown product' } });
    }

    const order = orders.create({ productId: product.id, amountCents: product.amountCents, method: 'checkout' });
    let session;
    try {
      session = await gateway.createCheckoutSession({
        orderId: order.id,
        product,
        successUrl: `${config.baseUrl}/success.html?order_id=${order.id}`,
        cancelUrl: `${config.baseUrl}/cancel?order_id=${order.id}`,
      });
    } catch (err) {
      logger.error(`Checkout Session creation failed for order ${order.id}: ${err instanceof Error ? err.message : String(err)}`);
      return res.status(502).json({ error: { message: 'Could not create Checkout Session' } });
    }

    orders.attachCheckoutSession(order.id, session.id);
    logger.info(`Order ${order.id} created with Checkout Session ${session.id}`);
    res.redirect(303, session.url);
  });

  router.get('/cancel', async (req, res) => {
    const orderId = req.query.order_id;
    // A repeated query key arrives as an array, which the repo can't bind.
    const order = typeof orderId === 'string' ? orders.get(orderId) : undefined;
    if (order?.status === 'pending' && order.stripeCheckoutSessionId) {
      try {
        await gateway.expireCheckoutSession(order.stripeCheckoutSessionId);
      } catch (err) {
        // The visitor must still see the cancel page; the session will expire on its own.
        logger.warn(`Could not expire Checkout Session for order ${order.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    res.sendFile('cancel.html', { root: publicDir });
  });

  return router;
}
