import express from 'express';
import { PRODUCTS, getProduct, formatPrice } from '../catalog.js';

const DASHBOARD = 'https://dashboard.stripe.com/test';

function sendError(res, status, message) {
  res.status(status).json({ error: { message } });
}

function orderDashboardUrl(order) {
  if (order.stripePaymentIntentId) return `${DASHBOARD}/payments/${order.stripePaymentIntentId}`;
  if (order.stripeCheckoutSessionId) return `${DASHBOARD}/checkout/sessions/${order.stripeCheckoutSessionId}`;
  return null;
}

function enrichOrder(order) {
  return {
    ...order,
    productName: getProduct(order.productId)?.name ?? null,
    price: formatPrice(order.amountCents),
    dashboardUrl: orderDashboardUrl(order),
  };
}

function enrichEvent(entry) {
  return { ...entry, dashboardUrl: `${DASHBOARD}/events/${entry.stripeEventId}` };
}

export function createApiRouter({ config, orders, eventLog, gateway, logger }) {
  const router = express.Router();

  router.get('/config', (req, res) => {
    res.json({ publishableKey: config.stripePublishableKey });
  });

  router.get('/products', (req, res) => {
    res.json(PRODUCTS.map((p) => ({ ...p, price: formatPrice(p.amountCents) })));
  });

  router.post('/payment-intents', async (req, res) => {
    // Only productId is read: any amount the browser sends is ignored (R1.3).
    const product = getProduct(req.body?.productId);
    if (!product) return sendError(res, 400, 'Unknown product');

    const order = orders.create({ productId: product.id, amountCents: product.amountCents, method: 'embedded' });
    let intent;
    try {
      intent = await gateway.createPaymentIntent({ orderId: order.id, product });
    } catch (err) {
      logger.error(`Creating PaymentIntent for order ${order.id} failed: ${err.message}`);
      return sendError(res, 502, 'Could not create the payment with Stripe');
    }
    orders.attachPaymentIntent(order.id, intent.id);
    logger.info(`Order ${order.id} created with PaymentIntent ${intent.id}`);
    res.status(201).json({ orderId: order.id, clientSecret: intent.clientSecret });
  });

  router.get('/orders', (req, res) => {
    res.json(orders.list().map(enrichOrder));
  });

  router.get('/orders/:id', (req, res) => {
    const order = orders.get(req.params.id);
    if (!order) return sendError(res, 404, 'Order not found');
    res.json({ order: enrichOrder(order), events: eventLog.listForOrder(order.id).map(enrichEvent) });
  });

  router.post('/orders/:id/refund', async (req, res) => {
    const order = orders.get(req.params.id);
    if (!order) return sendError(res, 404, 'Order not found');
    if (order.status !== 'paid' || !order.stripePaymentIntentId) {
      return sendError(res, 409, 'Only paid orders with a PaymentIntent can be refunded');
    }

    let refund;
    try {
      refund = await gateway.createRefund({ paymentIntentId: order.stripePaymentIntentId, orderId: order.id });
    } catch (err) {
      logger.error(`Refund for order ${order.id} failed: ${err.message}`);
      return sendError(res, 502, 'Could not create the refund with Stripe');
    }
    // Status stays 'paid' until the charge.refunded webhook arrives (R6.2).
    logger.info(`Refund ${refund.id} requested for order ${order.id}`);
    res.status(202).json({ refundId: refund.id });
  });

  router.get('/events', (req, res) => {
    res.json(eventLog.list().map(enrichEvent));
  });

  return router;
}
