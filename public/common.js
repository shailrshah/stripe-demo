export async function fetchJson(url, opts = {}) {
  const init = { ...opts, headers: { Accept: 'application/json', ...opts.headers } };
  // Let callers pass a plain object as the body, the way the API expects JSON.
  if (isPlainObject(init.body)) {
    init.body = JSON.stringify(init.body);
    init.headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, init);
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `Request failed (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function badge(value) {
  const el = document.createElement('span');
  el.className = `badge badge-${value}`;
  el.textContent = value;
  return el;
}

export function statusBadge(status) {
  return badge(status);
}

export function outcomeBadge(outcome) {
  return badge(outcome);
}
