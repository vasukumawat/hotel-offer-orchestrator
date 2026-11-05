import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResult, dedupeOffers, hotelKey } from '../src/dedupe';
import type { HotelOffer } from '../src/types';

const o = (name: string, price: number, commission: number, supplier: 'A' | 'B'): HotelOffer => ({
  name, price, commission, supplier, city: 'delhi', currency: 'INR',
});

test('hotelKey ignores case, accents, punctuation and extra whitespace', () => {
  assert.equal(hotelKey('  The  Café-Royal! '), hotelKey('the cafe royal'));
});

test('cheapest offer wins', () => {
  const out = dedupeOffers([o('Hotel X', 5000, 10, 'A'), o('hotel x', 4000, 5, 'B')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].supplier, 'B');
});

test('equal price: higher commission wins', () => {
  const out = dedupeOffers([o('Taj Palace', 11500, 12, 'A'), o('taj palace', 11500, 15, 'B')]);
  assert.equal(out[0].supplier, 'B');
});

test('full tie keeps first (supplier A)', () => {
  const out = dedupeOffers([o('The Imperial', 14000, 15, 'A'), o('The Imperial', 14000, 15, 'B')]);
  assert.equal(out[0].supplier, 'A');
});

test('output sorted by price ascending', () => {
  const out = dedupeOffers([o('B', 300, 1, 'A'), o('A', 100, 1, 'A'), o('C', 200, 1, 'B')]);
  assert.deepEqual(out.map((h) => h.price), [100, 200, 300]);
});

test('buildResult flags degraded when one supplier failed', () => {
  const r = buildResult([o('X', 1, 1, 'A')], null);
  assert.equal(r.degraded, true);
  assert.deepEqual(r.suppliers, { A: 'ok', B: 'failed' });
  assert.equal(r.hotels.length, 1);
});
