import 'fake-indexeddb/auto'; // browser path: localforage -> IndexedDB (fake in Node)
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey } from 'nostr-tools/pure';
import { startRelay } from '../scripts/local-relay.mjs';
import { createMarmot, MarmotError } from '../src/lib/marmot.js';

const waitFor = async (fn, what, ms = 8000) => {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`timeout waiting for ${what}${last ? `: ${last.message}` : ''}`);
};

const buyerKey = generateSecretKey(), sellerKey = generateSecretKey();
const clients = [];
const make = async (key, relays) => { const m = await createMarmot({ privateKey: key, relays }); clients.push(m); return m; };
const listing = '30402:' + 'ab'.repeat(32) + ':camel-1';
let relay, relayPort, groupId;
const state = {};

test.before(async () => { relay = await startRelay({ port: 0 }); relayPort = relay.port; });
test.after(async () => { clients.forEach(c => c.stop()); await relay.close(); });

test('missing key package gives a typed error and creates no group', async () => {
  const buyer = await make(buyerKey, [relay.url]);
  await buyer.start();
  const before = buyer.listGroups().length;
  await assert.rejects(() => buyer.startConversation('cd'.repeat(32), { listingRef: listing }), e => e instanceof MarmotError && e.code === 'NO_KEY_PACKAGE');
  assert.equal(buyer.listGroups().length, before);
  buyer.stop();
});

test('seller publishes key package, then goes offline; buyer invites; seller joins late', async () => {
  let seller = await make(sellerKey, [relay.url]);
  const pub = await seller.publishKeyPackage();
  assert.ok(pub.ok, 'key package ACKed');
  assert.equal(pub.keyPackage.results[seller.relays[0]].ok, true);
  assert.ok([...relay.events.values()].some(e => e.kind === 30443 && e.pubkey === seller.pubkey));
  assert.ok([...relay.events.values()].some(e => e.kind === 10050));
  seller.stop(); // seller offline

  const buyer = await make(buyerKey, [relay.url]);
  await buyer.start();
  const conv = await buyer.startConversation(seller.pubkey, { listingRef: listing, title: 'Camel' });
  groupId = conv.groupId;
  assert.equal(conv.welcome.delivered, true);
  assert.ok(Object.values(conv.commit).some(r => r.ok));
  assert.ok([...relay.events.values()].some(e => e.kind === 1059), 'welcome gift wrap stored on relay');
  assert.ok([...relay.events.values()].some(e => e.kind === 445), 'commit stored on relay');
  state.buyer = buyer;

  // seller comes online later (fresh client, persisted store)
  seller = await make(sellerKey, [relay.url]);
  const seen = [];
  seller.on('invite', i => seen.push(i));
  await seller.start();
  const invite = await waitFor(async () => (await seller.listInvites())[0], 'invite');
  assert.equal(invite.from, buyer.pubkey);
  assert.equal(invite.joinable, true);
  assert.equal(invite.group.listingRef, listing);
  const joined = await seller.acceptInvite(invite.id);
  assert.equal(joined, groupId);
  assert.equal((await seller.listInvites()).length, 0);
  assert.equal(seller.listGroups().length, 1);
  state.seller = seller;
});

test('messages flow both ways, with arbitrary tags (Shopstr-style payment rumor)', async () => {
  const { buyer, seller } = state;
  const gotSeller = [], gotBuyer = [];
  seller.on('message', m => gotSeller.push(m)); buyer.on('message', m => gotBuyer.push(m));

  const r1 = await buyer.sendMessage(groupId, { content: 'hello seller' });
  assert.ok(Object.values(r1.results).some(r => r.ok), 'real relay ACK');
  await waitFor(() => gotSeller.find(m => m.rumor.content === 'hello seller'), 'seller receives');
  assert.equal(gotSeller[0].own, false);

  const tags = [['subject', 'order-payment'], ['order', 'ord-123'], ['amount', '2100'], ['a', listing], ['payment', 'ecash', 'cashuBxyz'], ['custom', 'x', 'y', 'z']];
  const token = 'cashuB' + 'A'.repeat(300);
  await buyer.sendMessage(groupId, { kind: 14, content: token, tags });
  const pay = await waitFor(() => gotSeller.find(m => m.rumor.content === token), 'seller receives payment rumor');
  assert.equal(pay.rumor.kind, 14);
  assert.deepEqual(pay.rumor.tags, tags);
  assert.equal(pay.rumor.pubkey, buyer.pubkey);

  await seller.sendMessage(groupId, { content: 'got it, thanks', tags: [['order', 'ord-123']] });
  const back = await waitFor(() => gotBuyer.find(m => m.rumor.content === 'got it, thanks' && !m.own), 'buyer receives');
  assert.deepEqual(back.rumor.tags, [['order', 'ord-123']]);
  assert.equal(back.rumor.pubkey, seller.pubkey);

  const h = await seller.history(groupId);
  assert.deepEqual(h.map(m => m.content), ['hello seller', token, 'got it, thanks']);
  const hb = await buyer.history(groupId);
  assert.equal(hb.length, 3);
});

