// Probe public relays with the real marmot module. Usage: node scripts/probe-relays.mjs wss://a wss://b ...
process.on('uncaughtException', (e) => console.error('uncaught:', String(e.message).slice(0, 120)));
process.on('unhandledRejection', (e) => console.error('unhandled:', String(e?.message || e).slice(0, 120)));
// Per relay: ~14 events (2 key packages/relay lists, commit, welcome, 2 messages, 1 listing, 1 raw 443).
import 'fake-indexeddb/auto';
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import { deleteTestEvents } from './e2e-cleanup.mjs';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createMarmot } from '../src/lib/marmot.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(300); } return null; };
const timed = async (label, fn, out) => { const t = Date.now(); try { const v = await fn(); out[label] = { ok: !!v?.ok, ms: Date.now() - t, note: v?.note || '' }; return v; } catch (e) { out[label] = { ok: false, ms: Date.now() - t, note: String(e.message).slice(0, 160) }; return null; } };

async function probe(url) {
  const out = {}; const pool = new SimplePool(); const clients = [];
  const sellerKey = generateSecretKey(), buyerKey = generateSecretKey();
  try {
    // NIP-11 / auth hints
    try { const r = await fetch(url.replace(/^ws/, 'http'), { headers: { Accept: 'application/nostr+json' } }); const j = await r.json(); out.nip11 = { ok: true, ms: 0, note: `${j.name || ''} ${j.software || ''} auth_required=${!!j.limitation?.auth_required} payment_required=${!!j.limitation?.payment_required} restricted_writes=${!!j.limitation?.restricted_writes}` }; } catch (e) { out.nip11 = { ok: null, ms: 0, note: 'no NIP-11' }; }
    const seller = await createMarmot({ privateKey: sellerKey, relays: [url] }); clients.push(seller);
    const kp = await timed('kp(30443)+10050+10002 publish', async () => { const r = await seller.publishKeyPackage(); const all = [r.keyPackage.results, r.relayLists.inbox, r.relayLists.nip65].flatMap((x) => Object.values(x)); return { ok: r.ok && all.every((x) => x.ok), note: all.filter((x) => !x.ok).map((x) => x.message).join(';') }; }, out);
    await timed('read-back 30443/10050/10002', async () => { const evs = await pool.querySync([url], { authors: [seller.pubkey], kinds: [30443, 10050, 10002] }); const kinds = [...new Set(evs.map((e) => e.kind))].sort(); return { ok: [10002, 10050, 30443].every((k) => kinds.includes(k)), note: `kinds ${kinds}` }; }, out);
    const buyer = await createMarmot({ privateKey: buyerKey, relays: [url] }); clients.push(buyer); await buyer.start();
    let conv;
    if (kp) conv = await timed('invite: commit(445)+welcome(1059) publish', async () => { const c = await buyer.startConversation(seller.pubkey, { listingRef: `30402:${buyer.pubkey}:probe`, title: 'probe' }); conv = c; return { ok: c.welcome.delivered && Object.values(c.commit).some((r) => r.ok), note: JSON.stringify(Object.values(c.welcome.results || {}).map((r) => r.message || r.ok)).slice(0, 120) }; }, out) && conv;
    // re-read conv since timed returns the value
    const conv2 = out['invite: commit(445)+welcome(1059) publish']?.ok ? await Promise.resolve(buyer.listGroups()[0]) : null;
    if (conv2) {
      const groupId = buyer.listGroups()[0].id ?? buyer.listGroups()[0].groupId;
      await seller.start();
      const invite = await timed('seller receives welcome(1059)', async () => { const i = await waitFor(async () => (await seller.listInvites())[0], 20000); return { ok: !!i, note: i ? '' : 'no invite within 20s' }; }, out);
      if (invite?.ok !== false) {
        await timed('seller accepts invite', async () => { const i = (await seller.listInvites())[0]; await seller.acceptInvite(i.id); return { ok: true }; }, out);
        const got = []; seller.on('message', (m) => got.push(m));
        await timed('message buyer->seller (445 live)', async () => { await buyer.sendMessage(groupId, { content: 'probe-1' }); const m = await waitFor(() => got.find((x) => x.rumor.content === 'probe-1'), 20000); return { ok: !!m, note: m ? '' : 'not received within 20s' }; }, out);
        const gotB = []; buyer.on('message', (m) => gotB.push(m));
        await timed('message seller->buyer (445 live)', async () => { await seller.sendMessage(groupId, { content: 'probe-2' }); const m = await waitFor(() => gotB.find((x) => x.rumor.content === 'probe-2'), 20000); return { ok: !!m, note: m ? '' : 'not received within 20s' }; }, out);
      }
    }
    // listing 30402 + raw 443 (legacy key package kind)
    const listing = finalizeEvent({ kind: 30402, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'probe-' + Date.now()], ['title', '[test] probe listing, ignore'], ['summary', 'probe'], ['price', '1', 'SAT'], ['t', 'shopstr']], content: 'probe listing, please ignore' }, sellerKey);
    await timed('listing 30402 publish+read', async () => { await Promise.any(pool.publish([url], listing)); await sleep(500); const evs = await pool.querySync([url], { kinds: [30402], ids: [listing.id] }); return { ok: evs.length === 1 }; }, out);
    const raw443 = finalizeEvent({ kind: 443, created_at: Math.floor(Date.now() / 1000), tags: [['encoding', 'base64']], content: 'AAAA' }, sellerKey);
    await timed('legacy 443 publish', async () => { await Promise.any(pool.publish([url], raw443)); return { ok: true, note: 'accepted (444 is only ever inside a 1059 wrap)' }; }, out);
  } catch (e) { out.fatal = { ok: false, note: e.message }; }
  finally {
    clients.forEach((c) => { try { c.stop(); } catch {} }); pool.destroy();
    // teardown: delete our own listing / key package / raw 443 (NIP-09 + empty replacement), then verify
    try { out.cleanup = { ok: true, ms: 0, note: JSON.stringify(await deleteTestEvents({ keys: [bytesToHex(sellerKey)], relays: [url] })).slice(0, 200) }; } catch (e) { out.cleanup = { ok: null, ms: 0, note: 'cleanup error ' + e.message.slice(0, 80) }; }
  }
  return out;
}

const urls = process.argv.slice(2);
const results = {};
for (const u of urls) { console.error('probing', u); results[u] = await Promise.race([probe(u), sleep(150000).then(() => ({ fatal: { ok: false, note: 'probe timed out' } }))]); }
console.log(JSON.stringify(results, null, 1));
process.exit(0);
