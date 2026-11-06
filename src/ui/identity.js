import { copyText, h, notice, button, busy, sats } from './dom.js';
import { cashu } from './adapters.js';
import { DEFAULT_BLOCKED } from '../lib/filter.js';
import { forgetIdentity, identityFromSecret, newIdentity, normalizeRelay, saveIdentity, saveRelays, defaultRelays, storage } from '../lib/nostr.js';

export function mountIdentity(root, app) {
  const idBox = h('section', { class: 'panel' });
  const keyBox = h('section', { class: 'panel' });
  const relayBox = h('section', { class: 'panel' });
  const filterBox = h('section', { class: 'panel' });
  const ecashBox = h('section', { class: 'panel' });
  root.replaceChildren(h('div', { class: 'two-col' }, h('div', {}, idBox, keyBox), h('div', {}, relayBox, ecashBox, filterBox)));

  function drawEcash() {
    const mint = h('input', { type: 'url', value: cashu.mintUrl(), 'aria-label': 'Mint URL' });
    const bal = h('span', { class: 'quiet small' }, 'balance: …');
    const status = h('div', { class: 'status-slot' });
    const refresh = async () => { try { bal.textContent = `wallet balance: ${sats(await cashu.balance(mint.value.trim()))}`; } catch (e) { bal.textContent = `wallet balance unavailable (${e.message})`; } };
    mint.addEventListener('change', () => { try { cashu.setMintUrl(mint.value.trim()); } catch { /* ignore */ } refresh(); }); refresh();
    const fund = button('Fund test wallet 1000 sats', async function () {
      status.replaceChildren(notice('info', 'Minting…'));
      try { cashu.setMintUrl(mint.value.trim()); await busy(this, 'Minting…', () => cashu.fundTestWallet(mint.value.trim(), 1000)); status.replaceChildren(notice('ok', 'Funded.')); refresh(); }
      catch (e) { status.replaceChildren(notice('error', `Could not fund: ${e.message} Only local FakeWallet mints (npm run mint) auto-pay.`)); }
    }, { cls: 'btn-small' });
    ecashBox.replaceChildren(h('div', { class: 'panel-title' }, h('span', {}, 'Ecash (Cashu)')),
      h('div', { class: 'panel-body' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Your mint (sellers redeem here; buyers pay from here)'), mint, h('span', { class: 'hint' }, 'Tokens are stored unencrypted in this browser (IndexedDB). Use small amounts.')), h('div', { class: 'row-inline' }, bal, fund), status));
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
    const ackLines = kp.results ? Object.entries(kp.results).map(([relay, r]) => h('li', { class: r?.ok ? 'ack-ok' : 'ack-bad' }, h('b', {}, r?.ok ? 'ACK ' : 'REJECTED '), h('span', { class: 'mono' }, relay), ` — ${r?.message || ''}`)) : [];
    if (kp.status === 'ok') status.replaceChildren(notice('ok', 'Key package is on at least one relay. Buyers can invite you.'));
    else if (kp.status === 'publishing') status.replaceChildren(notice('info', 'Publishing key package…'));
    else if (kp.status === 'error') status.replaceChildren(notice('error', `Key package NOT published: ${kp.error} Buyers will see “seller not reachable”.`));
    if (ackLines.length) status.append(h('ul', { class: 'acks' }, ackLines));
    keyBox.replaceChildren(h('div', { class: 'panel-title' }, h('span', {}, 'Private messaging (Marmot / MLS)')),
      h('div', { class: 'panel-body' },
        h('p', {}, 'Status: ', h('span', { class: `pill pill-${s.status === 'ready' ? 'ok' : s.status === 'error' ? 'bad' : 'wait'}` }, s.status.toUpperCase())),
        s.error ? notice('error', s.error, button('Retry', () => app.restartMarmot(), { cls: 'btn-small' })) : null,
        s.warn ? notice('warn', s.warn) : null,
        h('p', { class: 'small quiet' }, 'Sellers need a published key package so buyers can invite them. It is published automatically when messaging starts; use the button to republish.'),
        h('div', { class: 'actions' }, publish), status));
  }

  let relayDraft = '';
  function drawRelays() {
    const hadFocus = relayBox.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT';
    const status = h('div', { class: 'status-slot' });
    const input = h('input', { type: 'text', placeholder: 'wss://relay.example.com', 'aria-label': 'Relay address', autocomplete: 'off' });
    const commit = (list) => { saveRelays(list); app.setRelays(list); relayDraft = ''; };
    const add = button('Add relay', () => { try { const url = normalizeRelay(input.value); if (app.relays.includes(url)) throw new Error('That relay is already in the list.'); commit([...app.relays, url]); input.value = ''; } catch (e) { status.replaceChildren(notice('error', e.message)); } }, { cls: 'btn-small' });
    input.value = relayDraft; input.addEventListener('input', () => { relayDraft = input.value; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add.click(); } });
    relayBox.replaceChildren(h('div', { class: 'panel-title' }, h('span', {}, 'Relays')),
      h('div', { class: 'panel-body' },
        h('ul', { class: 'relay-list' }, ...app.relays.map((url) => {
          const st = app.relayStatus.get(url);
          return h('li', {}, h('span', { class: `dot dot-${st?.state || 'unknown'}`, 'aria-hidden': 'true' }), h('span', { class: 'mono grow' }, url),
            h('span', { class: 'small quiet' }, st ? (st.state === 'online' ? `online · ${st.ms} ms` : `OFFLINE · ${st.error}`) : 'checking…'),
            h('button', { type: 'button', class: 'btn btn-link', 'aria-label': `Remove ${url}`, onClick: () => commit(app.relays.filter((r) => r !== url)) }, 'remove'));
        })),
        app.relays.length ? null : notice('error', 'No relays configured: nothing can be loaded or published.'),
        h('div', { class: 'row-inline' }, input, add), status,
        h('div', { class: 'actions' }, button('Re-check now', () => app.probeRelays(), { cls: 'btn-small' }), button('Reset to defaults', () => commit(defaultRelays()), { cls: 'btn-small' })),
        h('p', { class: 'small quiet' }, 'ws://127.0.0.1:7777 is the local demo relay (npm run relay). Changing relays restarts private messaging.')));
    if (hadFocus) relayBox.querySelector('input[aria-label="Relay address"]')?.focus();
  }

  function drawFilter() {
    const custom = storage.getJSON('sr.blocked.extra', []);
    const input = h('input', { type: 'text', placeholder: 'add a keyword to hide', 'aria-label': 'Extra blocked keyword' });
    const add = button('Add', () => { const w = input.value.trim().toLowerCase(); if (!w) return; storage.setJSON('sr.blocked.extra', [...new Set([...custom, w])]); app.reloadBlocked(); drawFilter(); }, { cls: 'btn-small' });
    filterBox.replaceChildren(h('div', { class: 'panel-title' }, h('span', {}, 'Local keyword filter')),
      h('div', { class: 'panel-body' }, h('p', { class: 'small quiet' }, `Listings matching any of ${DEFAULT_BLOCKED.length} built-in keywords are hidden on this screen, and blocked text cannot be published from here. This does not remove anything from relays: relay providers are responsible for filtering.`),
        custom.length ? h('p', {}, 'Your keywords: ', custom.map((w) => h('span', { class: 'chip' }, w, h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove ${w}`, onClick: () => { storage.setJSON('sr.blocked.extra', custom.filter((x) => x !== w)); app.reloadBlocked(); drawFilter(); } }, '×')))) : null,
        h('div', { class: 'row-inline' }, input, add)));
  }

  const draw = () => { drawIdentity(); drawKeyPackage(); drawRelays(); drawEcash(); drawFilter(); };
  draw();
  const offs = [app.on('relays', drawRelays), app.on('relayStatus', drawRelays), app.on('identity', draw), app.on('marmotState', drawKeyPackage)];
  return () => offs.forEach((o) => o());
}
