import type Stripe from 'stripe';

export type OrderStatus = 'pending' | 'paid' | 'failed' | 'canceled' | 'refunded';
export type PaymentMethodKind = 'checkout' | 'embedded';
export type Outcome =
  | 'applied' | 'ignored_duplicate' | 'ignored_transition'
  | 'ignored_unknown_order' | 'ignored_unhandled_type';

export interface Product { id: string; name: string; description: string; amountCents: number; imageUrl: string }

export interface Order {
  id: string; productId: string; amountCents: number; currency: string;
  method: PaymentMethodKind; status: OrderStatus;
  stripeCheckoutSessionId: string | null; stripePaymentIntentId: string | null;
  createdAt: string; updatedAt: string;
}

export interface EventLogRow {
  id: number; stripeEventId: string; type: string; stripeCreatedAt: string; receivedAt: string;
  orderId: string | null; outcome: Outcome; detail: string | null;
}

export interface Config {
  stripeSecretKey: string; stripePublishableKey: string; webhookSecret: string | null;
  port: number; databasePath: string; baseUrl: string;
}

export interface Logger {
  info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void;
}

export interface Gateway {
  createCheckoutSession(args: { orderId: string; product: Product; successUrl: string; cancelUrl: string }):
    Promise<{ id: string; url: string }>;
  expireCheckoutSession(sessionId: string): Promise<void>;
  createPaymentIntent(args: { orderId: string; product: Product }): Promise<{ id: string; clientSecret: string }>;
  createRefund(args: { paymentIntentId: string; orderId: string }): Promise<{ id: string }>;
}

export interface OrdersRepo {
  create(args: { productId: string; amountCents: number; method: PaymentMethodKind }): Order;
  attachCheckoutSession(orderId: string, sessionId: string): void;
  attachPaymentIntent(orderId: string, paymentIntentId: string): void;
  get(orderId: string): Order | undefined;
  findByCheckoutSession(sessionId: string): Order | undefined;
  findByPaymentIntent(paymentIntentId: string): Order | undefined;
  list(): Order[];
  setStatus(orderId: string, status: OrderStatus): void;
}

export interface EventLog {
  isProcessed(stripeEventId: string): boolean;
  markProcessed(stripeEventId: string): void;
  append(args: { event: Stripe.Event; orderId: string | null; outcome: Outcome; detail?: string | null }): void;
  list(options?: { limit?: number }): EventLogRow[];
  listForOrder(orderId: string): EventLogRow[];
}

export interface WebhookVerifier { verify(rawBody: Buffer, signatureHeader: string | undefined): Stripe.Event }
export interface WebhookProcessor { process(event: Stripe.Event): Outcome }
