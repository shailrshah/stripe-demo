import { randomBytes } from 'node:crypto';

const COLUMNS = `
  id,
  product_id                 AS productId,
  amount_cents               AS amountCents,
  currency,
  method,
  status,
  stripe_checkout_session_id AS stripeCheckoutSessionId,
  stripe_payment_intent_id   AS stripePaymentIntentId,
  created_at                 AS createdAt,
  updated_at                 AS updatedAt
`;

const toOrder = (row) => (row ? { ...row } : undefined);

export function createOrdersRepo(db, { now = () => new Date() } = {}) {
  const insertStmt = db.prepare(
    `INSERT INTO orders (id, product_id, amount_cents, method, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const attachSessionStmt = db.prepare(
    `UPDATE orders SET stripe_checkout_session_id = ?, updated_at = ? WHERE id = ?`,
  );
  const attachPaymentIntentStmt = db.prepare(
    `UPDATE orders SET stripe_payment_intent_id = ?, updated_at = ?
     WHERE id = ? AND stripe_payment_intent_id IS NOT ?`,
  );
  const getStmt = db.prepare(`SELECT ${COLUMNS} FROM orders WHERE id = ?`);
  const bySessionStmt = db.prepare(
    `SELECT ${COLUMNS} FROM orders WHERE stripe_checkout_session_id = ?`,
  );
  const byPaymentIntentStmt = db.prepare(
    `SELECT ${COLUMNS} FROM orders WHERE stripe_payment_intent_id = ?`,
  );
  // rowid breaks ties between orders created within the same millisecond.
  const listStmt = db.prepare(`SELECT ${COLUMNS} FROM orders ORDER BY created_at DESC, rowid DESC`);
  const setStatusStmt = db.prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ?`);

  const timestamp = () => now().toISOString();

  return {
    create({ productId, amountCents, method }) {
      const id = `ord_${randomBytes(8).toString('hex')}`;
      const ts = timestamp();
      insertStmt.run(id, productId, amountCents, method, ts, ts);
      return toOrder(getStmt.get(id));
    },

    attachCheckoutSession(orderId, sessionId) {
      attachSessionStmt.run(sessionId, timestamp(), orderId);
    },

    attachPaymentIntent(orderId, paymentIntentId) {
      attachPaymentIntentStmt.run(paymentIntentId, timestamp(), orderId, paymentIntentId);
    },

    get(orderId) {
      return toOrder(getStmt.get(orderId));
    },

    findByCheckoutSession(sessionId) {
      return toOrder(bySessionStmt.get(sessionId));
    },

    findByPaymentIntent(paymentIntentId) {
      return toOrder(byPaymentIntentStmt.get(paymentIntentId));
    },

    list() {
      return listStmt.all().map(toOrder);
    },

    setStatus(orderId, status) {
      setStatusStmt.run(status, timestamp(), orderId);
    },
  };
}
