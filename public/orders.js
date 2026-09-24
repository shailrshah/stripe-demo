import { fetchJson, statusBadge } from './common.js';

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30000;
const METHOD_LABELS = { checkout: 'Checkout', embedded: 'Embedded' };

const table = document.getElementById('orders');
const tbody = table.querySelector('tbody');
const errorEl = document.getElementById('error');
const emptyEl = document.getElementById('empty');

function cell(content) {
  const td = document.createElement('td');
  if (content instanceof Node) td.append(content);
  else td.textContent = content ?? '—';
  return td;
}

function link(href, text, external = false) {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  if (external) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  return a;
}

function formatTime(iso) {
  const time = document.createElement('time');
  time.dateTime = iso;
  time.title = iso;
  time.textContent = new Date(iso).toLocaleString();
  return time;
}

function renderRow(order) {
  const tr = document.createElement('tr');
  tr.dataset.orderId = order.id;
  fillRow(tr, order);
  return tr;
}

function idCell(id) {
  const td = cell(id);
  td.className = 'id-cell';
  if (id) td.title = id;
  return td;
}

function fillRow(tr, order) {
  const actions = document.createElement('td');
  actions.className = 'row-actions';
  if (order.dashboardUrl) actions.append(link(order.dashboardUrl, 'Dashboard', true));
  if (order.status === 'paid') actions.append(' ', refundButton(order, tr));

  tr.replaceChildren(
    cell(link(`order.html?id=${encodeURIComponent(order.id)}`, order.id)),
    cell(order.productName ?? order.productId),
    cell(order.price),
    cell(METHOD_LABELS[order.method] ?? order.method),
    cell(statusBadge(order.status)),
    idCell(order.stripePaymentIntentId ?? order.stripeCheckoutSessionId),
    cell(formatTime(order.createdAt)),
    actions,
  );
}

function refundButton(order, tr) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-sm';
  button.textContent = 'Refund';
  button.addEventListener('click', () => refund(order, tr, button));
  return button;
}

function showRowMessage(tr, text, isError) {
  const actions = tr.querySelector('.row-actions');
  let msg = actions.querySelector('.row-message');
  if (!msg) {
    msg = document.createElement('div');
    actions.append(msg);
  }
  msg.className = isError ? 'row-message error' : 'row-message';
  msg.textContent = text;
}

async function refund(order, tr, button) {
  button.disabled = true;
  showRowMessage(tr, 'Requesting refund…', false);
  try {
    await fetchJson(`api/orders/${encodeURIComponent(order.id)}/refund`, { method: 'POST' });
  } catch (err) {
    button.disabled = false;
    showRowMessage(tr, `Refund failed: ${err.message}`, true);
    return;
  }
  showRowMessage(tr, 'Refund requested. Waiting for the charge.refunded webhook…', false);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      const { order: latest } = await fetchJson(`api/orders/${encodeURIComponent(order.id)}`);
      if (latest.status !== order.status) {
        // The detail endpoint may not carry the list-only fields, so keep the ones we already have.
        fillRow(tr, { ...order, ...latest });
        return;
      }
    } catch (err) {
      showRowMessage(tr, `Could not check order status: ${err.message}`, true);
      return;
    }
  }
  showRowMessage(tr, 'Still paid after 30 s. Is stripe listen running? Reload to check again.', true);
}

async function load() {
  try {
    const orders = await fetchJson('api/orders');
    if (orders.length === 0) {
      emptyEl.hidden = false;
      return;
    }
    tbody.replaceChildren(...orders.map(renderRow));
    table.hidden = false;
  } catch (err) {
    errorEl.textContent = `Could not load orders: ${err.message}`;
    errorEl.hidden = false;
  }
}

load();
