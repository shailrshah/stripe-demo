import type Stripe from 'stripe';
import type { OrderStatus } from './types.ts';

const ALLOWED: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['paid', 'failed', 'canceled'],
  failed: ['paid'],
  paid: ['refunded'],
  canceled: [],
  refunded: [],
};

// A frozen array rather than a Set: Object.freeze can't stop Set#add, so only an array is truly read-only.
export const HANDLED_TYPES: readonly Stripe.Event.Type[] = Object.freeze([
  'checkout.session.completed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'checkout.session.expired',
  'charge.refunded',
]);

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  // hasOwn keeps inherited keys like 'constructor' from being treated as statuses.
  return Object.hasOwn(ALLOWED, from) && ALLOWED[from].includes(to);
}

export function eventTarget(event: Stripe.Event): OrderStatus | null {
  switch (event.type) {
    case 'checkout.session.completed':
      return event.data.object.payment_status === 'paid' ? 'paid' : null;
    case 'payment_intent.succeeded':
      return 'paid';
    case 'payment_intent.payment_failed':
      return 'failed';
    case 'checkout.session.expired':
      return 'canceled';
    case 'charge.refunded':
      // A partial refund also sends charge.refunded, but the order isn't fully refunded yet.
      return event.data.object.refunded === true ? 'refunded' : null;
    default:
      return null;
  }
}

export type TransitionResult =
  | { kind: 'apply'; to: OrderStatus; detail: string }
  | { kind: 'ignore'; detail: string };

// The core business rule in one place: current status + a handled event → the next status, or why nothing changes.
// Pure: no database, no Stripe calls, so it can be read and tested on its own.
export function applyPaymentEvent(current: OrderStatus, event: Stripe.Event): TransitionResult {
  const target = eventTarget(event);
  if (target === null) return { kind: 'ignore', detail: 'no status change requested' };
  if (target === current) return { kind: 'ignore', detail: `already ${current}` };
  if (canTransition(current, target)) return { kind: 'apply', to: target, detail: `${current} → ${target}` };
  return { kind: 'ignore', detail: `${current} → ${target} not allowed` };
}
