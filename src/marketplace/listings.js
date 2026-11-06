import { publishWithAcks } from '../lib/nostr.js';
import { DEV_FEATURES } from '../lib/flags.js';
import { parsePrice, CURRENCIES } from '../lib/money.js';

/** Shopstr-compatible NIP-99 classified listings. Signers and relay pool are supplied by the app. */
const tag = (event, name) => event.tags.find((item) => item[0] === name)?.[1] || '';

export function safeImageURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch { return ''; }
}

export function buildListingTemplate(input, now = Math.floor(Date.now() / 1000)) {
  const title = input.title?.trim();
  const description = input.description?.trim();
  const rawImage = input.image?.trim() || '';
  const image = safeImageURL(rawImage);
  const currency = String(input.currency || 'SAT').toUpperCase();
  const price = Number(input.price);
  if (!title || !description) throw new Error('Enter a title and description.');
  if (currency !== 'SAT' && currency !== 'BTC' && !CURRENCIES[currency]) throw new Error(`Unsupported currency ${currency}.`);
  if (currency === 'SAT') { if (!Number.isSafeInteger(price) || price < 1) throw new Error('Enter a whole-number price of at least one sat.'); }
  else if (!Number.isFinite(price) || price <= 0) throw new Error('Enter a price greater than zero.');
  if (rawImage && !image) throw new Error('Enter a valid HTTP or HTTPS image URL, or leave the image empty.');
  if (input.legal !== true) throw new Error('Confirm that this is a legal product.');
  const id = input.id || globalThis.crypto.randomUUID();
  const tags = [
    ['d', id], ['alt', `Product listing: ${title}`], ['client', 'SatsRoad Market'],
    ['title', title], ['summary', description], ['price', String(price), currency],
    ['t', 'shopstr'], ['published_at', String(now)], ['status', 'active'],
  ];
  if (image) tags.push(['image', image]);
  if (input.category?.trim()) tags.push(['t', input.category.trim().toLowerCase()]);
  if (input.location?.trim()) tags.push(['location', input.location.trim()]);
  return { kind: 30402, created_at: now, tags, content: description };
}

/**
 * Sign and publish. Succeeds only if at least one relay explicitly accepts the event.
 * `onAck` receives every relay's own answer, so the UI can show real per-relay results.
 */
export async function publishListing({ input, signer, pool, relays, timeoutMs = 10000, onAck }) {
  if (!signer?.signEvent) throw new Error('Connect a Nostr identity first.');
  if (!pool || !relays?.length) throw new Error('No listing relay configured.');
  const event = await signer.signEvent(buildListingTemplate(input));
  const acks = await publishWithAcks(pool, relays, event, timeoutMs);
  onAck?.(acks, event);
  if (!acks.some((ack) => ack.ok)) {
    const detail = acks.map((ack) => `${ack.relay}: ${ack.message}`).join('; ');
    throw new Error(`All listing relays rejected the event or did not answer (${detail}). Retry when a relay is available.`);
  }
  return event;
}

/** Leftover test/probe listings from automated runs are never shown in production. */
export const isJunkListing = (d, title) => /^probe-/.test(d || '') || (title || '').trim().toLowerCase() === 'probe' || (title || '').trim().toLowerCase().startsWith('[test]');
export function parseListing(event) {
  if (event.kind !== 30402 || !tag(event, 'd')) return null;
  if (!tag(event, 'title') || tag(event, 'status') === 'deleted') return null; // emptied / deleted replacement events
  if (!DEV_FEATURES && isJunkListing(tag(event, 'd'), tag(event, 'title'))) return null; // leftover automated-test listings
  const priceTag = event.tags.find((item) => item[0] === 'price');
  const priceInfo = parsePrice(priceTag);
  return {
    id: event.id, address: `30402:${event.pubkey}:${tag(event, 'd')}`,
    pubkey: event.pubkey, title: tag(event, 'title') || 'Untitled listing',
    description: event.content || tag(event, 'summary'),
    summary: tag(event, 'summary'), tags: event.tags.filter((item) => item[0] === 't').map((item) => item[1]),
    image: safeImageURL(tag(event, 'image')),
    price: priceInfo.amount, priceInfo, currency: priceInfo.currency, location: tag(event, 'location'),
    status: tag(event, 'status'), createdAt: event.created_at,
  };
}

/** NIP-01 addressable events replace older events with the same kind/pubkey/d. */
export function latestListings(events) {
  const newest = new Map();
  for (const event of events) {
    const listing = parseListing(event);
    if (!listing) continue;
    const previous = newest.get(listing.address);
    if (!previous || listing.createdAt > previous.createdAt ||
       (listing.createdAt === previous.createdAt && listing.id < previous.id)) newest.set(listing.address, listing);
  }
  return [...newest.values()].filter((listing) => listing.status !== 'sold').sort((a, b) => b.createdAt - a.createdAt);
}

export async function fetchListings({ pool, relays, limit = 100 }) {
  if (!pool || !relays?.length) throw new Error('No listing relay configured.');
  const events = await pool.querySync(relays, { kinds: [30402], '#t': ['shopstr'], limit }, { maxWait: 6000 });
  return latestListings(events);
}

/** A listing "has an image" when it carries a valid http(s) image URL. */
export const hasValidImage = (listing) => !!safeImageURL(listing?.image || '');
/** Split listings by the "Has image" toggle. */
export function filterByImage(listings, hasImageOnly) {
  if (!hasImageOnly) return { shown: listings, hidden: 0 };
  const shown = listings.filter(hasValidImage);
  return { shown, hidden: listings.length - shown.length };
}

/* ---------- generic market filter chips ---------- */
/** Add more entries here to get more default filter chips. `locked` chips are shown but cannot be removed. */
export const MARKET_FILTERS = [
  { id: 'hasImage', label: 'Has image', apply: (l) => filterByImage(l, true), hiddenText: (n) => `${n} listing${n > 1 ? 's' : ''} without images hidden.` },
  /** OFF by default. Needs ctx.support(pubkey) -> true/false/undefined; vendors not yet looked up are not shown while the chip is on. */
  { id: 'marmot', label: 'Marmot vendors', default: false, apply: (l, ctx) => { const shown = l.filter((x) => ctx?.support?.(x.pubkey) === true); return { shown, hidden: l.length - shown.length }; } },
];
const FILTER_KEY = 'sr.filters';
/** Active filter ids, persisted per browser. Default: every filter on. Legacy key sr.hasImage=0 is honoured. */
export function loadActiveFilters(storage) {
  let saved = null; try { saved = storage.getJSON(FILTER_KEY, null); } catch { /* ignore */ }
  const ids = Array.isArray(saved) ? saved : MARKET_FILTERS.filter((f) => f.default !== false).map((f) => f.id);
  return new Set(ids.filter((id) => !(id === 'hasImage' && storage.get('sr.hasImage') === '0' && !Array.isArray(saved))));
}
export function saveActiveFilters(storage, set) { try { storage.setJSON(FILTER_KEY, [...set]); } catch { /* ignore */ } }
/** Applies the active chips; returns visible listings plus a per-filter hidden count. */
export function applyFilters(listings, active, filters = MARKET_FILTERS, ctx = {}) {
  let current = listings; const hidden = {};
  for (const f of filters) { if (!active.has(f.id)) continue; const r = f.apply(current, ctx); current = r.shown; hidden[f.id] = r.hidden; }
  return { shown: current, hidden };
}
