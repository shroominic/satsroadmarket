import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEvents, applyDeletions, nextCursor, newStore, trimStore, isExpired, createListingLoader, hydrate, serialize, CACHE_KEY, addressOf } from '../src/marketplace/loader.js';

const PK = 'a'.repeat(64), PK2 = 'b'.repeat(64);
let n = 0;
const ev = (d, created_at, extra = {}) => ({ id: (++n).toString(16).padStart(64, '0'), kind: 30402, pubkey: extra.pubkey || PK, created_at, content: 'c', tags: [['d', d], ['title', `T-${d}`], ['price', '5', 'SAT'], ['t', 'shopstr'], ...(extra.tags || [])], sig: '' });
const NOW = 1_000_000;

test('merge keeps the newest version per address and counts changes', () => {
  const s = newStore(); const a1 = ev('x', 10), a2 = ev('x', 20), b = ev('y', 5);
  assert.equal(mergeEvents(s, [a1, b], NOW), 2); assert.equal(mergeEvents(s, [a2], NOW), 1); assert.equal(mergeEvents(s, [a1], NOW), 0);
  assert.equal(s.events.get(addressOf(a1)).id, a2.id); assert.equal(s.events.size, 2);
});
test('same timestamp tie-breaks on lowest id (NIP-01) regardless of arrival order', () => {
  const s1 = newStore(), s2 = newStore(); const a = ev('x', 10), b = ev('x', 10);
  mergeEvents(s1, [a, b], NOW); mergeEvents(s2, [b, a], NOW); assert.equal(s1.events.get(addressOf(a)).id, s2.events.get(addressOf(a)).id);
});
test('expired events are rejected and detected', () => {
  const s = newStore(); const e = ev('x', 10, { tags: [['expiration', String(NOW - 1)]] });
  assert.ok(isExpired(e, NOW)); assert.equal(mergeEvents(s, [e], NOW), 0);
});
test('kind 5: author-owned a/e deletions remove listings and block older copies; foreign deletes are ignored', () => {
  const s = newStore(); const a = ev('x', 10), b = ev('y', 10), c = ev('z', 10);
  mergeEvents(s, [a, b, c], NOW);
  const del = { kind: 5, pubkey: PK, created_at: 50, tags: [['a', addressOf(a)], ['e', b.id]], content: '', id: 'd'.repeat(64) };
  assert.equal(applyDeletions(s, [del]), 2); assert.equal(s.events.size, 1);
  assert.equal(mergeEvents(s, [ev('x', 40), b], NOW), 0, 'older version and deleted id stay gone');
  assert.equal(mergeEvents(s, [ev('x', 60)], NOW), 1, 'a newer re-publish is allowed');
  const foreign = { kind: 5, pubkey: PK2, created_at: 99, tags: [['a', addressOf(c)], ['e', c.id]], content: '', id: 'e'.repeat(64) };
  assert.equal(applyDeletions(s, [foreign]), 0); assert.ok(s.events.has(addressOf(c)));
});
test('cursor is oldest created_at minus one; empty page gives null', () => {
  assert.equal(nextCursor([ev('a', 30), ev('b', 12), ev('c', 20)]), 11); assert.equal(nextCursor([]), null);
});
test('trim keeps the newest N and cache round-trips', () => {
  const s = newStore(); for (let i = 0; i < 10; i++) mergeEvents(s, [ev(`d${i}`, i + 1)], NOW);
  assert.equal(trimStore(s, 4), 6); assert.deepEqual([...s.events.values()].map((e) => e.created_at).sort((a, b) => b - a), [10, 9, 8, 7]);
  const h = hydrate(JSON.parse(JSON.stringify(serialize(s, { 'wss://r': { until: 3, done: false } }, 123)))); assert.equal(h.store.events.size, 4); assert.equal(h.lastFetched, 123);
  assert.equal(hydrate({ v: 99, events: [] }), null);
});

