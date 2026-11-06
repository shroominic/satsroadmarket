import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createDmTransport, threadOf, dmId, parseDmId, isDmId } from '../src/marketplace/dmchat.js';
import { requestRumor, deriveOrder, receiptRumor } from '../src/marketplace/orders.js';

/** A shared in-memory "relay" so two identities exchange real NIP-59 wraps. */
function relayPool() {
  const events = []; const subs = [];
  return {
    publish: (relays, ev) => { events.push(ev); for (const s of subs) if (s.f['#p']?.includes(ev.tags.find((t) => t[0] === 'p')?.[1])) queueMicrotask(() => s.p.onevent(ev)); return relays.map(async () => 'ok'); },
    querySync: async () => [],
    subscribeMany: (relays, f, p) => { const s = { f, p }; subs.push(s); for (const ev of events) if (f['#p']?.includes(ev.tags.find((t) => t[0] === 'p')?.[1])) queueMicrotask(() => p.onevent(ev)); return { close() { subs.splice(subs.indexOf(s), 1); } }; },
  };
}
const mkStore = () => { const m = new Map(); return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); }, m }; };
const mk = (pool, sk, storage = mkStore()) => ({ sk, pubkey: getPublicKey(sk), storage, tr: createDmTransport({ pool, getRelays: () => ({ lookup: ['wss://x'], defaults: ['wss://x'] }), identity: { sk, pubkey: getPublicKey(sk) }, storage }) });
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('ids: dm:<peer>:<listing> round-trips; threadOf finds the peer from either side', () => {
  const peer = 'b'.repeat(64), ref = `30402:${'a'.repeat(64)}:camel`; const id = dmId(peer, ref);
  assert.ok(isDmId(id)); assert.deepEqual(parseDmId(id), { peer, listingRef: ref }); assert.equal(parseDmId('group-1'), null);
  const me = 'c'.repeat(64);
  assert.equal(threadOf({ kind: 14, pubkey: peer, tags: [['a', ref]] }, me).id, id);
  assert.equal(threadOf({ kind: 14, pubkey: me, tags: [['a', ref], ['p', peer]] }, me).id, id);
  assert.equal(threadOf({ kind: 9, pubkey: peer, tags: [['a', ref]] }, me), null); assert.equal(threadOf({ kind: 14, pubkey: peer, tags: [] }, me), null);
});
test('two identities: NIP-17 send, receive, order tags, receipt, reload persistence', async () => {
  const pool = relayPool(); const seller = mk(pool, generateSecretKey()); const buyer = mk(pool, generateSecretKey());
  const ref = `30402:${seller.pubkey}:camel-1`; seller.tr.start(); buyer.tr.start();
  const id = buyer.tr.ensureThread(seller.pubkey, ref, { title: 'Camel' });
  await buyer.tr.sendMessage(id, requestRumor({ orderId: 'o1', listingRef: ref, amount: 1325, title: 'Camel', fiat: { amount: 1, currency: 'USD', rate: 75000 } }));
  await buyer.tr.sendMessage(id, { content: 'hello seller', tags: [] }); await wait();
  const sid = dmId(buyer.pubkey, ref); assert.deepEqual((await seller.tr.listGroups()).map((g) => g.id), [sid]);
  const sh = await seller.tr.history(sid); assert.equal(sh.length, 2); assert.equal(sh[1].content, 'hello seller'); assert.equal(sh[0].pubkey, buyer.pubkey);
  const order = deriveOrder(sh, { sellerPubkey: seller.pubkey }); assert.equal(order.amount, 1325); assert.equal(order.fiat.currency, 'USD'); assert.equal(order.paid, false, 'not PAID without a seller receipt');
  await seller.tr.sendMessage(sid, receiptRumor({ orderId: 'o1', listingRef: ref, amount: 1325 })); await wait();
  const bh = await buyer.tr.history(id); assert.ok(bh.some((r) => r.tags.some((t) => t[0] === 'status' && t[1] === 'confirmed')));
  assert.equal(deriveOrder(bh, { sellerPubkey: seller.pubkey }).paid, true, 'PAID comes only from the seller receipt');
  // reload persistence: a new transport with the same storage sees the thread without any relay
  buyer.tr.stop(); await wait(300); const again = mk(relayPool(), buyer.sk, buyer.storage); assert.equal((await again.tr.history(id)).length, 3);
});
test('failed publish keeps the message in an outbox and retryPending delivers it later', async () => {
  const pool = relayPool(); let down = true; const orig = pool.publish; pool.publish = (r, ev) => (down ? r.map(async () => { throw new Error('offline'); }) : orig(r, ev));
  const seller = mk(pool, generateSecretKey()); const buyer = mk(pool, generateSecretKey()); const ref = `30402:${seller.pubkey}:x`; seller.tr.start();
  const id = buyer.tr.ensureThread(seller.pubkey, ref);
  await assert.rejects(() => buyer.tr.sendMessage(id, { content: 'queued' }), (e) => e.code === 'NO_RELAY_ACK');
  assert.equal((await buyer.tr.outbox(id)).length, 1); down = false; await buyer.tr.retryPending(id); await wait();
  assert.equal((await buyer.tr.outbox(id)).length, 0); assert.equal((await seller.tr.history(dmId(buyer.pubkey, ref)))[0].content, 'queued');
});
