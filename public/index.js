import { fetchJson } from './common.js';

const list = document.getElementById('products');
const message = document.getElementById('message');

try {
  const products = await fetchJson('/api/products');
  list.replaceChildren(...products.map(productCard));
  message.hidden = true;
} catch (err) {
  message.textContent = `Could not load products: ${err.message}`;
  message.className = 'error';
}

function productCard(product) {
  const card = document.createElement('li');
  card.className = 'card';

  const name = document.createElement('h2');
  name.textContent = product.name;

  const description = document.createElement('p');
  description.className = 'muted';
  description.textContent = product.description;

  const price = document.createElement('p');
  price.className = 'price';
  price.textContent = product.price;

  const form = document.createElement('form');
  form.method = 'post';
  form.action = '/checkout';

  const productId = document.createElement('input');
  productId.type = 'hidden';
  productId.name = 'productId';
  productId.value = product.id;

  const buy = document.createElement('button');
  buy.type = 'submit';
  buy.className = 'btn btn-primary';
  buy.textContent = 'Buy with Checkout';

  form.append(productId, buy);

  const embedded = document.createElement('a');
  embedded.className = 'btn';
  embedded.href = `/pay.html?product=${encodeURIComponent(product.id)}`;
  embedded.textContent = 'Buy with embedded form';

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(form, embedded);

  card.append(name, description, price, actions);
  return card;
}
