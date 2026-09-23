import type { Gateway } from '../../src/types.ts';

export type GatewayMethod = keyof Gateway;
export interface FakeGatewayCall { method: GatewayMethod; args: unknown }
export type FakeGateway = Gateway & { calls: FakeGatewayCall[]; failNext(method: GatewayMethod): void };

export function createFakeGateway(): FakeGateway {
  const calls: FakeGatewayCall[] = [];
  const failing = new Set<GatewayMethod>();
  const seq: Partial<Record<GatewayMethod, number>> = {};

  function record(method: GatewayMethod, args: unknown): number {
    calls.push({ method, args });
    if (failing.delete(method)) throw new Error('fake gateway failure');
    const n = (seq[method] ?? 0) + 1;
    seq[method] = n;
    return n;
  }

  return {
    calls,
    failNext(method) {
      failing.add(method);
    },
    async createCheckoutSession(args) {
      const id = `cs_test_fake_${record('createCheckoutSession', args)}`;
      return { id, url: `https://checkout.stripe.test/c/pay/${id}` };
    },
    async expireCheckoutSession(sessionId) {
      record('expireCheckoutSession', sessionId);
    },
    async createPaymentIntent(args) {
      const id = `pi_test_fake_${record('createPaymentIntent', args)}`;
      return { id, clientSecret: `${id}_secret_x` };
    },
    async createRefund(args) {
      return { id: `re_test_fake_${record('createRefund', args)}` };
    },
  };
}
