import type { Product } from './types.ts';

// Hotlinked from Unsplash's CDN (free to use, no attribution required); the query string crops to 600x400.
const unsplash = (photo: string) =>
  `https://images.unsplash.com/${photo}?w=600&h=400&fit=crop&q=70&auto=format`;

// Frozen so no caller can change a price at runtime: the server is authoritative (R1.3).
export const PRODUCTS: readonly Readonly<Product>[] = Object.freeze(
  [
    {
      id: 'duck', name: 'Rubber Duck', description: 'For debugging conversations.', amountCents: 500,
      imageUrl: unsplash('photo-1616706723013-6033a1f6c008'),
    },
    {
      id: 'beans', name: 'Coffee Beans (1 lb)', description: 'Fuel for late-night deploys.', amountCents: 1250,
      imageUrl: unsplash('photo-1447933601403-0c6688de566e'),
    },
    {
      id: 'keyboard', name: 'Mechanical Keyboard', description: 'Clicky. Very clicky.', amountCents: 8900,
      imageUrl: unsplash('photo-1562819606-b7a0ebd7e7c5'),
    },
  ].map((p) => Object.freeze(p)),
);

// Callers pass untrusted request input, so any value must safely miss.
export function getProduct(id: unknown): Readonly<Product> | undefined {
  return PRODUCTS.find((p) => p.id === id);
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
