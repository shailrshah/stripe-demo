import type { Product } from './types.ts';

// Frozen so no caller can change a price at runtime: the server is authoritative (R1.3).
export const PRODUCTS: readonly Readonly<Product>[] = Object.freeze(
  [
    { id: 'duck', name: 'Rubber Duck', description: 'For debugging conversations.', amountCents: 500 },
    { id: 'beans', name: 'Coffee Beans (1 lb)', description: 'Fuel for late-night deploys.', amountCents: 1250 },
    { id: 'keyboard', name: 'Mechanical Keyboard', description: 'Clicky. Very clicky.', amountCents: 8900 },
  ].map((p) => Object.freeze(p)),
);

// Callers pass untrusted request input, so any value must safely miss.
export function getProduct(id: unknown): Readonly<Product> | undefined {
  return PRODUCTS.find((p) => p.id === id);
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
