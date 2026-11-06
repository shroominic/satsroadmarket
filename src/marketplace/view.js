import { fetchListings } from './listings.js';
import { filterListings, listingBlockReason } from '../lib/filter.js';
import { npubOf, shortKey } from '../lib/nostr.js';
import { h, ago, sats, notice, button, busy } from '../ui/dom.js';

/** Image with an honest placeholder when missing, blocked or 404. */
export function listingImage(listing, cls = 'thumb') {
  const placeholder = (why) => h('div', { class: `${cls} img-missing`, role: 'img', 'aria-label': `No image: ${why}` }, h('span', { class: 'img-missing-icon', 'aria-hidden': 'true' }, '[ ? ]'), h('span', {}, why));
  if (!listing.image) return placeholder('no image provided');
  const img = h('img', { class: cls, alt: listing.title, loading: 'lazy', referrerPolicy: 'no-referrer', decoding: 'async' });
  img.addEventListener('error', () => img.replaceWith(placeholder('image failed to load')), { once: true });
  img.src = listing.image;
  return img;
}

export function mountMarket(root, app, { address } = {}) {
  let search = '';
  const status = h('div', { class: 'status-slot' });
  const grid = h('div', { class: 'listing-grid' });
  const hiddenNote = h('p', { class: 'quiet small' });
  const detail = h('div', { class: 'detail-slot' });

  const searchInput = h('input', { type: 'search', placeholder: 'Search titles and descriptions…', 'aria-label': 'Search listings', onInput: (e) => { search = e.target.value.toLowerCase(); draw(); } });
  const refreshBtn = button('Refresh', async () => { await busy(refreshBtn, 'Loading…', () => app.refreshListings()); }, { cls: 'btn-small' });
  root.replaceChildren(
    h('div', { class: 'toolbar', hidden: !!address }, searchInput, refreshBtn, h('span', { class: 'toolbar-spacer' }), h('a', { class: 'btn btn-small btn-primary', href: '#/sell' }, 'Sell something')),
    status, grid, hiddenNote, detail);

  function card(listing) {
    const mine = listing.pubkey === app.identity?.pubkey;
    return h('article', { class: 'card' },
      h('a', { class: 'card-link', href: `#/listing/${encodeURIComponent(listing.address)}`, 'aria-label': `Open ${listing.title}` }, listingImage(listing)),
      h('div', { class: 'card-body' },
        h('h3', {}, h('a', { href: `#/listing/${encodeURIComponent(listing.address)}` }, listing.title)),
        h('div', { class: 'price' }, listing.price === null ? 'Price not provided' : `${sats(listing.price)}`),
        h('div', { class: 'meta' }, mine ? h('span', { class: 'tag-mine' }, 'YOUR LISTING') : `seller ${shortKey(npubOf(listing.pubkey))}`, ' · ', ago(listing.createdAt))));
  }

  function renderDetail(listing) {
    const mine = listing.pubkey === app.identity?.pubkey;
    const slot = h('div', { class: 'status-slot' });
    const ready = app.marmotState.status === 'ready';
    let reason = '';
    if (!app.identity) reason = 'Create or import an identity first.';
    else if (mine) reason = 'This is your own listing.';
    else if (app.marmotState.status === 'error') reason = `Private messaging is unavailable: ${app.marmotState.error}`;
    else if (!ready) reason = 'Private messaging is still starting…';
    const startBtn = button('Start private conversation', async () => {
      slot.replaceChildren(notice('info', 'Looking up the seller’s key package and creating the group…'));
      try {
        const out = await busy(startBtn, 'Starting…', () => app.startConversation(listing));
        slot.replaceChildren(notice(out.delivered === false ? 'warn' : 'ok', out.delivered === false
          ? 'Group created, but the invite (Welcome) was not confirmed as delivered. The seller will see it when it arrives; you can retry delivery in Conversations.'
          : 'Group created and the seller was invited. Opening the conversation…'));
        if (out.delivered !== false) setTimeout(() => { location.hash = '#/chats'; }, 600);
        else setTimeout(() => { location.hash = '#/chats'; }, 1800);
      } catch (error) { slot.replaceChildren(notice('error', error.message, button('Retry', () => startBtn.click(), { cls: 'btn-small' }))); }
    }, { cls: 'btn-primary', disabled: !!reason });
    return h('section', { class: 'detail panel' },
      h('div', { class: 'panel-title' }, h('span', {}, listing.title), h('a', { href: '#/market', class: 'panel-title-link' }, '[ back to market ]')),
      h('div', { class: 'detail-grid' },
        listingImage(listing, 'hero'),
        h('div', { class: 'detail-info' },
          h('div', { class: 'price big' }, listing.price === null ? 'Price not provided' : sats(listing.price)),
          h('p', { class: 'description' }, listing.description || 'No description.'),
          h('dl', { class: 'facts' },
            h('dt', {}, 'Seller'), h('dd', { class: 'mono wrap' }, npubOf(listing.pubkey)),
            listing.location ? [h('dt', {}, 'Location'), h('dd', {}, listing.location)] : null,
            listing.tags?.length ? [h('dt', {}, 'Tags'), h('dd', {}, listing.tags.join(', '))] : null,
            h('dt', {}, 'Listed'), h('dd', {}, ago(listing.createdAt)),
            h('dt', {}, 'Address'), h('dd', { class: 'mono wrap small' }, listing.address)),
          h('div', { class: 'actions' }, startBtn, reason ? h('span', { class: 'quiet small' }, reason) : null),
          slot,
          h('p', { class: 'quiet small' }, 'The listing is public. Everything you say after this is inside an end-to-end encrypted Marmot group. Group invites and relay traffic are still visible as metadata to relay operators.'))));
  }

  function draw() {
    const all = app.listings;
    const { shown, hidden } = filterListings(all, app.blocked);
    const visible = shown.filter((l) => !search || `${l.title} ${l.description}`.toLowerCase().includes(search));
    grid.replaceChildren(...visible.map(card));
    hiddenNote.textContent = hidden ? `${hidden} listing${hidden > 1 ? 's' : ''} hidden by your local keyword filter.` : '';
    status.replaceChildren();
    if (app.listingError) status.append(notice('error', app.listingError, button('Retry', () => refreshBtn.click(), { cls: 'btn-small' })));
    else if (app.listingsLoaded && !visible.length) status.append(notice('info', all.length ? 'No listings match.' : 'No listings were returned by your relays. Publish one in Sell, or check Relays in Identity.'));
    else if (!app.listingsLoaded) status.append(notice('info', 'Loading listings from relays…'));
    detail.replaceChildren();
    if (address) {
      const listing = all.find((l) => l.address === address);
      if (!listing) detail.append(notice('warn', app.listingsLoaded ? 'That listing was not found on your relays (it may be sold, replaced or on another relay).' : 'Loading listing…'));
      else if (listingBlockReason(listing, app.blocked)) detail.append(notice('warn', 'This listing is hidden by your local keyword filter.'));
      else { detail.append(renderDetail(listing)); grid.hidden = true; }
    }
  }
  draw();
  const off = app.on('listings', draw);
  const offId = app.on('identity', draw);
  const offM = app.on('marmot', draw);
  return () => { off(); offId(); offM(); };
}

export { fetchListings };
