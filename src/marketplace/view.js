import { fetchListings, MARKET_FILTERS, loadActiveFilters, saveActiveFilters, applyFilters } from './listings.js';
import { filterListings, listingBlockReason } from '../lib/filter.js';
import { npubOf, shortKey, storage } from '../lib/nostr.js';
import { priceLabel } from '../lib/money.js';
import { defaultDmText, sendListingDm, pendingDm, clearPendingDm } from './dm.js';
import { h, ago, sats, notice, button, busy, setKids, keep, reconcile } from '../ui/dom.js';

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
  const pollers = new Set();
  let search = '';
  const PAGE = 24; const CAP = 300; let page = 0; let budget = 3; let infinite = storage.get('sr.infinite') !== '0'; let shownCount = PAGE; let lastVisible = 0; let lastExhausted = true; let pendingScroll = null;
  if (!address && app.marketState) { const m = app.marketState; app.marketState = null; shownCount = m.shown || PAGE; page = m.page || 0; pendingScroll = m.y; } // back from a listing: same place
  const sentinel = h('div', { class: 'scroll-sentinel', 'aria-hidden': 'true' }); const skelRow = h('div', { class: 'listing-grid' });
  /** Infinite scroll: reveal more cards (then fetch more from relays) whenever the sentinel is within ~2 screens of the viewport. */
  function checkNear() {
    if (!infinite || address || sentinel.hidden) return;
    if (sentinel.getBoundingClientRect().top > innerHeight * 2) return;
    if (shownCount < Math.min(lastVisible, CAP)) { shownCount += PAGE; draw(); }
    else if (!lastExhausted && !app.loader.busy && lastVisible < CAP) app.loadMore();
  }
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) checkNear(); }, { rootMargin: '0px 0px 1600px 0px' }) : null;
  io?.observe(sentinel);
  const saveScroll = () => { app.marketState = { y: scrollY, shown: shownCount, page }; };
  addEventListener('scroll', checkNear, { passive: true }); // budget caps automatic background fetch rounds per navigation
  const pager = h('div', { class: 'pager', role: 'navigation', 'aria-label': 'Pages' });
  const active = loadActiveFilters(storage); // chips currently applied (default: all on)
  const status = h('div', { class: 'status-slot' });
  const grid = h('div', { class: 'listing-grid' });
  const hiddenNote = h('p', { class: 'quiet small' });
  const imageNote = h('p', { class: 'quiet small', 'data-testid': 'no-image-note' });
  const filterBar = h('div', { class: 'filter-bar', role: 'group', 'aria-label': 'Filters' });
  const detail = h('div', { class: 'detail-slot' });

  const searchInput = h('input', { type: 'search', placeholder: 'Search titles and descriptions…', 'aria-label': 'Search listings', onInput: (e) => { search = e.target.value.toLowerCase(); shownCount = PAGE; page = 0; draw(); } });
  const refreshBtn = button('Refresh', async () => { await busy(refreshBtn, 'Loading…', () => app.refreshListings()); }, { cls: 'btn-small' });
  root.replaceChildren(
    h('div', { class: 'toolbar', hidden: !!address }, searchInput, refreshBtn, h('span', { class: 'toolbar-spacer' }), h('a', { class: 'btn btn-small btn-primary', href: '#/sell' }, 'Sell something')),
    h('div', { hidden: !!address }, filterBar), status, grid, skelRow, sentinel, pager, imageNote, hiddenNote, detail);

  function card(listing) {
    const mine = listing.pubkey === app.identity?.pubkey;
    return h('article', { class: 'card' },
      h('a', { class: 'card-link', onClick: saveScroll, href: `#/listing/${encodeURIComponent(listing.address)}`, 'aria-label': `Open ${listing.title}` }, listingImage(listing)),
      h('div', { class: 'card-body' },
        h('h3', {}, h('a', { onClick: saveScroll, href: `#/listing/${encodeURIComponent(listing.address)}` }, listing.title)),
        h('div', { class: 'price' }, priceLabel(listing.priceInfo, app.rates.map()).text),
        h('div', { class: 'meta' }, mine ? h('span', { class: 'tag-mine' }, 'YOUR LISTING') : `seller ${app.profiles?.get(listing.pubkey)?.name || shortKey(npubOf(listing.pubkey))}`, ' · ', ago(listing.createdAt))));
  }

  const detailReason = (listing) => {
    if (!app.identity) return 'Create or import an identity first.';
    if (listing.pubkey === app.identity.pubkey) return 'This is your own listing.';
    if (app.marmotState.status === 'error') return `Private messaging is unavailable: ${app.marmotState.error}`;
    if (app.marmotState.status !== 'ready') return 'Private messaging is still starting…';
    if (listing.price != null && !priceLabel(listing.priceInfo, app.rates.map()).payable) return 'This price cannot be paid yet: the exchange rate is unavailable or the currency is not supported.';
    return '';
  };
  let detailSig = '';
  function renderDetail(listing) {
    const mine = listing.pubkey === app.identity?.pubkey;
    const slot = h('div', { class: 'status-slot' });
    const ready = app.marmotState.status === 'ready';
    const reason = detailReason(listing);
    const startBtn = button('Start private conversation', async () => {
      slot.replaceChildren(notice('info', 'Looking up the seller’s key package and creating the group…'));
      try {
        const out = await busy(startBtn, 'Starting…', () => app.startConversation(listing));
        slot.replaceChildren(notice(out.delivered === false ? 'warn' : 'ok', out.delivered === false
          ? 'Group created, but the invite (Welcome) was not confirmed as delivered. The seller will see it when it arrives; you can retry delivery in Conversations.'
          : 'Group created and the seller was invited. Opening the conversation…'));
        if (out.delivered !== false) setTimeout(() => { location.hash = '#/chats'; }, 600);
        else setTimeout(() => { location.hash = '#/chats'; }, 1800);
      } catch (error) {
        if (error.code === 'NO_KEY_PACKAGE') showDmFallback();
        else slot.replaceChildren(notice('error', error.message, button('Retry', () => startBtn.click(), { cls: 'btn-small' })));
      }
    }, { cls: 'btn-primary', disabled: !!reason });

    /* No Marmot key package: offer an explicit, editable NIP-17 DM. Never sent without a click on Send. */
    let pollTimer;
    function stopPoll() { clearInterval(pollTimer); pollTimer = null; }
    async function recheck(auto = false) {
      try { const out = await app.startConversation(listing); stopPoll(); clearPendingDm(app, listing.address);
        slot.replaceChildren(notice('ok', 'The seller published a key package. Private Marmot conversation created. Opening…')); setTimeout(() => { location.hash = '#/chats'; }, 800); return true; }
      catch (error) { if (error.code !== 'NO_KEY_PACKAGE') { stopPoll(); slot.replaceChildren(notice('error', error.message)); } else if (!auto) showWaiting(true); return false; }
    }
    function showWaiting(stillMissing = false) {
      const dm = pendingDm(app, listing.address); if (!dm) return;
      const retry = button('Retry (check for key package)', async function () { await busy(this, 'Checking…', () => recheck(false)); }, { cls: 'btn-small' });
      slot.replaceChildren(h('div', { class: 'notice notice-warn', role: 'status' },
        h('b', {}, 'Waiting for seller to publish a Marmot key package.'),
        h('p', { class: 'small' }, `Your direct message was sent ${ago(dm.sentAt)} to ${dm.relays.length} relay(s) (${dm.source === '10050' ? 'seller inbox relays' : 'Shopstr default relays'}). This page re-checks every 15 s and starts the private group automatically when the key package appears.`),
        h('p', { class: 'small quiet' }, `“${dm.text}”`), stillMissing ? h('p', { class: 'small' }, 'Still no key package.') : null, retry));
      if (!pollTimer) pollTimer = setInterval(() => { if (!document.hidden) recheck(true); }, 15000);
      pollers.add(stopPoll);
    }
    function showDmFallback() {
      const text = h('textarea', { rows: 4, 'aria-label': 'Direct message text', class: 'dm-text' }); text.value = defaultDmText(listing.title);
      const send = button('Send direct message', async function () {
        if (!text.value.trim()) return;
        try { await busy(this, 'Sending…', () => sendListingDm({ app, listing, text: text.value.trim() })); showWaiting(); }
        catch (error) { st.replaceChildren(notice('error', error.message)); }
      }, { cls: 'btn-primary' });
      const st = h('div', { class: 'status-slot' });
      slot.replaceChildren(h('div', { class: 'notice notice-warn', role: 'status' },
        h('b', {}, 'This seller has not published a Marmot key package yet, so a private conversation cannot start.'),
        h('p', { class: 'small' }, 'You can send them an ordinary Nostr direct message (NIP-17, gift-wrapped) asking them to join. This DM is NOT end-to-end private in the Marmot sense: it is an ordinary NIP-17 message; keep details out until the seller joins Marmot. Nothing is sent until you press Send.'),
        text, h('div', { class: 'actions' }, send, button('Cancel', () => slot.replaceChildren(), { cls: 'btn-small' })), st));
    }
    if (pendingDm(app, listing.address) && !mine) queueMicrotask(() => showWaiting());
    return h('section', { class: 'detail panel' },
      h('div', { class: 'panel-title' }, h('span', {}, listing.title), h('a', { href: '#/market', class: 'panel-title-link' }, '[ back to market ]')),
      h('div', { class: 'detail-grid' },
        listingImage(listing, 'hero'),
        h('div', { class: 'detail-info' },
          h('div', { class: 'price big' }, priceLabel(listing.priceInfo, app.rates.map()).text),
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

  /** Coalesces bursts of events into one render per animation frame. */
  let rafId = 0; const cardCache = new Map();
  function draw() { if (rafId) return; rafId = requestAnimationFrame(() => { rafId = 0; drawNow(); }); }
  const cardKey = (l) => `${l.address}|${l.id}|${l.pubkey === app.identity?.pubkey}|${priceLabel(l.priceInfo, app.rates.map()).text}|${app.profiles?.get(l.pubkey)?.name || ''}`;
  function cards(list) { // reuse DOM (and <img>) of unchanged listings
    const nodes = list.map((l) => { const k = cardKey(l); let n = cardCache.get(k); if (!n) { n = card(l); cardCache.set(k, n); } return n; });
    if (cardCache.size > 600) { const live = new Set(list.map(cardKey)); for (const k of cardCache.keys()) if (!live.has(k)) cardCache.delete(k); }
    return nodes;
  }
  function drawNow() {
    const all = app.listings;
    const { shown, hidden } = filterListings(all, app.blocked);
    const searched = shown.filter((l) => !search || `${l.title} ${l.description}`.toLowerCase().includes(search));
    const { shown: visible, hidden: hiddenBy } = applyFilters(searched, active);
    const setFilter = (id, on) => { if (on) active.add(id); else active.delete(id); saveActiveFilters(storage, active); shownCount = PAGE; page = 0; draw(); };
    keep(filterBar, [...active].join(',') + '|' + app.nsfwOn, () => filterBar.replaceChildren(
      app.nsfwOn ? h('span', { class: 'chip chip-active' }, 'NSFW filter', h('button', { type: 'button', class: 'chip-x', 'aria-label': 'Remove filter NSFW filter', onClick: () => app.setNsfw(false) }, '\u2715'))
        : h('button', { type: 'button', class: 'chip chip-add', 'aria-label': 'Add filter NSFW filter', onClick: () => app.setNsfw(true) }, '+ NSFW filter'),
      ...MARKET_FILTERS.map((f) => (active.has(f.id)
        ? h('span', { class: 'chip chip-active' }, f.label, h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove filter ${f.label}`, onClick: () => setFilter(f.id, false) }, '\u2715'))
        : h('button', { type: 'button', class: 'chip chip-add', 'aria-label': `Add filter ${f.label}`, onClick: () => setFilter(f.id, true) }, `+ ${f.label}`)))));
    const noImage = hiddenBy.hasImage || 0;
    keep(imageNote, noImage, () => { imageNote.replaceChildren(noImage ? MARKET_FILTERS[0].hiddenText(noImage) + ' ' : '', noImage ? h('a', { href: '#/market', onClick: (e) => { e.preventDefault(); setFilter('hasImage', false); } }, 'Show them') : ''); });
    const exhausted = app.loader?.exhausted?.() ?? true;
    lastVisible = visible.length; lastExhausted = exhausted;
    const modeSwitch = h('label', { class: 'toggle small' }, h('input', { type: 'checkbox', checked: infinite, 'aria-label': 'Infinite scroll', onChange: (e) => { infinite = e.target.checked; storage.set('sr.infinite', infinite ? '1' : '0'); page = 0; shownCount = PAGE; budget = 3; draw(); } }), ' Infinite scroll');
    let items;
    if (infinite) {
      const upto = Math.min(shownCount, CAP, visible.length); items = visible.slice(0, upto);
      reconcile(grid, cards(items));
      const capped = visible.length > CAP && upto >= CAP; const moreLocal = upto < visible.length;
      const skeletons = (moreLocal || (!exhausted && !capped)) ? [h('div', { class: 'card card-skeleton', 'aria-hidden': 'true' }), h('div', { class: 'card card-skeleton', 'aria-hidden': 'true' })] : [];
      keep(skelRow, skeletons.length, () => skelRow.replaceChildren(...skeletons));
      keep(pager, ['i', upto, visible.length, exhausted, !!app.loader?.busy, capped, moreLocal].join('|'), () => setKids(pager, modeSwitch, h('span', { class: 'small quiet', 'data-testid': 'page-info' }, ` ${upto} of ${visible.length}${exhausted ? '' : '+'} listing${visible.length === 1 ? '' : 's'}`),
        (moreLocal || (!exhausted && !capped)) ? h('span', { class: 'small quiet loading-more', 'data-testid': 'loading-more' }, ' loading more…') : null,
        !moreLocal && exhausted && !capped ? h('span', { class: 'small quiet', 'data-testid': 'end-of-results' }, ' End of results') : null,
        capped ? h('span', { class: 'small quiet' }, ` Showing the first ${CAP}; narrow with filters or search. `, button('Back to top', () => window.scrollTo({ top: 0 }), { cls: 'btn-small' })) : null));
      sentinel.hidden = false;
    } else {
      sentinel.hidden = true;
      const pages = Math.max(1, Math.ceil(visible.length / PAGE)); if (page > pages - 1) page = pages - 1;
      items = visible.slice(page * PAGE, (page + 1) * PAGE);
      reconcile(grid, cards(items)); keep(skelRow, 0, () => skelRow.replaceChildren());
      const go = (n) => { page = n; budget = 3; draw(); window.scrollTo(0, 0); };
      keep(pager, ['c', page, pages, visible.length, exhausted, !!app.loader?.busy].join('|'), () => setKids(pager, modeSwitch, button('Previous', () => go(page - 1), { cls: 'btn-small', disabled: page === 0 }),
        h('span', { class: 'small quiet', 'data-testid': 'page-info' }, ` Page ${page + 1} of ${pages}${exhausted ? '' : '+'} · ${visible.length} listing${visible.length === 1 ? '' : 's'}${exhausted ? '' : ' so far'} `),
        button('Next', () => go(page + 1), { cls: 'btn-small', disabled: page >= pages - 1 }),
        app.loader?.busy ? h('span', { class: 'small quiet loading-more', 'data-testid': 'loading-more' }, ' loading more…') : null));
    }
    pager.hidden = !!address || !visible.length;
    if (!address) {
      app.profiles?.ensure(items.map((l) => l.pubkey));
      for (const code of new Set(items.filter((l) => l.priceInfo.kind === 'fiat').map((l) => l.priceInfo.currency))) app.rates.ensure(code);
      if (!infinite && !exhausted && !app.loader.busy && budget > 0 && visible.length < (page + 2) * PAGE) { budget--; app.loadMore(); } // classic pages: prefetch the next batch before the user gets there
      if (infinite) setTimeout(checkNear, 60);
      if (pendingScroll != null && items.length) { const y = pendingScroll; pendingScroll = null; let tries = 0; const tick = () => { window.scrollTo(0, y); if (Math.abs(scrollY - y) > 20 && tries++ < 30) setTimeout(tick, 100); }; requestAnimationFrame(tick); /* images load after the first paint: keep trying until the page is tall enough */ }
    }
    const hn = hidden ? `${hidden} listing${hidden > 1 ? 's' : ''} hidden by NSFW filter. ` : '';
    keep(hiddenNote, hn, () => { hiddenNote.replaceChildren(hn, hn ? h('a', { href: '#/identity', onClick: (e) => { e.preventDefault(); app.setNsfw(false); } }, '· Show them') : ''); });
    const statusSig = [app.listingError, app.listingsLoaded, visible.length > 0, all.length > 0 || noImage > 0].join('|');
    if (statusSig !== status.__sig) { status.__sig = statusSig;
    status.replaceChildren();
    if (app.listingError) status.append(notice('error', app.listingError, button('Retry', () => refreshBtn.click(), { cls: 'btn-small' })));
    else if (app.listingsLoaded && !visible.length) status.append(notice('info', all.length || noImage ? 'No listings match.' : 'No listings were returned by your relays. Publish one in Sell, or check Relays in Identity.'));
    else if (!app.listingsLoaded) status.append(notice('info', 'Loading listings from relays…'));
    }
    const target = address ? all.find((l) => l.address === address) : null;
    // Keep an open detail view (and any in-progress status such as the DM fallback) when background updates re-draw the market.
    if (target && !listingBlockReason(target, app.blocked) && detail.firstChild && detailSig === `${target.id}|${detailReason(target)}`) { grid.hidden = true; return; }
    if (detail.firstChild) detail.replaceChildren();
    if (address) {
      const listing = target;
      if (!listing) detail.append(notice('warn', app.listingsLoaded ? 'That listing was not found on your relays (it may be sold, replaced or on another relay).' : 'Loading listing…'));
      else if (listingBlockReason(listing, app.blocked)) detail.append(notice('warn', 'This listing is hidden by the NSFW filter.'));
      else { detailSig = `${listing.id}|${detailReason(listing)}`; detail.append(renderDetail(listing)); grid.hidden = true; }
    }
  }
  draw();
  const off = app.on('listings', draw);
  const offId = app.on('identity', draw);
  const offM = app.on('marmot', draw); const offP = app.on('profiles', draw); const offR = app.on('rates', draw); const offN = app.on('nsfw', draw);
  return () => { off(); offId(); offM(); offP(); offR(); offN(); io?.disconnect(); removeEventListener('scroll', checkNear); pollers.forEach((f) => f()); };
}

export { fetchListings };
