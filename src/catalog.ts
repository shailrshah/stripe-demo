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
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const DONATION_ID = 'donation';
export const DONATION_MIN_CENTS = 100;
export const DONATION_MAX_CENTS = 100_000;
const DONATION_IMAGE = unsplash('photo-1768179123206-6527be13f07e');

// String arithmetic, not parseFloat: 19.99 * 100 is 1998.9999999999998 in floating point.
export function parseDollars(input: unknown): number | null {
  if (typeof input !== 'string') return null;
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

// The one place a request becomes something payable. Only donations take an amount from the browser (R10).
export function resolveItem(body: { productId?: unknown; amount?: unknown }):
  { item: Readonly<Product> } | { error: string } {
  if (body.productId !== DONATION_ID) {
    const product = getProduct(body.productId);
    return product ? { item: product } : { error: 'Unknown product' };
  }
  const amountCents = parseDollars(body.amount);
  if (amountCents === null || amountCents < DONATION_MIN_CENTS || amountCents > DONATION_MAX_CENTS) {
    return {
      error: `Donation amount must be between ${formatPrice(DONATION_MIN_CENTS)} and ${formatPrice(DONATION_MAX_CENTS)}`,
    };
  }
  return {
    item: {
      id: DONATION_ID,
      name: 'Donation',
      description: 'Thank you for supporting the Stripe Demo Shop.',
      amountCents,
      imageUrl: DONATION_IMAGE,
    },
  };
}

export function itemName(productId: string): string | null {
  return productId === DONATION_ID ? 'Donation' : getProduct(productId)?.name ?? null;
}
