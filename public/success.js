import { fetchJson, statusBadge } from './common.js';

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30_000;

const message = document.getElementById('message');
const orderSection = document.getElementById('order');
const hint = document.getElementById('hint');
const detailLink = document.getElementById('detail-link');

const orderId = new URLSearchParams(location.search).get('order_id');

function render(order) {
  document.getElementById('order-id').textContent = order.id;
  document.getElementById('product').textContent = order.productName;
  document.getElementById('price').textContent = order.price;
  document.getElementById('status').replaceChildren(statusBadge(order.status));
  orderSection.hidden = false;

  message.textContent = order.status === 'pending'
    ? 'Waiting for Stripe to confirm the payment via webhook…'
    : 'Stripe has reported the outcome via webhook.';
}

async function poll(startedAt) {
  let order;
  try {
    ({ order } = await fetchJson(`api/orders/${encodeURIComponent(orderId)}`));
  } catch (err) {
    if (err.status === 404) detailLink.hidden = true;
    message.textContent = err.status === 404
      ? `Order ${orderId} was not found.`
      : `Couldn't load the order: ${err.message}`;
    return;
  }

  render(order);

  if (order.status !== 'pending') return;
  if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
    hint.hidden = false;
    return;
  }
  setTimeout(() => poll(startedAt), POLL_INTERVAL_MS);
}

if (orderId) {
  detailLink.href = `order.html?id=${encodeURIComponent(orderId)}`;
  detailLink.hidden = false;
  poll(Date.now());
} else {
  message.textContent = 'No order_id in the URL, so there is no order to show. See the Orders page for all orders.';
}
