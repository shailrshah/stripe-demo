const ALLOWED = {
  pending: ['paid', 'failed', 'canceled'],
  failed: ['paid'],
  paid: ['refunded'],
  canceled: [],
  refunded: [],
};

// A frozen array rather than a Set: Object.freeze can't stop Set#add, so only an array is truly read-only.
export const HANDLED_TYPES = Object.freeze([
  'checkout.session.completed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'checkout.session.expired',
  'charge.refunded',
]);

export function canTransition(from, to) {
  // hasOwn keeps inherited keys like 'constructor' from being treated as statuses.
  return Object.hasOwn(ALLOWED, from) && ALLOWED[from].includes(to);
}

export function eventTarget(event) {
  const object = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
      return object.payment_status === 'paid' ? 'paid' : null;
    case 'payment_intent.succeeded':
      return 'paid';
    case 'payment_intent.payment_failed':
      return 'failed';
    case 'checkout.session.expired':
      return 'canceled';
    case 'charge.refunded':
      // A partial refund also sends charge.refunded, but the order isn't fully refunded yet.
      return object.refunded === true ? 'refunded' : null;
    default:
      return null;
  }
}
