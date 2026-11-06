import { SimplePool } from 'nostr-tools/pool';
import { DEV_FEATURES } from './lib/flags.js';
import { isLocalMode, loadIdentity, loadRelays, loadListingRelays, BROADCAST_RELAYS, probeRelay, signerFor, shortKey, storage, npubOf } from './lib/nostr.js';
import { DEFAULT_BLOCKED, loadKeywords, nsfwEnabled, setNsfwEnabled } from './lib/filter.js';
import { createRateService } from './lib/money.js';
import { createDmTransport } from './marketplace/dmchat.js';
import { createSupportCache } from './marketplace/marmotSupport.js';
import { createListingLoader, createProfileCache } from './marketplace/loader.js';
import { mountMarket } from './marketplace/view.js';
import { mountSell } from './marketplace/sell.js';
import { mountStatus } from './ui/status.js';
import { mountChats, startConversation, startDmConversation } from './ui/chat.js';
import { mountIdentity } from './ui/identity.js';
import { startMarmot, cashu, isTestMint } from './ui/adapters.js';
import { h, clear } from './ui/dom.js';

/* ---------------- app state ---------------- */
const listeners = new Map();
const app = {
  identity: loadIdentity(), signer: null, relays: loadRelays(), listingRelays: loadListingRelays(), pool: new SimplePool({ enablePing: true, enableReconnect: true, maxWaitForConnection: 15000 }),
  relayStatus: new Map(), marmot: null, marmotState: { status: 'off', error: '' },
  listings: [], listingsLoaded: false, listingError: '', blocked: DEFAULT_BLOCKED, selectedGroup: '',
  on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); },
  emit(name) { for (const fn of [...(listeners.get(name) || [])]) { try { fn(); } catch (e) { console.error(e); } } },
  relayList() { return [...new Set([...this.listingRelays, ...(isLocalMode() ? [] : BROADCAST_RELAYS)])]; },
};
app.signer = app.identity && signerFor(app.identity);
/* IndexedDB (localforage) key-value wrapper that never throws */
const idb = (name) => { let inst; const get = async () => (inst ||= (await import('localforage')).default.createInstance({ name })); return { get: async (k) => { try { return await (await get()).getItem(k); } catch { return null; } }, set: async (k, v) => { try { await (await get()).setItem(k, v); } catch { /* storage blocked or full */ } } }; };
const listingStorage = idb('satsroad-listings'); const profileStorage = idb('satsroad-profiles');
function makeLoader() {
  app.cacheTried = false;
  app.loader?.stop();
  app.loader = createListingLoader({ pool: app.pool, relays: app.listingRelays, storage: listingStorage, onChange: () => { app.listings = app.loader.listings(); app.emit('listings'); } });
  app.profiles = createProfileCache({ pool: app.pool, relays: app.listingRelays, storage: profileStorage, onChange: () => app.emit('profiles') });
}
app.rates = createRateService({ storage, onChange: () => app.emit('rates') });
const makeSupport = () => { app.support = createSupportCache({ pool: app.pool, relays: app.relays, storage, onChange: () => app.emit('support') }); };
makeSupport();
function makeDm() {
  app.dm?.stop(); app.dm = null; if (!app.identity) return;
  app.dm = createDmTransport({ pool: app.pool, identity: app.identity, storage: idb('satsroad-dm'), getRelays: () => ({ lookup: [...new Set([...app.listingRelays, ...app.relays])], defaults: app.listingRelays }), onChange: () => app.emit('dm') });
  app.dm.load().then(() => app.dm?.start());
}
makeDm();
makeLoader();
app.loadMore = () => app.loader.more(2);
app.reloadBlocked = () => { app.nsfwOn = nsfwEnabled(storage); app.blocked = app.nsfwOn ? loadKeywords(storage) : []; app.publishBlocked = [...new Set([...DEFAULT_BLOCKED, ...loadKeywords(storage)])]; app.emit('listings'); app.emit('nsfw'); };
app.setNsfw = (on) => { setNsfwEnabled(storage, on); app.reloadBlocked(); };
app.reloadBlocked();
app.startConversation = (listing) => startConversation(app, listing);
app.startDmConversation = (listing) => startDmConversation(app, listing);

