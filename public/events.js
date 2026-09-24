import { fetchJson, outcomeBadge } from './common.js';

const table = document.getElementById('events');
const tbody = table.querySelector('tbody');
const errorEl = document.getElementById('error');
const emptyEl = document.getElementById('empty');
const refreshButton = document.getElementById('refresh');
const updatedEl = document.getElementById('updated');

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

function cell(content) {
  const td = document.createElement('td');
  if (content instanceof Node) td.append(content);
  else td.textContent = content ?? '—';
  return td;
}

function renderRow(event) {
  const tr = document.createElement('tr');
  tr.append(
    cell(formatTime(event.receivedAt)),
    cell(event.type),
    cell(event.orderId ? link(`order.html?id=${encodeURIComponent(event.orderId)}`, event.orderId) : null),
    cell(outcomeBadge(event.outcome)),
    cell(event.detail),
    cell(link(event.dashboardUrl, event.stripeEventId, true)),
  );
  return tr;
}

async function load() {
  refreshButton.disabled = true;
  errorEl.hidden = true;
  try {
    const events = await fetchJson('api/events');
    tbody.replaceChildren(...events.map(renderRow));
    table.hidden = events.length === 0;
    emptyEl.hidden = events.length !== 0;
    updatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    errorEl.textContent = `Could not load events: ${err.message}`;
    errorEl.hidden = false;
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener('click', load);
load();
