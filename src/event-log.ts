const COLUMNS = `id, stripe_event_id, type, stripe_created_at, received_at, order_id, outcome, detail`;

function toEntry(row) {
  return {
    id: row.id,
    stripeEventId: row.stripe_event_id,
    type: row.type,
    stripeCreatedAt: row.stripe_created_at,
    receivedAt: row.received_at,
    orderId: row.order_id,
    outcome: row.outcome,
    detail: row.detail,
  };
}

export function createEventLog(db, { now = () => new Date() } = {}) {
  const selectProcessed = db.prepare('SELECT 1 FROM processed_events WHERE stripe_event_id = ?');
  const insertProcessed = db.prepare(
    'INSERT INTO processed_events (stripe_event_id, processed_at) VALUES (?, ?)',
  );
  const insertEntry = db.prepare(
    `INSERT INTO webhook_events
       (stripe_event_id, type, stripe_created_at, received_at, order_id, outcome, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // Ordering by the autoincrement id keeps insertion order even when received_at ties.
  const selectRecent = db.prepare(`SELECT ${COLUMNS} FROM webhook_events ORDER BY id DESC LIMIT ?`);
  const selectForOrder = db.prepare(
    `SELECT ${COLUMNS} FROM webhook_events WHERE order_id = ? ORDER BY id ASC`,
  );

  return {
    isProcessed(stripeEventId) {
      return selectProcessed.get(stripeEventId) !== undefined;
    },

    markProcessed(stripeEventId) {
      insertProcessed.run(stripeEventId, now().toISOString());
    },

    append({ event, orderId = null, outcome, detail = null }) {
      insertEntry.run(
        event.id,
        event.type,
        new Date(event.created * 1000).toISOString(),
        now().toISOString(),
        orderId,
        outcome,
        detail,
      );
    },

    list({ limit = 200 } = {}) {
      return selectRecent.all(limit).map(toEntry);
    },

    listForOrder(orderId) {
      return selectForOrder.all(orderId).map(toEntry);
    },
  };
}