app.setIdentity = (identity) => { app.identity = identity; app.signer = identity && signerFor(identity); makeDm(); app.selectedGroup = ''; app.restartMarmot(); app.emit('identity'); renderChrome(); route(); };
app.setListingRelays = (relays) => { app.listingRelays = relays; makeLoader(); makeDm(); app.emit('relays'); app.probeRelays(); app.refreshListings(); renderChrome(); };
app.setRelays = (relays) => { app.relays = relays; makeSupport(); makeDm(); app.emit('relays'); app.probeRelays(); app.restartMarmot(); app.refreshListings(); renderChrome(); };

/* ---------------- relays ---------------- */
let probing = false;
app.probeRelays = async () => {
  if (probing) return; probing = true;
  try {
    const urls = [...new Set([...app.relays, ...app.relayList()])]; const pending = [];
    for (const u of urls) { pending.push(probeRelay(u, app.pool)); await new Promise((r) => setTimeout(r, 120)); } // staggered connects share the pool's sockets
    app.relayStatus = new Map((await Promise.all(pending)).map((r) => [r.url, r]));
  } finally { probing = false; app.emit('relayStatus'); updateConnection(); renderChrome(); }
};

/* ---------------- messaging connection state ---------------- */
/** Real connection state of the messaging relays, from the shared pool (not from Marmot's "started" flag). */
app.conn = { connected: 0, total: 0, reasons: {}, since: Date.now() };
const closeReasons = {};
function updateConnection() {
  const status = app.pool.listConnectionStatus?.() || new Map();
  const norm = (u) => u.replace(/\/$/, '');
  const live = new Map([...status].map(([u, ok]) => [norm(u), ok]));
  const connected = app.relays.filter((u) => live.get(norm(u))).length;
  const reasons = {};
  for (const u of app.relays) if (!live.get(norm(u))) reasons[u] = closeReasons[norm(u)] || app.relayStatus.get(u)?.error || 'not connected yet';
  const restored = app.conn.connected === 0 && connected > 0 && app.conn.total > 0;
  const changed = connected !== app.conn.connected || app.relays.length !== app.conn.total;
  app.conn = { connected, total: app.relays.length, reasons, since: changed ? Date.now() : app.conn.since };
  if (changed) { app.emit('marmotState'); renderChrome(); }
  if (restored) { app.retryOutbox(); if (app.keyPackage.status === 'error' || app.keyPackage.status === 'idle') app.publishKeyPackage(); }
}
/** Messages saved while relays were unreachable are re-sent (same rumor id) once a relay is connected again. */
app.retryOutbox = async () => {
  const m = app.marmot; if (!m || app.retryingOutbox) return; app.retryingOutbox = true;
  try { for (const g of await m.listGroups()) { if ((await m.outbox(g.id)).length) { try { await m.retryPending(g.id); } catch { /* still unreachable: next restore tries again */ } } } app.emit('marmot'); }
  finally { app.retryingOutbox = false; }
};
addEventListener('online', () => { app.probeRelays(); app.retryOutbox(); });

/* ---------------- listings ---------------- */
let loadingListings = null;
app.refreshListings = () => {
  loadingListings ||= (async () => {
    try {
      app.listingError = '';
      if (!app.listingRelays.length) throw new Error('No listing relays configured.');
      if (!app.cacheTried) { app.cacheTried = true; await app.profiles.load(); if (await app.loader.loadCache()) { app.listings = app.loader.listings(); app.listingsLoaded = true; app.emit('listings'); } }
      await app.loader.initial(); app.listings = app.loader.listings();
      if (!app.bgRun) { app.bgRun = true; (async () => { for (let i = 0; i < 3 && !app.loader.exhausted(); i++) { await new Promise((r) => setTimeout(r, 2000)); await app.loader.more(1); } app.bgRun = false; })(); }
      if (!app.listings.length && app.relayStatus.size && !app.listingRelays.some((u) => app.relayStatus.get(u)?.state === 'online')) app.listingError = 'None of your relays is reachable, so no listings could be loaded. Check Identity → Relays.';
    } catch (error) { app.listingError = `Could not load listings: ${error.message}`; }
    finally { app.listingsLoaded = true; loadingListings = null; app.emit('listings'); }
  })();
  return loadingListings;
};

