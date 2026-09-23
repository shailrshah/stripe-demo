import express from 'express';
import type { Response } from 'express';
import { PRODUCTS, formatPrice, itemName, resolveItem } from '../catalog.ts';
import type { Config, EventLog, EventLogRow, Gateway, Logger, Order, OrdersRepo } from '../types.ts';

export interface ApiOrder extends Order { productName: string | null; price: string; dashboardUrl: string | null }
export interface ApiEvent extends EventLogRow { dashboardUrl: string }

const DASHBOARD = 'https://dashboard.stripe.com/test';

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { message } });
}

function orderDashboardUrl(order: Order): string | null {
  if (order.stripePaymentIntentId) return `${DASHBOARD}/payments/${order.stripePaymentIntentId}`;
  if (order.stripeCheckoutSessionId) return `${DASHBOARD}/checkout/sessions/${order.stripeCheckoutSessionId}`;
  return null;
}

function enrichOrder(order: Order): ApiOrder {
  return {
    ...order,
    productName: itemName(order.productId),
    price: formatPrice(order.amountCents),
    dashboardUrl: orderDashboardUrl(order),
  };
}

function enrichEvent(entry: EventLogRow): ApiEvent {
  return { ...entry, dashboardUrl: `${DASHBOARD}/events/${entry.stripeEventId}` };
}

export function createApiRouter({ config, orders, eventLog, gateway, logger }: {
  config: Config; orders: OrdersRepo; eventLog: EventLog; gateway: Gateway; logger: Logger;
}): express.Router {
  const router = express.Router();

  router.get('/config', (req, res) => {
    res.json({ publishableKey: config.stripePublishableKey });
  });

  router.get('/products', (req, res) => {
    res.json(PRODUCTS.map((p) => ({ ...p, price: formatPrice(p.amountCents) })));
  });

  router.post('/payment-intents', async (req, res) => {
    // Catalog products ignore any amount the browser sends (R1.3); only donations read it (R10).
    const resolved = resolveItem({ productId: req.body?.productId, amount: req.body?.amount });
    if ('error' in resolved) return sendError(res, 400, resolved.error);
    const product = resolved.item;

    const order = orders.create({ productId: product.id, amountCents: product.amountCents, method: 'embedded' });
    let intent;
    try {
      intent = await gateway.createPaymentIntent({ orderId: order.id, product });
    } catch (err) {
      logger.error(`Creating PaymentIntent for order ${order.id} failed: ${err instanceof Error ? err.message : String(err)}`);
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
      logger.error(`Refund for order ${order.id} failed: ${err instanceof Error ? err.message : String(err)}`);
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
