import { fetchJson, statusBadge, outcomeBadge } from './common.js';

const METHOD_LABELS = { checkout: 'Checkout', embedded: 'Embedded' };

const titleEl = document.getElementById('title');
const errorEl = document.getElementById('error');
const detailsEl = document.getElementById('details');
const fieldsEl = document.getElementById('fields');
const eventsTable = document.getElementById('events');
const noEventsEl = document.getElementById('no-events');

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

function formatAmount(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function cell(content) {
  const td = document.createElement('td');
  if (content instanceof Node) td.append(content);
  else td.textContent = content ?? '—';
  return td;
}

function addField(label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  if (value instanceof Node) dd.append(value);
  else dd.textContent = value ?? '—';
  fieldsEl.append(dt, dd);
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function renderOrder(order) {
  titleEl.textContent = `Order ${order.id}`;
  addField('ID', order.id);
  addField('Product', order.productName ?? order.productId);
  addField('Amount', order.price ?? formatAmount(order.amountCents));
  addField('Method', METHOD_LABELS[order.method] ?? order.method);
  addField('Status', statusBadge(order.status));
  addField('Checkout Session', order.stripeCheckoutSessionId);
  addField('PaymentIntent', order.stripePaymentIntentId);
  addField('Created', formatTime(order.createdAt));
  addField('Updated', formatTime(order.updatedAt));
  if (order.dashboardUrl) addField('Stripe Dashboard', link(order.dashboardUrl, 'Open in Dashboard', true));
}

function renderEvent(event) {
  const tr = document.createElement('tr');
  // §10 only promises dashboardUrl on /api/events rows, so build it here if the detail endpoint omits it.
  const dashboardUrl = event.dashboardUrl
    ?? `https://dashboard.stripe.com/test/events/${encodeURIComponent(event.stripeEventId)}`;
  tr.append(
    cell(formatTime(event.receivedAt)),
    cell(event.type),
    cell(outcomeBadge(event.outcome)),
    cell(event.detail),
    cell(formatTime(event.stripeCreatedAt)),
    cell(link(dashboardUrl, event.stripeEventId, true)),
  );
  return tr;
}

async function load() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    showError('No order ID given. Open an order from the orders page.');
    return;
  }
  try {
    const { order, events } = await fetchJson(`/api/orders/${encodeURIComponent(id)}`);
    renderOrder(order);
    if (events.length === 0) {
      noEventsEl.hidden = false;
    } else {
      eventsTable.querySelector('tbody').replaceChildren(...events.map(renderEvent));
      eventsTable.hidden = false;
    }
    detailsEl.hidden = false;
  } catch (err) {
    if (err.status === 404) showError(`Order ${id} was not found.`);
    else showError(`Could not load the order: ${err.message}`);
  }
}

load();