test('restart from persisted store keeps groups and history, and still exchanges messages', async () => {
  state.buyer.stop(); state.seller.stop();
  const buyer = await make(buyerKey, [relay.url]);
  const seller = await make(sellerKey, [relay.url]);
  await buyer.start(); await seller.start();
  assert.equal(buyer.listGroups().length, 1);
  assert.equal(buyer.listGroups()[0].listingRef, listing);
  assert.deepEqual((await buyer.history(groupId)).map(m => m.content).slice(0, 1), ['hello seller']);
  assert.equal((await seller.history(groupId)).length, 3);
  const got = [];
  seller.on('message', m => got.push(m));
  await buyer.sendMessage(groupId, { content: 'after restart' });
  await waitFor(() => got.find(m => m.rumor.content === 'after restart'), 'post-restart delivery');
  assert.equal((await seller.history(groupId)).length, 4, 'backfill after restart does not duplicate history');
  state.buyer = buyer; state.seller = seller;
});

test('relay down: publish reports failure honestly; retry succeeds after relay returns', async () => {
  const { buyer, seller } = state;
  await relay.close();
  let err;
  try { await buyer.sendMessage(groupId, { content: 'sent while relay down' }); } catch (e) { err = e; }
  assert.ok(err instanceof MarmotError && err.code === 'NO_RELAY_ACK', `expected NO_RELAY_ACK, got ${err?.code || err}`);
  assert.ok(Object.values(err.results).length >= 1 && Object.values(err.results).every(r => r.ok === false), 'per-relay failure reported');

  // relay comes back on the same port (empty memory: relay state is lost, as for a restarted in-memory relay)
  relay = await startRelay({ port: relayPort });
  const got = [];
  seller.on('message', m => got.push(m));
  await waitFor(async () => { const r = await buyer.retryPending(groupId); return r.retried > 0 && Object.values(r.results).some(x => x.ok); }, 'retry ACK', 15000);
  await waitFor(() => got.find(m => m.rumor.content === 'sent while relay down'), 'seller receives retried message', 15000);
  assert.equal((await buyer.outbox(groupId)).length, 0, 'outbox drained');
  const h = await seller.history(groupId);
  assert.equal(h.filter(m => m.content === 'sent while relay down').length, 1, 'delivered exactly once');
});

test('publishKeyPackage republishes after the relay lost its events', async () => {
  const { seller } = state;
  assert.equal([...relay.events.values()].filter(e => e.kind === 30443).length, 0, 'fresh relay holds no key package');
  const pub = await seller.publishKeyPackage();
  assert.ok(pub.ok);
  assert.equal([...relay.events.values()].filter(e => e.kind === 30443 && e.pubkey === seller.pubkey).length, 1);
});

test('injectable in-memory store works (no IndexedDB): full invite/accept/message round trip', async () => {
  const { InMemoryKeyValueStore } = await import('@internet-privacy/marmot-ts/extra');
  const stores = new Map();
  const storeFactory = (pk, name) => { const k = pk + name; if (!stores.has(k)) stores.set(k, new InMemoryKeyValueStore()); return stores.get(k); };
  const a = await createMarmot({ privateKey: generateSecretKey(), relays: [relay.url], storeFactory });
  const b = await createMarmot({ privateKey: generateSecretKey(), relays: [relay.url], storeFactory });
  clients.push(a, b);
  await b.publishKeyPackage(); await a.start(); await b.start();
  const { groupId: gid } = await a.startConversation(b.pubkey);
  const inv = await waitFor(async () => (await b.listInvites())[0], 'invite');
  assert.equal(await b.acceptInvite(inv.id), gid);
  const got = []; b.on('message', m => got.push(m));
  await a.sendMessage(gid, { content: 'mem' });
  await waitFor(() => got.find(m => m.rumor.content === 'mem'), 'message');
});
