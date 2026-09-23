const form = document.getElementById('donate-form');
const amountInput = document.getElementById('amount');
const presets = document.querySelectorAll('[data-amount]');

function markPreset() {
  for (const button of presets) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.amount) === Number(amountInput.value)));
  }
}

for (const button of presets) {
  button.addEventListener('click', () => {
    amountInput.value = button.dataset.amount;
    markPreset();
  });
}
amountInput.addEventListener('input', markPreset);

// The Checkout button submits the form natively; this one reuses the same validation, then goes to the embedded form.
document.getElementById('embedded').addEventListener('click', () => {
  if (!form.reportValidity()) return;
  const params = new URLSearchParams({ product: 'donation', amount: amountInput.value });
  location.assign(`/pay.html?${params}`);
});

markPreset();
