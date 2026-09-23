import type { Gateway } from '../../src/types.ts';

export type GatewayMethod = keyof Gateway;
// A union keyed by method, so checking `call.method` narrows `call.args` to that method's argument.
export type FakeGatewayCall = { [M in GatewayMethod]: { method: M; args: Parameters<Gateway[M]>[0] } }[GatewayMethod];
export type FakeGatewayCallOf<M extends GatewayMethod> = Extract<FakeGatewayCall, { method: M }>;
export type FakeGateway = Gateway & { calls: FakeGatewayCall[]; failNext(method: GatewayMethod): void };

export function createFakeGateway(): FakeGateway {
  const calls: FakeGatewayCall[] = [];
  const failing = new Set<GatewayMethod>();
  const seq: Partial<Record<GatewayMethod, number>> = {};

  function record<M extends GatewayMethod>(method: M, args: Parameters<Gateway[M]>[0]): number {
    calls.push({ method, args } as FakeGatewayCall);
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
