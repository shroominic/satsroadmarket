import { publishWithAcks } from '../lib/nostr.js';

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
  const price = Number(input.price);
  if (!title || !description) throw new Error('Enter a title and description.');
  if (!Number.isSafeInteger(price) || price < 1) throw new Error('Enter a whole-number price of at least one sat.');
  if (rawImage && !image) throw new Error('Enter a valid HTTP or HTTPS image URL, or leave the image empty.');
  if (input.legal !== true) throw new Error('Confirm that this is a legal product.');
  const id = input.id || globalThis.crypto.randomUUID();
  const tags = [
    ['d', id], ['alt', `Product listing: ${title}`], ['client', 'SatsRoad Market'],
    ['title', title], ['summary', description], ['price', String(price), 'SAT'],
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

export function parseListing(event) {
  if (event.kind !== 30402 || !tag(event, 'd')) return null;
  const priceTag = event.tags.find((item) => item[0] === 'price');
  const parsedPrice = Number(priceTag?.[1]);
  return {
    id: event.id, address: `30402:${event.pubkey}:${tag(event, 'd')}`,
    pubkey: event.pubkey, title: tag(event, 'title') || 'Untitled listing',
    description: event.content || tag(event, 'summary'),
    summary: tag(event, 'summary'), tags: event.tags.filter((item) => item[0] === 't').map((item) => item[1]),
    image: safeImageURL(tag(event, 'image')),
    price: priceTag?.[1] && Number.isFinite(parsedPrice) && parsedPrice >= 0 ? parsedPrice : null,
    currency: priceTag?.[2] || '', location: tag(event, 'location'),
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
  const events = await pool.querySync(relays, { kinds: [30402], '#t': ['shopstr'], limit }, { maxWait: 10000 });
  return latestListings(events);
}
