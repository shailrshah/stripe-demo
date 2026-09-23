import { HANDLED_TYPES, canTransition, eventTarget } from './transitions.js';

export function createWebhookProcessor({ db, orders, eventLog, logger }) {
  function resolveOrder(object) {
    const metadataOrderId = object.metadata?.order_id;
    if (metadataOrderId) {
      const order = orders.get(metadataOrderId);
      if (order) return order;
    }
    switch (object.object) {
      case 'checkout.session':
        return orders.findByCheckoutSession(object.id);
      case 'payment_intent':
        return orders.findByPaymentIntent(object.id);
      case 'charge':
        return object.payment_intent ? orders.findByPaymentIntent(object.payment_intent) : undefined;
      default:
        return undefined;
    }
  }

  function decide(event, order) {
    if (eventLog.isProcessed(event.id)) return { outcome: 'ignored_duplicate', detail: null };
    if (!HANDLED_TYPES.includes(event.type)) return { outcome: 'ignored_unhandled_type', detail: null };
    if (!order) return { outcome: 'ignored_unknown_order', detail: null };

    const object = event.data.object;
    if (
      event.type === 'checkout.session.completed' &&
      object.payment_intent &&
      !order.stripePaymentIntentId
    ) {
      orders.attachPaymentIntent(order.id, object.payment_intent);
    }

    const from = order.status;
    const target = eventTarget(event);
    if (target === null) return { outcome: 'ignored_transition', detail: 'no status change requested' };
    if (target === from) return { outcome: 'ignored_transition', detail: `already ${from}` };
    if (canTransition(from, target)) {
      orders.setStatus(order.id, target);
      return { outcome: 'applied', detail: `${from} → ${target}` };
    }
    return { outcome: 'ignored_transition', detail: `${from} → ${target} not allowed` };
  }

  return {
    process(event) {
      let outcome;
      let detail;
      db.exec('BEGIN IMMEDIATE');
      try {
        const order = resolveOrder(event.data.object) ?? null;
        ({ outcome, detail } = decide(event, order));
        if (outcome !== 'ignored_duplicate') eventLog.markProcessed(event.id);
        eventLog.append({ event, orderId: order?.id ?? null, outcome, detail });
        db.exec('COMMIT');
      } catch (err) {
        // Some SQLite errors already roll the transaction back; a second ROLLBACK would throw and mask err.
        if (db.isTransaction) db.exec('ROLLBACK');
        throw err;
      }
      logger.info(
        `webhook ${event.type} ${event.id}: ${outcome}${detail ? ` (${detail})` : ''}`,
      );
      return outcome;
    },
  };
}
