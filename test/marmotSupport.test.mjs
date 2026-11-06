import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupportCache, POS_TTL, NEG_TTL, SUPPORT_KEY } from '../src/marketplace/marmotSupport.js';

const pk = (i) => String(i).padStart(64, '0');
function fakePool(supported) { const calls = []; return { calls, querySync: async (relays, f) => { calls.push(f); return f.authors.filter((a) => supported.has(a)).map((a) => ({ kind: 30443, pubkey: a })); } }; }
const mem = () => { const m = new Map(); return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), m }; };

test('batches authors into chunks of 50 (not one request per listing) and records positives/negatives', async () => {
  const pool = fakePool(new Set([pk(1), pk(70)])); let changes = 0;
  const c = createSupportCache({ pool, relays: ['wss://r'], delayMs: 1, onChange: () => changes++ });
  await c.ensure(Array.from({ length: 120 }, (_, i) => pk(i + 1)));
  assert.equal(pool.calls.length, 3, '120 authors -> 3 REQs'); assert.deepEqual(pool.calls.map((f) => f.authors.length), [50, 50, 20]);
  assert.ok(pool.calls.every((f) => f.kinds.includes(30443) && f.kinds.includes(10050)));
  assert.equal(c.get(pk(1)), true); assert.equal(c.get(pk(2)), false); assert.equal(c.get(pk(999)), undefined); assert.ok(changes >= 1);
});
test('TTLs: positives 1 h, negatives 10 min; fresh entries are not re-requested', async () => {
  let t = 0; const pool = fakePool(new Set([pk(1)]));
  const c = createSupportCache({ pool, relays: ['wss://r'], delayMs: 1, now: () => t });
  await c.ensure([pk(1), pk(2)]); assert.equal(pool.calls.length, 1);
  t = NEG_TTL - 1; await c.ensure([pk(1), pk(2)]); assert.equal(pool.calls.length, 1, 'still fresh');
  t = NEG_TTL + 1; await c.ensure([pk(1), pk(2)]); assert.equal(pool.calls.length, 2); assert.deepEqual(pool.calls[1].authors, [pk(2)], 'only the negative is re-checked');
  t = POS_TTL + NEG_TTL + 5; await c.ensure([pk(1)]); assert.equal(pool.calls.length, 3, 'positive refreshed after an hour');
});
test('concurrent ensure() calls share one run; cache persists through storage; relay errors do not poison the cache', async () => {
  const st = mem(); const pool = fakePool(new Set([pk(1)]));
  const c = createSupportCache({ pool, relays: ['wss://r'], storage: st, delayMs: 1 });
  await Promise.all([c.ensure([pk(1)]), c.ensure([pk(2)]), c.ensure([pk(1), pk(2)])]); assert.ok(pool.calls.length <= 2);
  await new Promise((r) => setTimeout(r, 650)); assert.ok(st.m.get(SUPPORT_KEY));
  const again = createSupportCache({ pool: fakePool(new Set()), relays: ['wss://r'], storage: st }); assert.equal(again.get(pk(1)), true, 'reloaded from storage');
  const bad = createSupportCache({ pool: { querySync: async () => { throw new Error('offline'); } }, relays: ['wss://r'], delayMs: 1 }); await bad.ensure([pk(5)]); assert.equal(bad.get(pk(5)), undefined);
});
