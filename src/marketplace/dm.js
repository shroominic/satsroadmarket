/** NIP-17 fallback DM (kind 14 rumor -> kind 13 seal -> kind 1059 gift wrap), built with nostr-tools nip59. Not Marmot. */
import { wrapEvent, unwrapEvent } from 'nostr-tools/nip59';
import { publishWithAcks, storage } from '../lib/nostr.js';

export const defaultDmText = (title) => `Hey, I'm interested in your listing "${title}". Please publish a Marmot key package (open satsroadmarket.com once) so we can talk privately and I can pay with ecash.`;

/** Rumor tags: p = recipient, a = listing address, subject marks the purpose. */
export function dmRumorTemplate({ recipient, listingRef, text, now = Math.floor(Date.now() / 1000) }) {
  return { kind: 14, created_at: now, content: text, tags: [['p', recipient], ['a', listingRef], ['subject', 'listing-interest']] };
}
/** Wraps for the seller and a copy to the sender (so the buyer can see what was sent after a reload). */
export function buildDmWraps({ sk, recipient, selfPubkey, listingRef, text }) {
  const rumor = dmRumorTemplate({ recipient, listingRef, text });
  return { toSeller: wrapEvent(rumor, sk, recipient), toSelf: wrapEvent(rumor, sk, selfPubkey) };
}

/** Seller's NIP-17 inbox relays (kind 10050); falls back to `fallbackRelays` (Shopstr defaults). */
export async function inboxRelaysOf({ pool, lookupRelays, pubkey, fallbackRelays }) {
  try {
    const events = await pool.querySync(lookupRelays, { kinds: [10050], authors: [pubkey], limit: 5 }, { maxWait: 5000 });
    const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
    const relays = (newest?.tags || []).filter((t) => t[0] === 'relay' && /^wss?:\/\//.test(t[1] || '')).map((t) => t[1]);
    if (relays.length) return { relays: [...new Set(relays)], source: '10050' };
  } catch { /* use fallback */ }
  return { relays: fallbackRelays, source: 'defaults' };
}

export async function sendListingDm({ app, listing, text }) {
  const { relays, source } = await inboxRelaysOf({ pool: app.pool, lookupRelays: [...new Set([...app.listingRelays, ...app.relays])], pubkey: listing.pubkey, fallbackRelays: app.listingRelays });
  const { toSeller, toSelf } = buildDmWraps({ sk: app.identity.sk, recipient: listing.pubkey, selfPubkey: app.identity.pubkey, listingRef: listing.address, text });
  const acks = await publishWithAcks(app.pool, relays, toSeller, 8000);
  if (!acks.some((a) => a.ok)) throw new Error(`No relay accepted the direct message (${acks.map((a) => `${a.relay}: ${a.message}`).join('; ')}).`);
  publishWithAcks(app.pool, relays, toSelf, 8000).catch(() => {});
  const record = { listingRef: listing.address, seller: listing.pubkey, title: listing.title, text, sentAt: Math.floor(Date.now() / 1000), relays, source, acks };
  const key = `sr.dm.${app.identity.pubkey}`; const all = storage.getJSON(key, {}); all[listing.address] = record; storage.setJSON(key, all);
  return record;
}
export const pendingDm = (app, address) => storage.getJSON(`sr.dm.${app.identity?.pubkey}`, {})[address] || null;
export const clearPendingDm = (app, address) => { const key = `sr.dm.${app.identity.pubkey}`; const all = storage.getJSON(key, {}); delete all[address]; storage.setJSON(key, all); };

/** Seller: fetch gift wraps addressed to me and keep NIP-17 kind-14 rumors that reference one of my listings. */
export async function fetchListingDms({ app }) {
  const me = app.identity.pubkey;
  const own = await inboxRelaysOf({ pool: app.pool, lookupRelays: [...new Set([...app.listingRelays, ...app.relays])], pubkey: me, fallbackRelays: [] });
  const relays = [...new Set([...own.relays, ...app.listingRelays, ...app.relays])];
  const wraps = await app.pool.querySync(relays, { kinds: [1059], '#p': [me], since: Math.floor(Date.now() / 1000) - 14 * 86400, limit: 200 }, { maxWait: 6000 });
  const out = [];
  for (const wrap of wraps) {
    let rumor; try { rumor = unwrapEvent(wrap, app.identity.sk); } catch { continue; } // Marmot welcomes and foreign wraps land here too
    if (rumor.kind !== 14) continue;
    const ref = rumor.tags.find((t) => t[0] === 'a')?.[1] || '';
    if (!ref.startsWith(`30402:${me}:`)) continue;
    out.push({ id: rumor.id, from: rumor.pubkey, text: rumor.content, listingRef: ref, created_at: rumor.created_at });
  }
  return [...new Map(out.map((m) => [m.id, m])).values()].sort((a, b) => b.created_at - a.created_at);
}
