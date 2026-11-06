import { copyText, h, notice, button, busy, sats } from './dom.js';
import { DEV_FEATURES } from '../lib/flags.js';
import qrcode from 'qrcode-generator';
import { cashu, allowedMints, setAllowedMints, isTestMint, TEST_MINT, MINIBITS_MINT } from './adapters.js';
import { loadKeywords, saveKeywords, resetKeywords, parseKeywordInput, nsfwEnabled } from '../lib/filter.js';
import { forgetIdentity, identityFromSecret, newIdentity, normalizeRelay, saveIdentity, saveRelays, defaultRelays, defaultListingRelays, saveListingRelays, BROADCAST_RELAYS, storage, isLocalMode, setLocalMode, FALLBACK_RELAYS, FALLBACK_BLOSSOM, DEFAULT_BLOSSOM } from '../lib/nostr.js';

export function mountIdentity(root, app) {
  const idBox = h('section', { class: 'panel' });
  const keyBox = h('section', { class: 'panel' });
  const relayBox = h('div', {});
  const filterBox = h('section', { class: 'panel' });
  const ecashBox = h('section', { class: 'panel' });
  const modeBox = h('section', { class: 'panel' });
  root.replaceChildren(h('div', { class: 'two-col' }, h('div', {}, idBox, keyBox), h('div', {}, ...(DEV_FEATURES ? [modeBox] : []), relayBox, ecashBox, filterBox)));

  const QUOTE_KEY = 'sr.mintQuote';
  let polling = null;
  function drawEcash() {
    clearInterval(polling);
    const MINTS = [['Minibits (default)', MINIBITS_MINT], ...(DEV_FEATURES ? [['testnut (TEST, fake sats)', TEST_MINT]] : [])];
    const current = cashu.mintUrl().replace(/\/+$/, '');
    const known = MINTS.find(([, u]) => u === current);
    const select = h('select', { 'aria-label': 'Mint choice' }, ...MINTS.map(([l, u]) => h('option', { value: u }, l)), h('option', { value: '__custom' }, 'Custom mint URL…'));
    select.value = known ? known[1] : '__custom';
    const mint = h('input', { type: 'url', value: current, 'aria-label': 'Mint URL', hidden: !!known });
    const bal = h('span', { class: 'quiet small', 'data-testid': 'balance' }, 'balance: …');
    const status = h('div', { class: 'status-slot' });
    const refresh = async () => { try { bal.textContent = `wallet balance: ${sats(await cashu.balance(mint.value.trim()))}`; } catch (e) { bal.textContent = `wallet balance unavailable (${e.message})`; } };
    const applyMint = () => { cashu.setMintUrl(mint.value.trim().replace(/\/+$/, '')); app.emit('mint'); drawEcash(); };
    select.addEventListener('change', () => { if (select.value === '__custom') { mint.hidden = false; mint.value = ''; mint.focus(); } else { mint.value = select.value; applyMint(); } });
    mint.addEventListener('change', () => { try { if (!mint.value.trim()) return; const u = new URL(mint.value.trim()); if (u.protocol !== 'https:' && !(DEV_FEATURES && ['127.0.0.1', 'localhost'].includes(u.hostname))) throw new Error('Mints must use https://.'); applyMint(); } catch (e) { status.replaceChildren(notice('error', e.message || 'Not a valid URL.')); } });
    refresh();
    const mintUrl = () => mint.value.trim().replace(/\/+$/, '');

    // --- Add funds: NUT-04 mint quote -> Lightning invoice (text + QR) -> poll -> store proofs. We never pay it. ---
    const fundBox = h('div', { class: 'fund-box' });
    const amountIn = h('input', { type: 'number', min: 1, step: 1, value: 1000, 'aria-label': 'Amount in sats', inputMode: 'numeric' });
    const showQuote = (q) => {
      const svg = (() => { const qr = qrcode(0, 'L'); qr.addData(q.request.toUpperCase()); qr.make(); return qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true }); })();
      const box = h('div', { class: 'invoice' });
      box.innerHTML = svg; box.firstChild?.setAttribute?.('aria-label', 'Lightning invoice QR code');
      const pstat = h('div', { class: 'status-slot' }, notice('info', 'Waiting for payment… (checks every 3 s)'));
      const check = async () => {
        try {
          const r = await cashu.checkAndMintQuote(q.mint, q.amount, q.quote);
          if (r.state === 'ISSUED') { clearInterval(polling); storage.del(QUOTE_KEY); fundBox.replaceChildren(notice('ok', r.amount ? `Paid. ${sats(r.amount)} added to your wallet.` : (r.note || 'Already issued.'))); refresh(); }
          else if (r.state === 'UNPAID' || r.state === 'PENDING') pstat.replaceChildren(notice('info', 'Waiting for payment… (checks every 3 s)'));
          else pstat.replaceChildren(notice('warn', `Quote state: ${r.state}`));
        } catch (e) { pstat.replaceChildren(notice('warn', `Could not check the quote yet: ${e.message}`)); }
      };
      fundBox.replaceChildren(h('p', { class: 'small' }, `Pay this Lightning invoice for ${sats(q.amount)} from your own wallet. This app never pays it for you.`),
        box, h('code', { class: 'mono wrap invoice-text', 'data-testid': 'invoice' }, q.request),
        h('div', { class: 'actions' }, button('Copy invoice', async function () { this.textContent = (await copyText(q.request)) ? 'Copied' : 'Copy failed'; }, { cls: 'btn-small' }), button('Check now', check, { cls: 'btn-small' }), button('Cancel', () => { clearInterval(polling); storage.del(QUOTE_KEY); fundBox.replaceChildren(); }, { cls: 'btn-small' })), pstat);
      clearInterval(polling); polling = setInterval(check, 3000); check();
    };
    const saved = storage.getJSON(QUOTE_KEY, null);
    if (saved && saved.mint === mintUrl()) showQuote(saved);
    const addFunds = button('Add funds (Lightning invoice)', async function () {
      status.replaceChildren();
      try {
        const q = await busy(this, 'Requesting invoice…', () => cashu.createMintQuote(mintUrl(), Number(amountIn.value)));
        storage.setJSON(QUOTE_KEY, q); showQuote(q);
      } catch (e) { status.replaceChildren(notice('error', `Could not get an invoice: ${e.message}`)); }
    }, { cls: 'btn-primary btn-small' });

    // --- Receive a pasted token ---
    const tokenIn = h('textarea', { rows: 2, class: 'mono', placeholder: 'Paste a cashuB… token to add it to this wallet', 'aria-label': 'Token to receive' });
    const receive = button('Receive token', async function () {
      try { const r = await busy(this, 'Receiving…', () => cashu.receiveToken(tokenIn.value)); tokenIn.value = ''; status.replaceChildren(notice('ok', `Received ${sats(r.amount)} at ${r.mint}.`)); refresh(); }
      catch (e) { status.replaceChildren(notice('error', e.message)); }
    }, { cls: 'btn-small' });

    const test = DEV_FEATURES && isTestMint(mintUrl());
    const fund = DEV_FEATURES && test ? button('Fund TEST wallet +1000 test sats', async function () {
      status.replaceChildren(notice('info', 'Minting…'));
      try { await busy(this, 'Minting…', () => cashu.fundTestWallet(mintUrl(), 1000)); status.replaceChildren(notice('ok', 'Funded.')); refresh(); }
      catch (e) { status.replaceChildren(notice('error', `Could not fund: ${e.message}`)); }
    }, { cls: 'btn-small' }) : null;
    const list = allowedMints();
    const accept = h('input', { type: 'url', placeholder: 'https://mint.example.com  (extra mint to accept as a seller)', 'aria-label': 'Accepted mint to add' });
    const addAccept = button('Accept mint', () => { try { const u = new URL(accept.value.trim()); if (u.protocol !== 'https:' && !(DEV_FEATURES && ['127.0.0.1', 'localhost'].includes(u.hostname))) throw new Error('Mints must use https://.'); setAllowedMints([...list, u.href]); drawEcash(); } catch (e) { status.replaceChildren(notice('error', e.message || 'Not a valid mint URL.')); } }, { cls: 'btn-small' });
    ecashBox.replaceChildren(h('div', { class: 'panel-title' }, h('span', {}, 'Ecash wallet (Cashu)'), test ? h('span', { class: 'pill pill-wait' }, 'TEST MINT, sats have no value') : null),
      h('div', { class: 'panel-body' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Mint (sellers redeem here; buyers pay from here)'), select, mint, h('span', { class: 'hint' }, 'Tokens are stored unencrypted in this browser (IndexedDB). Use small amounts.')),
        h('div', { class: 'row-inline' }, bal), fund ? h('div', { class: 'actions' }, fund) : null,
        h('div', { class: 'row-inline' }, h('label', { class: 'small' }, 'Sats ', amountIn), addFunds), fundBox,
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Receive ecash'), tokenIn), h('div', { class: 'actions' }, receive), status,
        h('p', { class: 'small quiet' }, 'Seller allow-list (tokens from any other mint are rejected):'),
        h('ul', { class: 'relay-list' }, ...list.map((u) => h('li', {}, h('span', { class: 'mono grow' }, u), DEV_FEATURES && isTestMint(u) ? h('span', { class: 'small quiet' }, 'test') : null,
          list.length > 1 && u !== mintUrl() ? h('button', { type: 'button', class: 'btn btn-link', onClick: () => { setAllowedMints(list.filter((x) => x !== u)); drawEcash(); } }, 'remove') : null))),
        h('div', { class: 'row-inline' }, accept, addAccept)));
  }

  function drawMode() {
    const local = isLocalMode();
    modeBox.replaceChildren(h('div', { class: 'panel-title' }, h('span', {}, 'Network mode')),
      h('div', { class: 'panel-body' },
        h('p', {}, 'Mode: ', h('span', { class: `pill pill-${local ? 'wait' : 'ok'}` }, local ? 'LOCAL DEMO (127.0.0.1 relay + mint)' : 'PUBLIC (real relays and mint)')),
        h('p', { class: 'small quiet' }, local ? 'Uses ws://127.0.0.1:7777 and http://127.0.0.1:3338 (npm run relay, npm run mint). Offline demo fallback only.' : `Uses ${app.relays.length} messaging relays and ${app.listingRelays.length} listing relays and the public test mint. Blossom default: ${DEFAULT_BLOSSOM}.`),
        h('div', { class: 'actions' }, button(local ? 'Switch to PUBLIC mode' : 'Switch to LOCAL demo mode', () => { setLocalMode(!local); location.reload(); }, { cls: 'btn-small' }))));
  }

  function drawIdentity() {
    const id = app.identity;
    const status = h('div', { class: 'status-slot' });
    const imp = h('input', { type: 'password', placeholder: 'nsec1… or 64 hex characters', autocomplete: 'off', 'aria-label': 'Private key to import' });
    const importBtn = button('Import', () => {
      try {
        const next = identityFromSecret(imp.value);
        if (id && !confirm('Replace the identity stored in this browser? Back up the current nsec first.')) return;
        saveIdentity(next); app.setIdentity(next);
      } catch (error) { status.replaceChildren(notice('error', error.message)); }
    }, { cls: 'btn-small' });
    const body = [h('div', { class: 'panel-title' }, h('span', {}, 'Identity'))];
    if (id) {
      let shown = false;
      const nsecOut = h('code', { class: 'mono wrap secret' }, '•••••••• hidden ••••••••');
      const reveal = button('Reveal nsec', () => { shown = !shown; nsecOut.textContent = shown ? id.nsec : '•••••••• hidden ••••••••'; reveal.textContent = shown ? 'Hide nsec' : 'Reveal nsec'; }, { cls: 'btn-small' });
      body.push(h('div', { class: 'panel-body' },
        h('p', { class: 'small quiet' }, 'Your public key (share it):'), h('code', { class: 'mono wrap' }, id.npub),
        h('div', { class: 'actions' }, button('Copy npub', async function () { this.textContent = (await copyText(id.npub)) ? 'Copied' : 'Copy failed'; }, { cls: 'btn-small' })),
        h('p', { class: 'small quiet' }, 'Your private key is stored in this browser profile only. Anyone with it controls your identity and your Marmot groups. Back it up.'),
        nsecOut, h('div', { class: 'actions' }, reveal, button('Copy nsec', async function () { this.textContent = (await copyText(id.nsec)) ? 'Copied' : 'Copy failed'; }, { cls: 'btn-small' }),
          button('Forget identity', () => { if (confirm('Remove the key from this browser? Without a backup, this identity is lost.')) { forgetIdentity(); app.setIdentity(null); } }, { cls: 'btn-small btn-danger' }))));
    } else {
      body.push(h('div', { class: 'panel-body' }, h('p', {}, 'No identity in this browser yet. Generate a fresh Nostr key or import an existing nsec.'),
        h('div', { class: 'actions' }, button('Generate new identity', () => { try { const next = newIdentity(); saveIdentity(next); app.setIdentity(next); } catch (e) { status.replaceChildren(notice('error', e.message)); } }, { cls: 'btn-primary' }))));
    }
    body.push(h('div', { class: 'panel-body' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, id ? 'Import a different nsec' : 'Import an nsec'), imp), h('div', { class: 'actions' }, importBtn), status));
    idBox.replaceChildren(...body);
  }

  function drawKeyPackage() {
    const s = app.marmotState; const status = h('div', { class: 'status-slot' });
    const publish = button('Publish key package', async () => { await busy(publish, 'Publishing…', () => app.publishKeyPackage()); }, { cls: 'btn-primary', disabled: s.status !== 'ready' });
    const kp = app.keyPackage;
    const c = app.conn || { connected: 0, total: 0, reasons: {} };
    const disconnected = s.status === 'ready' && c.total > 0 && c.connected === 0;
    const connLabel = s.status !== 'ready' ? s.status.toUpperCase() : disconnected ? 'DISCONNECTED' : 'READY';
    const connBox = (s.status === 'ready' && c.total > 0 && c.connected < c.total)
      ? h('div', { class: `notice notice-${disconnected ? 'error' : 'warn'}`, role: 'status', 'data-testid': 'conn-note' },
          h('span', { class: 'notice-text' }, disconnected ? `Can't reach messaging relays (0/${c.total}). Retrying automatically with increasing delays.` : `Connected to ${c.connected}/${c.total} messaging relays. The others are retrying.`),
          button('Retry now', () => { app.probeRelays(); app.restartMarmot(); }, { cls: 'btn-small' }),
          h('details', { class: 'small' }, h('summary', {}, 'Details'), h('ul', {}, ...Object.entries(c.reasons).map(([u, why]) => h('li', {}, h('span', { class: 'mono' }, u), ` \u2014 ${why}`)))))
      : null;
    const ackLines = kp.results ? Object.entries(kp.results).map(([relay, r]) => h('li', { class: r?.ok ? 'ack-ok' : 'ack-bad' }, h('b', {}, r?.ok ? 'ACK ' : 'REJECTED '), h('span', { class: 'mono' }, relay), ` — ${r?.message || ''}`)) : [];
    if (kp.status === 'ok') status.replaceChildren(notice('ok', 'Key package is on at least one relay. Buyers can invite you.'));
    else if (kp.status === 'publishing') status.replaceChildren(notice('info', 'Publishing key package…'));
    else if (kp.status === 'error') status.replaceChildren(notice('error', `Key package NOT published: ${kp.error} Buyers will see “seller not reachable”.`));
    if (ackLines.length) status.append(h('ul', { class: 'acks' }, ackLines));
    keyBox.replaceChildren(h('div', { class: 'panel-title' }, h('span', {}, 'Private messaging (Marmot / MLS)')),
      h('div', { class: 'panel-body' },
        h('p', {}, 'Status: ', h('span', { class: `pill pill-${connLabel === 'READY' ? 'ok' : s.status === 'error' || connLabel === 'DISCONNECTED' ? 'bad' : 'wait'}`, 'data-testid': 'marmot-pill' }, connLabel)),
        connBox,
        s.error ? notice('error', s.error, button('Retry', () => app.restartMarmot(), { cls: 'btn-small' })) : null,
        s.warn ? notice('warn', s.warn) : null,
        h('p', { class: 'small quiet' }, 'Sellers need a published key package so buyers can invite them. It is published automatically when messaging starts; use the button to republish.'),
        h('div', { class: 'actions' }, publish), status));
  }

  const drafts = { marmot: '', listing: '' };
  function relayPanel(kind, { title, blurb, get, set, save, defaults, extras }) {
    const status = h('div', { class: 'status-slot' });
    const input = h('input', { type: 'text', placeholder: 'wss://relay.example.com', 'aria-label': `${title} relay address`, autocomplete: 'off' });
    const commit = (list) => { save(list); set(list); drafts[kind] = ''; };
    const list = get();
    const add = button('Add relay', () => { try { const url = normalizeRelay(input.value); if (list.includes(url)) throw new Error('That relay is already in the list.'); commit([...list, url]); input.value = ''; } catch (e) { status.replaceChildren(notice('error', e.message)); } }, { cls: 'btn-small' });
    input.value = drafts[kind]; input.addEventListener('input', () => { drafts[kind] = input.value; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add.click(); } });
    const rows = list.map((url) => {
      const st = app.relayStatus.get(url);
      return h('li', {}, h('span', { class: `dot dot-${st?.state || 'unknown'}`, 'aria-hidden': 'true' }), h('span', { class: 'mono grow' }, url),
        h('span', { class: 'small quiet' }, st ? (st.state === 'online' ? `online · ${st.ms} ms` : `OFFLINE · ${st.error}`) : 'checking…'),
        h('button', { type: 'button', class: 'btn btn-link', 'aria-label': `Remove ${url}`, onClick: () => commit(list.filter((r) => r !== url)) }, 'remove'));
    });
    return h('section', { class: 'panel', 'data-relay-panel': kind }, h('div', { class: 'panel-title' }, h('span', {}, title)),
      h('div', { class: 'panel-body' }, h('p', { class: 'small quiet' }, blurb), h('ul', { class: 'relay-list' }, ...rows),
        list.length ? null : notice('error', 'No relays configured here: this part cannot work.'),
        extras?.length ? h('p', { class: 'small quiet' }, `Also written to (write-only broadcast): ${extras.join(', ')}`) : null,
        h('div', { class: 'row-inline' }, input, add), status,
        h('div', { class: 'actions' }, button('Re-check now', () => app.probeRelays(), { cls: 'btn-small' }), button('Reset to defaults', () => commit(defaults()), { cls: 'btn-small' }), ...FALLBACK_RELAYS.filter((r) => kind === 'marmot' && !list.includes(r)).map((r) => button(`Add fallback ${r.replace('wss://', '')}`, () => commit([...list, r]), { cls: 'btn-small' })))));
  }
  function drawRelays() {
    const rsig = JSON.stringify([app.relays, app.listingRelays, [...app.relayStatus].map(([u, v]) => [u, v.state, v.error])]);
    if (rsig === relayBox.__sig) return; relayBox.__sig = rsig; // latency-only changes do not rebuild the panel (keeps focus and typed text)
    const active = document.activeElement; const focused = relayBox.contains(active) && active?.tagName === 'INPUT' ? active.getAttribute('aria-label') : null;
    relayBox.replaceChildren(
      relayPanel('marmot', { title: 'Messaging relays (Marmot)', blurb: 'Key packages, invites and encrypted group messages (kinds 443/444/445/1059/10050/10002/30443). Only relays that passed the compatibility probe (docs/RELAY_PROBE.md). Changing these restarts private messaging.', get: () => app.relays, set: (l) => app.setRelays(l), save: saveRelays, defaults: defaultRelays }),
      relayPanel('listing', { title: 'Listing relays (Shopstr)', blurb: 'Public NIP-99 listings (kind 30402). Defaults are Shopstr\u2019s own relays, so Shopstr listings show up here and yours show up there.', get: () => app.listingRelays, set: (l) => app.setListingRelays(l), save: saveListingRelays, defaults: defaultListingRelays, extras: isLocalMode() ? [] : BROADCAST_RELAYS }));
    if (focused) relayBox.querySelector(`input[aria-label="${focused}"]`)?.focus();
  }

  function drawFilter() {
    const words = loadKeywords(storage); const on = nsfwEnabled(storage);
    const input = h('input', { type: 'text', placeholder: 'add keywords, separated by commas', 'aria-label': 'NSFW keywords to add', autocomplete: 'off' });
    const add = () => { const more = parseKeywordInput(input.value); if (!more.length) return; saveKeywords(storage, [...words, ...more]); app.reloadBlocked(); drawFilter(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    filterBox.replaceChildren(h('div', { class: 'panel-title' }, h('span', {}, 'NSFW keywords')),
      h('div', { class: 'panel-body' },
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: on, 'aria-label': 'NSFW filter on', onChange: (e) => { app.setNsfw(e.target.checked); } }), ' NSFW filter on'),
        h('p', { class: 'small quiet' }, 'Listings whose title, summary, tags or text contain one of these words are hidden on this screen, and text containing them cannot be published from here. Matching is whole-word. This does not remove anything from relays; it only changes what you see.'),
        h('p', {}, ...words.map((w) => h('span', { class: 'chip' }, w, h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove ${w}`, onClick: () => { saveKeywords(storage, words.filter((x) => x !== w)); app.reloadBlocked(); drawFilter(); } }, '\u2715')))),
        h('div', { class: 'row-inline' }, input, button('Add', add, { cls: 'btn-small' })),
        h('div', { class: 'actions' }, button('Reset to defaults', () => { resetKeywords(storage); app.reloadBlocked(); drawFilter(); }, { cls: 'btn-small' }))));
  }

  const draw = () => { if (DEV_FEATURES) drawMode(); drawIdentity(); drawKeyPackage(); drawRelays(); drawEcash(); drawFilter(); };
  draw();
  const offs = [app.on('relays', drawRelays), app.on('relayStatus', drawRelays), app.on('identity', draw), app.on('marmotState', drawKeyPackage)];
  return () => offs.forEach((o) => o());
}
