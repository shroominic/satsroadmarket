import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarmotNetwork } from '../src/lib/marmot.js';

test('subscription reconnects with backoff + jitter, reports reasons, and does not hammer relays', async () => {
  let opens = 0; const errors = [];
  const pool = { subscribeMany(relays, f, p) { opens++; queueMicrotask(() => p.onclose([{ url: 'wss://a/', reason: 'connection timed out' }])); return { close() {} }; } };
  const net = createMarmotNetwork(pool, ['wss://a'], { onError: (e) => errors.push(e) });
  const sub = net.subscription(['wss://a'], { kinds: [445] }).subscribe({});
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(opens, 1, 'no immediate retry storm: first retry waits at least ~500 ms');
  assert.equal(errors[0].code, 'RELAY_SUBSCRIPTION_CLOSED'); assert.equal(errors[0].reasons[0].reason, 'connection timed out');
  assert.doesNotMatch(errors[0].message, /\[\{/, 'friendly message, no raw JSON');
  sub.unsubscribe();
});
test('subscription asks the pool for a long (15 s) connection timeout', async () => {
  let seen; const pool = { subscribeMany(relays, f, p) { seen = p; return { close() {} }; } };
  const sub = createMarmotNetwork(pool, ['wss://a'], {}).subscription(['wss://a'], { kinds: [445] }).subscribe({}); assert.equal(seen.maxWait, 15000); sub.unsubscribe();
});
