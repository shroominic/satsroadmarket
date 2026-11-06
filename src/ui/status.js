/** Compact header status row: "● Marmot 5/5  ● Listings 4/5  npub1qh4j…g8j". Updates its own nodes in place; details open in a popover. */
import { h, button, notice } from './dom.js';
import { copyText } from './dom.js';
import { shortKey } from '../lib/nostr.js';

export function mountStatus(app) {
  const row = document.getElementById('status-row'); if (!row) return { update() {} };
  const items = {
    marmot: row.querySelector('#marmot-status'), listings: row.querySelector('#relay-status'), who: row.querySelector('#who'),
  };
  const pop = row.querySelector('#status-pop'); let openKey = null;
  const set = (el, { dot, label, num, aria }) => {
    const d = el.querySelector('.dot-s'); const l = el.querySelector('.st-label'); const n = el.querySelector('.st-num');
    if (d.dataset.s !== dot) { d.dataset.s = dot; d.className = `dot-s dot-s-${dot}`; }
    if (l && l.textContent !== label) l.textContent = label;
    if (n && n.textContent !== num) n.textContent = num;
    if (el.getAttribute('aria-label') !== aria) { el.setAttribute('aria-label', aria); el.title = aria; }
  };
  const up = (list) => list.filter((u) => app.relayStatus.get(u)?.state === 'online').length;
  const level = (ok, total) => (!total ? 'wait' : ok === total ? 'ok' : ok === 0 ? 'bad' : 'part');

  function update() {
    const st = app.marmotState.status; const c = app.conn || { connected: 0, total: 0 };
    if (st === 'off') set(items.marmot, { dot: 'none', label: 'Marmot', num: 'off', aria: 'Marmot messaging is off until you create an identity' });
    else if (st !== 'ready') set(items.marmot, { dot: st === 'error' ? 'bad' : 'wait', label: st === 'error' ? 'Marmot error' : 'Marmot starting', num: '', aria: `Marmot messaging: ${st}` });
    else if (c.total && c.connected === 0) set(items.marmot, { dot: 'bad', label: 'Marmot offline, retrying', num: '', aria: `Marmot messaging offline: 0 of ${c.total} relays connected, retrying` });
    else set(items.marmot, { dot: level(c.connected, c.total), label: 'Marmot', num: c.total ? `${c.connected}/${c.total}` : '', aria: `Marmot messaging: ${c.connected} of ${c.total} relays connected` });
    const lu = up(app.listingRelays); const lt = app.listingRelays.length;
    set(items.listings, { dot: app.relayStatus.size ? level(lu, lt) : 'wait', label: 'Listings', num: app.relayStatus.size ? `${lu}/${lt}` : '…', aria: `Listing relays: ${lu} of ${lt} reachable` });
    const who = app.identity ? shortKey(app.identity.npub).replace(/^(.{9}).*(.{3})$/, '$1…$2') : 'no identity';
    const w = items.who; if (w.querySelector('.st-label').textContent !== who) w.querySelector('.st-label').textContent = who;
    w.setAttribute('aria-label', app.identity ? `Your public key ${app.identity.npub}` : 'No identity yet');
    if (openKey) drawPop(openKey);
  }

  const relayLine = (u, extra) => h('li', {}, h('span', { class: `dot dot-${app.relayStatus.get(u)?.state || 'unknown'}`, 'aria-hidden': 'true' }), h('span', { class: 'mono grow' }, u.replace('wss://', '')), h('span', { class: 'small quiet' }, app.relayStatus.get(u) ? (app.relayStatus.get(u).state === 'online' ? 'online' : `OFFLINE · ${(extra && extra[u]) || app.relayStatus.get(u).error || ''}`) : 'checking…'));
  function drawPop(key) {
    const kp = app.keyPackage; let body;
    if (key === 'marmot') body = [h('b', {}, 'Messaging relays (Marmot)'), h('ul', { class: 'relay-list' }, ...app.relays.map((u) => relayLine(u, app.conn?.reasons))),
      h('p', { class: 'small' }, 'Key package: ', h('b', {}, kp.status === 'ok' ? 'published' : kp.status === 'publishing' ? 'publishing…' : kp.status === 'error' ? `not published (${kp.error})` : 'not published yet')),
      h('div', { class: 'actions' }, button('Retry connection', () => { app.probeRelays(); app.restartMarmot(); }, { cls: 'btn-small' }), button('Publish key package', () => app.publishKeyPackage(), { cls: 'btn-small' }), h('a', { class: 'btn btn-small', href: '#/identity' }, 'Relay settings'))];
    else if (key === 'listings') body = [h('b', {}, 'Listing relays (Shopstr)'), h('ul', { class: 'relay-list' }, ...app.listingRelays.map((u) => relayLine(u))),
      h('div', { class: 'actions' }, button('Re-check now', () => app.probeRelays(), { cls: 'btn-small' }), h('a', { class: 'btn btn-small', href: '#/identity' }, 'Relay settings'))];
    else body = app.identity ? [h('b', {}, 'Your public key'), h('code', { class: 'mono wrap' }, app.identity.npub), h('div', { class: 'actions' }, button('Copy npub', async function () { this.textContent = (await copyText(app.identity.npub)) ? 'Copied' : 'Copy failed'; }, { cls: 'btn-small' }), h('a', { class: 'btn btn-small', href: '#/identity' }, 'Identity'))] : [h('p', {}, 'No identity yet.'), h('a', { class: 'btn btn-small', href: '#/identity' }, 'Create one')];
    const sig = JSON.stringify([key, app.relays, app.listingRelays, [...app.relayStatus].map(([u, v]) => [u, v.state, v.error]), app.conn?.reasons, kp.status, kp.error, app.identity?.npub]);
    if (pop.__sig === sig) return; pop.__sig = sig; pop.replaceChildren(...body);
  }
  function close() { openKey = null; pop.hidden = true; for (const el of Object.values(items)) el.setAttribute('aria-expanded', 'false'); }
  for (const [key, el] of Object.entries(items)) {
    el.addEventListener('click', (e) => { e.stopPropagation(); if (openKey === key) return close(); openKey = key; pop.__sig = ''; pop.hidden = false; drawPop(key); for (const [k, x] of Object.entries(items)) x.setAttribute('aria-expanded', String(k === key)); });
  }
  document.addEventListener('click', (e) => { if (openKey && !pop.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openKey) { const k = openKey; close(); items[k].focus(); } });
  return { update };
}
