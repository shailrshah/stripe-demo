import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTS, getProduct, formatPrice } from '../src/catalog.ts';

test('getProduct returns the product for known IDs', () => {
  for (const p of PRODUCTS) {
    assert.equal(getProduct(p.id), p);
  }
  assert.equal(getProduct('duck').amountCents, 500);
});

test('getProduct returns undefined for unknown IDs', () => {
  for (const id of ['nope', '', undefined, null, 'constructor', '__proto__', 'DUCK']) {
    assert.equal(getProduct(id), undefined);
  }
});

test('formatPrice formats cents as dollars', () => {
  assert.equal(formatPrice(500), '$5.00');
  assert.equal(formatPrice(1250), '$12.50');
  assert.equal(formatPrice(8900), '$89.00');
  assert.equal(formatPrice(50), '$0.50');
});

test('every product has a unique ID and an integer price of at least 50 cents', () => {
  assert.ok(PRODUCTS.length > 0);
  const ids = PRODUCTS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of PRODUCTS) {
    assert.equal(typeof p.id, 'string');
    assert.equal(typeof p.name, 'string');
    assert.equal(typeof p.description, 'string');
    assert.ok(Number.isInteger(p.amountCents), `${p.id} amountCents is not an integer`);
    assert.ok(p.amountCents >= 50, `${p.id} is below Stripe's 50-cent minimum`);
  }
});

test('the catalog cannot be changed at runtime', () => {
  assert.ok(Object.isFrozen(PRODUCTS));
  assert.throws(() => { getProduct('duck').amountCents = 1; }, TypeError);
  assert.throws(() => { PRODUCTS.push({ id: 'free', amountCents: 1 }); }, TypeError);
  assert.throws(() => { PRODUCTS[0] = { id: 'duck', amountCents: 1 }; }, TypeError);
  assert.equal(getProduct('duck').amountCents, 500);
});
