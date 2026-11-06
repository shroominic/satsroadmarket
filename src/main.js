import { SimplePool } from 'nostr-tools/pool';
import { loadIdentity, loadRelays, probeRelay, signerFor, shortKey, storage, npubOf } from './lib/nostr.js';
import { DEFAULT_BLOCKED } from './lib/filter.js';
import { fetchListings } from './marketplace/listings.js';
import { mountMarket } from './marketplace/view.js';
import { mountSell } from './marketplace/sell.js';
import { mountChats, startConversation } from './ui/chat.js';
import { mountIdentity } from './ui/identity.js';
import { startMarmot, cashu } from './ui/adapters.js';
import { h, clear } from './ui/dom.js';

/* ---------------- app state ---------------- */
const listeners = new Map();
const app = {
  identity: loadIdentity(), signer: null, relays: loadRelays(), pool: new SimplePool({ enablePing: true, enableReconnect: true }),
  relayStatus: new Map(), marmot: null, marmotState: { status: 'off', error: '' },
  listings: [], listingsLoaded: false, listingError: '', blocked: DEFAULT_BLOCKED, selectedGroup: '',
  on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); },
  emit(name) { for (const fn of [...(listeners.get(name) || [])]) { try { fn(); } catch (e) { console.error(e); } } },
  relayList() { return [...this.relays]; },
};
app.signer = app.identity && signerFor(app.identity);
app.reloadBlocked = () => { app.blocked = [...DEFAULT_BLOCKED, ...storage.getJSON('sr.blocked.extra', [])]; app.emit('listings'); };
app.reloadBlocked();
app.startConversation = (listing) => startConversation(app, listing);

app.setIdentity = (identity) => { app.identity = identity; app.signer = identity && signerFor(identity); app.selectedGroup = ''; app.restartMarmot(); app.emit('identity'); renderChrome(); route(); };
app.setRelays = (relays) => { app.relays = relays; app.emit('relays'); app.probeRelays(); app.restartMarmot(); app.refreshListings(); renderChrome(); };

/* ---------------- relays ---------------- */
let probing = false;
app.probeRelays = async () => {
  if (probing) return; probing = true;
  try { const results = await Promise.all(app.relays.map((u) => probeRelay(u))); app.relayStatus = new Map(results.map((r) => [r.url, r])); }
  finally { probing = false; app.emit('relayStatus'); renderChrome(); }
};

/* ---------------- listings ---------------- */
let loadingListings = null;
app.refreshListings = () => {
  loadingListings ||= (async () => {
    try {
      app.listingError = '';
      if (!app.relays.length) throw new Error('No relays configured.');
      app.listings = await fetchListings({ pool: app.pool, relays: app.relays });
      if (!app.listings.length && app.relayStatus.size && ![...app.relayStatus.values()].some((r) => r.state === 'online')) app.listingError = 'None of your relays is reachable, so no listings could be loaded. Check Identity → Relays.';
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
    const instance = await startMarmot({ privateKey: app.identity.sk, relays: app.relays,
      onChange: () => { if (run === marmotRun) app.emit('marmot'); },
      onError: (error) => { if (run === marmotRun) { app.marmotState = { ...app.marmotState, warn: error.message }; app.emit('marmotState'); } } });
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
  try { const out = await mine.publishKeyPackage(); app.keyPackage = { status: out?.ok === false ? 'error' : 'ok', error: out?.ok === false ? 'No relay acknowledged the key package.' : '', results: out?.keyPackage?.results || null }; }
  catch (error) { app.keyPackage = { status: 'error', error: error.message, results: error.results || null }; }
  app.emit('marmotState');
};

/* ---------------- chrome (header status) ---------------- */
function renderChrome() {
  const online = [...app.relayStatus.values()].filter((r) => r.state === 'online').length;
  const relayEl = document.getElementById('relay-status');
  if (relayEl) { relayEl.textContent = app.relayStatus.size ? `Relays ${online}/${app.relays.length}` : 'Relays checking…'; relayEl.className = `led ${app.relayStatus.size ? (online ? 'led-ok' : 'led-bad') : ''}`; }
  const m = document.getElementById('marmot-status');
  if (m) { m.textContent = `Marmot ${app.marmotState.status}`; m.className = `led ${app.marmotState.status === 'ready' ? 'led-ok' : app.marmotState.status === 'error' ? 'led-bad' : ''}`; }
  const who = document.getElementById('who');
  if (who) who.textContent = app.identity ? shortKey(app.identity.npub) : 'no identity';
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
setInterval(() => app.probeRelays(), 20000);
setInterval(() => { if (!document.hidden) app.refreshListings(); }, 30000);
globalThis.__satsroad = app; // debugging aid for local demos
