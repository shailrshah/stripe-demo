import { fetchJson } from './common.js';

const orderId = new URLSearchParams(location.search).get('order_id');
const statusEl = document.getElementById('cancel-status');

function show(message) {
  statusEl.textContent = message;
  statusEl.hidden = false;
}

// Expiring the session is a POST from here, not a side effect of loading the page (see GET /cancel).
if (orderId) {
  fetchJson(`api/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' })
    .then(() => show('Asked Stripe to expire the Checkout Session.'))
    .catch((err) => {
      // 409: already canceled or paid, e.g. on a reload. Nothing to tell the visitor.
      if (err.status !== 409) show(`Couldn't expire the session right now (${err.message}). Stripe expires it on its own after 24 hours.`);
    });
}
