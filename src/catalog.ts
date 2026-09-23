// Frozen so no caller can change a price at runtime: the server is authoritative (R1.3).
export const PRODUCTS = Object.freeze(
  [
    { id: 'duck', name: 'Rubber Duck', description: 'For debugging conversations.', amountCents: 500 },
    { id: 'beans', name: 'Coffee Beans (1 lb)', description: 'Fuel for late-night deploys.', amountCents: 1250 },
    { id: 'keyboard', name: 'Mechanical Keyboard', description: 'Clicky. Very clicky.', amountCents: 8900 },
  ].map((p) => Object.freeze(p)),
);

export function getProduct(id) {
  return PRODUCTS.find((p) => p.id === id);
}

export function formatPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