/* ---- loader with an injectable fake pool: per-relay histories, one REQ per relay at a time ---- */
function fakePool(histories, { delay = 0, failRelay = null } = {}) {
  const log = []; const inflight = {}; let maxPerRelay = 0;
  const run = async (r, f) => {
    if (r === failRelay) throw new Error('rate-limited');
    inflight[r] = (inflight[r] || 0) + 1; maxPerRelay = Math.max(maxPerRelay, inflight[r]); log.push({ r, f });
    await new Promise((x) => setTimeout(x, delay));
    inflight[r]--;
    return histories[r].filter((e) => (f.until == null || e.created_at <= f.until) && (f.since == null || e.created_at >= f.since)).sort((a, b) => b.created_at - a.created_at).slice(0, f.limit ?? 1000);
  };
  return { log, get maxPerRelay() { return maxPerRelay; },
    querySync: async (relays, f) => (f.kinds?.[0] === 5 ? [] : (await Promise.all(relays.map((r) => run(r, f)))).flat()),
    subscribeMany(relays, f, p) { (async () => { for (const r of relays) { try { for (const e of await run(r, f)) p.onevent(e); } catch { /* relay failed */ } } p.oneose(); })(); return { close() {} }; } };
}
const mem = () => { const m = new Map(); return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); }, m }; };
const history = (count, base = 1000) => Array.from({ length: count }, (_, i) => ev(`h${base}-${i}`, base + count - i));

test('initial page + background paging merge across relays and respect one in-flight REQ per relay', async () => {
  const A = history(25, 1000), B = [...history(10, 2000), A[3], A[8]]; // overlap
  const pool = fakePool({ 'wss://a': A, 'wss://b': B });
  const L = createListingLoader({ pool, relays: ['wss://a', 'wss://b'], storage: mem(), pageSize: 10, delayMs: 1, now: () => NOW });
  await L.initial(); const first = L.listings().length; assert.ok(first <= 20 && first > 10);
  let guard = 0; while (!L.exhausted() && guard++ < 20) await L.more(1);
  assert.ok(L.exhausted()); assert.equal(L.listings().length, 25 + 10, 'dedup overlapping events');
  assert.equal(pool.maxPerRelay, 1, 'never more than one REQ per relay at a time');
});
test('a failing relay backs off and does not break the others', async () => {
  const pool = fakePool({ 'wss://a': history(15, 1000), 'wss://bad': [] }, { failRelay: 'wss://bad' });
  const L = createListingLoader({ pool, relays: ['wss://a', 'wss://bad'], storage: mem(), pageSize: 10, delayMs: 1, now: () => NOW });
  await L.initial(); await L.more(3); assert.equal(L.listings().length, 15); assert.ok(L.cursors['wss://bad']);
});
test('cache renders before the network answers, then revalidates with since=lastFetched', async () => {
  const store = mem(); const H = history(12, 1000);
  const first = createListingLoader({ pool: fakePool({ 'wss://a': H }), relays: ['wss://a'], storage: store, pageSize: 50, now: () => NOW });
  await first.initial(); await first.persist(); assert.ok(store.m.has(CACHE_KEY));
  const slow = fakePool({ 'wss://a': [...H, ev('new', NOW + 50)] }, { delay: 300 });
  const changes = []; const second = createListingLoader({ pool: slow, relays: ['wss://a'], storage: store, pageSize: 50, now: () => NOW + 100, onChange: () => changes.push(second.size) });
  const t0 = Date.now(); const cached = await second.loadCache();
  assert.equal(cached, 12); assert.equal(second.listings().length, 12); assert.ok(Date.now() - t0 < 100, 'cache paints before any network round trip'); assert.equal(slow.log.length, 0, 'no network used yet');
  await second.initial(); assert.equal(second.listings().length, 13);
  assert.ok(slow.log.every((l) => l.f.since != null || l.f.kinds[0] === 5), 'revalidation uses since');
});
test('corrupted or blocked storage never throws', async () => {
  const bad = { get: async () => { throw new Error('blocked'); }, set: async () => { throw new Error('full'); } };
  const L = createListingLoader({ pool: fakePool({ 'wss://a': history(3) }), relays: ['wss://a'], storage: bad, pageSize: 10, now: () => NOW });
  assert.equal(await L.loadCache(), 0); await L.initial(); await L.persist(); assert.equal(L.listings().length, 3);
});
