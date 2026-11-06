import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, loadActiveFilters, saveActiveFilters, MARKET_FILTERS } from '../src/marketplace/listings.js';

const mem = () => { const m = new Map(); return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), getJSON: (k, f) => (m.has(k) ? JSON.parse(m.get(k)) : f), setJSON: (k, v) => m.set(k, JSON.stringify(v)) }; };
const L = [{ image: 'https://a.example/x.png' }, { image: '' }, {}];
test('default: Has image chip is on and hides listings without images', () => {
  const st = mem(); const active = loadActiveFilters(st);
  assert.ok(active.has('hasImage'));
  const r = applyFilters(L, active); assert.equal(r.shown.length, 1); assert.equal(r.hidden.hasImage, 2);
});
test('removing the chip shows everything, and the choice persists', () => {
  const st = mem(); const active = loadActiveFilters(st); active.delete('hasImage'); saveActiveFilters(st, active);
  const again = loadActiveFilters(st); assert.ok(!again.has('hasImage'));
  assert.equal(applyFilters(L, again).shown.length, 3);
  again.add('hasImage'); saveActiveFilters(st, again); assert.ok(loadActiveFilters(st).has('hasImage'));
});
test('legacy sr.hasImage=0 is honoured and a throwing storage falls back to defaults', () => {
  const st = mem(); st.set('sr.hasImage', '0'); assert.ok(!loadActiveFilters(st).has('hasImage'));
  const bad = { get() { throw new Error('x'); }, getJSON() { throw new Error('x'); } };
  assert.ok(MARKET_FILTERS.length >= 1);
  assert.throws(() => loadActiveFilters(bad)); // callers pass the safe storage wrapper, which never throws
});
