import { fetchJson } from './common.js';

const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('product-summary');
const form = document.getElementById('payment-form');
const errorEl = document.getElementById('payment-error');
const button = document.getElementById('submit');

function showStatus(message) {
  statusEl.textContent = message;
  statusEl.hidden = false;
}

async function init() {
  const productId = new URLSearchParams(location.search).get('product');
  if (!productId) {
    showStatus('No product selected. Pick one from the shop.');
    return;
  }
  if (typeof Stripe !== 'function') {
    showStatus('Stripe.js failed to load. Check your network connection and reload.');
    return;
  }

  let publishableKey, products, orderId, clientSecret;
  try {
    [{ publishableKey }, products] = await Promise.all([
      fetchJson('/api/config'),
      fetchJson('/api/products'),
    ]);
    ({ orderId, clientSecret } = await fetchJson('/api/payment-intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId }),
    }));
  } catch (err) {
    showStatus(err.status === 400
      ? `That product isn't available (${err.message}). Pick one from the shop.`
      : `Couldn't start the payment: ${err.message}`);
    return;
  }

  const product = products.find((p) => p.id === productId);
  if (product) summaryEl.textContent = `${product.name}: ${product.price}`;

  const stripe = Stripe(publishableKey);
  const elements = stripe.elements({ clientSecret });
  const paymentElement = elements.create('payment');
  paymentElement.mount('#payment-element');

  const successUrl = new URL(`/success.html?order_id=${encodeURIComponent(orderId)}`, location.origin).href;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    errorEl.textContent = '';

    // Card details go straight from the Payment Element to Stripe; this page never sees them (C3).
    const { error } = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
      confirmParams: { return_url: successUrl },
    });

    if (error) {
      errorEl.textContent = error.message;
      button.disabled = false;
      return;
    }
    location.assign(successUrl);
  });

  statusEl.hidden = true;
  form.hidden = false;
  button.disabled = false;
}

init();
