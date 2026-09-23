import type { DatabaseSync } from 'node:sqlite';
import type Stripe from 'stripe';
import { HANDLED_TYPES, canTransition, eventTarget } from './transitions.ts';
import type { EventLog, Logger, Order, OrdersRepo, Outcome, WebhookProcessor } from './types.ts';

type StripeObjectRef = {
  object: string;
  id: string;
  metadata?: Record<string, string> | null;
  payment_intent?: string | { id: string } | null;
};

// Stripe types payment_intent as expandable; webhooks send the ID, but accept the expanded object too.
function paymentIntentId(value: string | { id: string } | null | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.id;
}

export function createWebhookProcessor({ db, orders, eventLog, logger }: {
  db: DatabaseSync;
  orders: OrdersRepo;
  eventLog: EventLog;
  logger: Logger;
}): WebhookProcessor {
  // Widened so includes() accepts any event type, however narrowly HANDLED_TYPES is typed.
  const handledTypes: readonly string[] = HANDLED_TYPES;

  function resolveOrder(event: Stripe.Event): Order | undefined {
    const object = event.data.object as StripeObjectRef;
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
      case 'charge': {
        const piId = paymentIntentId(object.payment_intent);
        return piId ? orders.findByPaymentIntent(piId) : undefined;
      }
      default:
        return undefined;
    }
  }

  function decide(event: Stripe.Event, order: Order | null): { outcome: Outcome; detail: string | null } {
    if (eventLog.isProcessed(event.id)) return { outcome: 'ignored_duplicate', detail: null };
    if (!handledTypes.includes(event.type)) return { outcome: 'ignored_unhandled_type', detail: null };
    if (!order) return { outcome: 'ignored_unknown_order', detail: null };

    if (event.type === 'checkout.session.completed') {
      const piId = paymentIntentId(event.data.object.payment_intent);
      if (piId && !order.stripePaymentIntentId) orders.attachPaymentIntent(order.id, piId);
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
      let outcome: Outcome;
      let detail: string | null;
      db.exec('BEGIN IMMEDIATE');
      try {
        const order = resolveOrder(event) ?? null;
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
