/**
 * Standard NIP-17 conversations ("Message without Marmot"): kind 14 rumors, sealed (13), gift wrapped (1059) with nostr-tools nip59.
 * Exposes the same small API as the Marmot adapter (listGroups/history/outbox/sendMessage/retryPending) so the Conversations UI,
 * order timeline and payment flow work unchanged. Conversation ids look like `dm:<peer pubkey>:<listing address>`.
 * NO forward secrecy and NO post-compromise security, and more metadata is visible than with Marmot.
 */
import { createRumor, createSeal, createWrap, unwrapEvent } from 'nostr-tools/nip59';
import { inboxRelaysOf } from './dm.js';
import { publishWithAcks } from '../lib/nostr.js';

export const isDmId = (id) => typeof id === 'string' && id.startsWith('dm:');
export const dmId = (peer, listingRef) => `dm:${peer}:${listingRef}`;
export function parseDmId(id) { const m = /^dm:([0-9a-f]{64}):(.+)$/.exec(id || ''); return m ? { peer: m[1], listingRef: m[2] } : null; }
const tagVal = (r, n) => r.tags?.find((t) => t[0] === n)?.[1];

/** Which conversation does an incoming/outgoing rumor belong to? null when it is not a listing-related DM. */
export function threadOf(rumor, me) {
  if (rumor.kind !== 14) return null;
  const ref = tagVal(rumor, 'a') || rumor.tags?.find((t) => t[0] === 'item')?.[1] || '';
  if (!/^30402:[0-9a-f]{64}:.+/.test(ref)) return null;
  const peer = rumor.pubkey === me ? tagVal(rumor, 'p') : rumor.pubkey;
  if (!peer || !/^[0-9a-f]{64}$/.test(peer) || peer === me) return null;
  return { id: dmId(peer, ref), peer, listingRef: ref };
}

export function createDmTransport({ pool, getRelays, identity, storage, onChange = () => {}, now = () => Math.floor(Date.now() / 1000) }) {
  const key = `dm.${identity.pubkey}`; let data = { threads: {}, outbox: {} }; let loaded = false; let sub = null; let saveT;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(async () => { try { await storage?.set(key, data); } catch { /* ignore */ } }, 200); };
  const seenWraps = new Set();
  const thread = (id, extra = {}) => (data.threads[id] ||= { rumors: [], ...extra });
  function addRumor(rumor, extra) {
    const t = threadOf(rumor, identity.pubkey); if (!t) return false;
    const th = thread(t.id, { peer: t.peer, listingRef: t.listingRef, ...extra });
    if (th.rumors.some((r) => r.id === rumor.id)) return false;
    th.rumors.push({ id: rumor.id, pubkey: rumor.pubkey, kind: rumor.kind, content: rumor.content, tags: rumor.tags, created_at: rumor.created_at }); return true;
  }
  const relaysFor = async (peer) => (await inboxRelaysOf({ pool, lookupRelays: getRelays().lookup, pubkey: peer, fallbackRelays: getRelays().defaults })).relays;
  async function publishRumor(rumor, peer) {
    const relays = await relaysFor(peer);
    const toPeer = createWrap(createSeal(rumor, identity.sk, peer), peer);
    const acks = await publishWithAcks(pool, relays, toPeer, 8000);
    if (!acks.some((a) => a.ok)) { const e = new Error(`No relay accepted the message (${acks.map((a) => `${a.relay}: ${a.message}`).join('; ')}).`); e.code = 'NO_RELAY_ACK'; throw e; }
    publishWithAcks(pool, relays, createWrap(createSeal(rumor, identity.sk, identity.pubkey), identity.pubkey), 8000).catch(() => {}); // copy for our other devices / reload
    return acks;
  }
  const api = {
    isStandardDm: true,
    async load() { if (loaded) return; loaded = true; try { const d = await storage?.get(key); if (d?.threads) data = { threads: d.threads, outbox: d.outbox || {} }; } catch { /* ignore */ } onChange(); },
    /** Create (or reuse) a thread. meta is for display only; the order data lives in the rumors. */
    ensureThread(peer, listingRef, meta = {}) { const id = dmId(peer, listingRef); thread(id, { peer, listingRef, ...meta }); save(); return id; },
    async listGroups() { await api.load(); return Object.entries(data.threads).map(([id, t]) => ({ id, name: t.title || 'Standard DM', members: [identity.pubkey, t.peer], listingRef: t.listingRef, status: 'active', standardDm: true, upgraded: t.upgraded || null })); },
    async history(id) { await api.load(); return [...(data.threads[id]?.rumors || [])].sort((a, b) => a.created_at - b.created_at); },
    async outbox(id) { return data.outbox[id] || []; },
    async sendMessage(id, rumorIn) {
      const p = parseDmId(id); if (!p) throw new Error('Not a standard DM conversation.');
      const tags = [['p', p.peer], ['a', p.listingRef], ...(rumorIn.tags || []).filter((t) => t[0] !== 'p' && t[0] !== 'a')];
      const rumor = createRumor({ kind: 14, content: rumorIn.content || '', tags, created_at: now() }, identity.sk);
      addRumor(rumor); save(); onChange();
      try { const results = await publishRumor(rumor, p.peer); return { results }; }
      catch (e) { (data.outbox[id] ||= []).push(rumor); save(); onChange(); throw e; } // kept locally: shown with "Retry delivery"
    },
    async retryPending(id) {
      const p = parseDmId(id); const list = [...(data.outbox[id] || [])]; if (!list.length) return { sent: 0 };
      for (const r of list) { await publishRumor(r, p.peer); data.outbox[id] = (data.outbox[id] || []).filter((x) => x.id !== r.id); }
      save(); onChange(); return { sent: list.length };
    },
    async markUpgraded(id, groupId) { thread(id).upgraded = groupId; save(); onChange(); },
    /** Live subscription for gift wraps addressed to me (wraps carry randomised timestamps up to 2 days back, so look back 3 days). */
    start() {
      api.stop(); const r = getRelays(); const relays = [...new Set([...r.defaults, ...r.lookup])]; if (!relays.length) return;
      sub = pool.subscribeMany(relays, { kinds: [1059], '#p': [identity.pubkey], since: now() - 3 * 86400, limit: 300 }, {
        maxWait: 15000,
        onevent: (wrap) => { if (seenWraps.has(wrap.id)) return; seenWraps.add(wrap.id); let rumor; try { rumor = unwrapEvent(wrap, identity.sk); } catch { return; } if (addRumor(rumor)) { save(); onChange(); } },
      });
    },
    stop() { try { sub?.close(); } catch { /* ignore */ } sub = null; },
  };
  return api;
}
