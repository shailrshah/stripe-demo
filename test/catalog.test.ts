import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCTS, getProduct, formatPrice, parseDollars, resolveItem, itemName, DONATION_MIN_CENTS, DONATION_MAX_CENTS,
} from '../src/catalog.ts';

test('getProduct returns the product for known IDs', () => {
  for (const p of PRODUCTS) {
    assert.equal(getProduct(p.id), p);
  }
  assert.equal(getProduct('duck')?.amountCents, 500);
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
  const duck = getProduct('duck');
  assert.ok(duck);
  // The @ts-expect-error lines check the types forbid these writes, as the runtime does.
  // @ts-expect-error
  assert.throws(() => { duck.amountCents = 1; }, TypeError);
  // @ts-expect-error
  assert.throws(() => { PRODUCTS.push({ id: 'free', amountCents: 1 }); }, TypeError);
  // @ts-expect-error
  assert.throws(() => { PRODUCTS[0] = { id: 'duck', amountCents: 1 }; }, TypeError);
  assert.equal(getProduct('duck')?.amountCents, 500);
});

test('every product has an https image URL', () => {
  for (const product of PRODUCTS) {
    assert.equal(new URL(product.imageUrl).protocol, 'https:', product.id);
  }
});

test('parseDollars converts dollar strings to integer cents without float error', () => {
  const cases: Array<[string, number]> = [
    ['1', 100], ['1.5', 150], ['1.50', 150], ['0.29', 29], ['19.99', 1999], ['1000', 100000], [' 12.34 ', 1234],
  ];
  for (const [input, cents] of cases) assert.equal(parseDollars(input), cents, input);
});

test('parseDollars rejects anything but a plain dollar string', () => {
  for (const input of ['', '.5', '1.', '1.999', '-5', '1e3', '$5', '1,000', 'abc', '12345678', 5, null, undefined, {}]) {
    assert.equal(parseDollars(input), null, String(input));
  }
});

test('resolveItem builds a donation item within the limits', () => {
  const result = resolveItem({ productId: 'donation', amount: '12.34' });
  assert.ok('item' in result);
  assert.equal(result.item.id, 'donation');
  assert.equal(result.item.name, 'Donation');
  assert.equal(result.item.amountCents, 1234);
  assert.equal(new URL(result.item.imageUrl).protocol, 'https:');
});

test('resolveItem enforces the donation limits inclusively', () => {
  const cents = (amount: string) => {
    const r = resolveItem({ productId: 'donation', amount });
    return 'item' in r ? r.item.amountCents : null;
  };
  assert.equal(cents('1.00'), DONATION_MIN_CENTS);
  assert.equal(cents('1000.00'), DONATION_MAX_CENTS);
  assert.equal(cents('0.99'), null);
  assert.equal(cents('1000.01'), null);
  assert.equal(cents('0'), null);
});

test('resolveItem rejects a donation with a missing or malformed amount', () => {
  for (const amount of [undefined, '', 'ten', 12]) {
    const r = resolveItem({ productId: 'donation', amount });
    assert.ok('error' in r, String(amount));
    assert.match(r.error, /between \$1\.00 and \$1,000\.00/);
  }
});

test('resolveItem ignores any amount for catalog products', () => {
  const r = resolveItem({ productId: 'keyboard', amount: '1.00' });
  assert.ok('item' in r);
  assert.equal(r.item.amountCents, 8900);
  assert.equal(r.item, getProduct('keyboard'));
});

test('resolveItem rejects unknown products', () => {
  assert.deepEqual(resolveItem({ productId: 'nope' }), { error: 'Unknown product' });
  assert.deepEqual(resolveItem({}), { error: 'Unknown product' });
});

test('itemName names catalog products and donations', () => {
  assert.equal(itemName('duck'), 'Rubber Duck');
  assert.equal(itemName('donation'), 'Donation');
  assert.equal(itemName('nope'), null);
});

test('formatPrice groups thousands', () => {
  assert.equal(formatPrice(100000), '$1,000.00');
});