/* ---------------- marmot ---------------- */
let marmotRun = 0;
app.restartMarmot = async () => {
  const run = ++marmotRun;
  app.marmot?.stop(); app.marmot = null;
  if (!app.identity || !app.relays.length) { app.marmotState = { status: 'off', error: '' }; app.emit('marmotState'); app.emit('marmot'); renderChrome(); return; }
  app.marmotState = { status: 'starting', error: '' }; app.emit('marmotState'); renderChrome();
  try {
    const instance = await startMarmot({ privateKey: app.identity.sk, relays: app.relays, pool: app.pool,
      onChange: () => { if (run === marmotRun) app.emit('marmot'); },
      onError: (error) => { if (run !== marmotRun) return; for (const r of error.reasons || []) if (r.url) closeReasons[r.url.replace(/\/$/, '')] = String(r.reason || 'closed'); updateConnection(); app.emit('marmotState'); } });
    if (run !== marmotRun) { instance.stop(); return; }
    app.marmot = instance; app.marmotState = { status: 'ready', error: '' };
    app.publishKeyPackage();
  } catch (error) { if (run === marmotRun) app.marmotState = { status: 'error', error: error.message }; }
  app.emit('marmotState'); app.emit('marmot'); renderChrome();
};

app.keyPackage = { status: 'idle', error: '', results: null };
app.publishKeyPackage = async () => {
  const mine = app.marmot; if (!mine) return;
  app.keyPackage = { status: 'publishing', error: '', results: null }; app.emit('marmotState');
  let timer;
  const overall = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('No relay answered within 40 s. Check your connection and retry.'), { code: 'TIMEOUT' })), 40000); });
  try {
    const out = await Promise.race([mine.publishKeyPackage(), overall]);
    app.keyPackage = { status: out?.ok === false ? 'error' : 'ok', error: out?.ok === false ? 'No relay acknowledged the key package.' : '', results: out?.keyPackage?.results || null };
  } catch (error) { app.keyPackage = { status: 'error', error: error.message, results: error.results || null }; }
  finally { clearTimeout(timer); }
  app.emit('marmotState');
};

/* ---------------- chrome (header status) ---------------- */
const setText = (el, text, cls) => { if (el.textContent !== text) el.textContent = text; if (cls !== undefined && el.className !== cls) el.className = cls; };
let statusUI;
function renderChrome() {
  const banner = document.getElementById('mode-banner');
  if (banner) { const mint = cashu.mintUrl(); const label = !DEV_FEATURES ? '' : isLocalMode() ? 'LOCAL DEMO MODE (local relay and mint)' : isTestMint(mint) ? 'TEST MINT, sats have no value' : ''; setText(banner, label); banner.hidden = !label; }
  (statusUI ||= mountStatus(app)).update();
}

/* ---------------- router ---------------- */
const view = document.getElementById('view');
const titles = { market: 'Marketplace', listing: 'Listing', sell: 'Sell', chats: 'Private conversations', identity: 'Identity & relays' };
let unmount = null;
function route() {
  unmount?.(); unmount = null;
  const [, page = 'market', param] = location.hash.split('/');
  const name = page.replace('#', '') || 'market';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (name === 'listing' ? 'market' : name)));
  clear(view);
  if (name === 'identity') { const body = h('div', {}); view.append(h('h2', { class: 'page-title' }, titles.identity), body); unmount = mountIdentity(body, app); window.scrollTo(0, 0); return; }
  const panel = h('section', { class: 'panel main-panel' }, h('div', { class: 'panel-title' }, h('span', {}, titles[name] || 'Marketplace')));
  const body = h('div', { class: 'panel-body' });
  panel.append(body);
  view.append(panel);
  if (name === 'sell') unmount = mountSell(body, app);
  else if (name === 'chats') unmount = mountChats(body, app);
  else unmount = mountMarket(body, app, { address: name === 'listing' && param ? decodeURIComponent(param) : '' });
  window.scrollTo(0, 0);
}
addEventListener('hashchange', route);

/* ---------------- boot ---------------- */
renderChrome(); route();
cashu.preload();
app.probeRelays().then(() => app.refreshListings());
app.restartMarmot();
setInterval(() => { if (!document.hidden) app.probeRelays(); }, 60000);
setInterval(updateConnection, 3000);
setInterval(() => { if (!document.hidden) app.refreshListings(); }, 30000);
globalThis.__satsroad = app; // debugging aid
