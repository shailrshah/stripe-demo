export function createFakeGateway() {
  const calls = [];
  const failing = new Set();
  const seq = {};

  function record(method, args) {
    calls.push({ method, args });
    if (failing.delete(method)) throw new Error('fake gateway failure');
    seq[method] = (seq[method] ?? 0) + 1;
    return seq[method];
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
