import { cashu } from './adapters.js';
import { h, ago, sats, notice, button, busy } from './dom.js';
import { deriveOrder, parsePaymentTags, receiptRumor, requestRumor, shippedRumor, SUBJECT } from '../marketplace/orders.js';
import { shortKey, storage, npubOf } from '../lib/nostr.js';

const metaKey = (app) => `sr.groups.${app.identity.pubkey}`;
const redeemKey = (app, groupId) => `sr.redeem.${app.identity.pubkey}.${groupId}`;
const getMeta = (app) => storage.getJSON(metaKey(app), {});
const setMeta = (app, groupId, patch) => { const all = getMeta(app); all[groupId] = { ...all[groupId], ...patch }; storage.setJSON(metaKey(app), all); };
const tagOf = (r, name) => r.tags?.find((t) => t[0] === name);

/** Buyer side: create the group, invite the seller, send the order request. Honest about each stage. */
export async function startConversation(app, listing) {
  if (!app.marmot) throw new Error(`Private messaging is not running${app.marmotState.error ? `: ${app.marmotState.error}` : '.'}`);
  if (listing.price == null) throw new Error('This listing has no price, so an order cannot be started.');
  const out = await app.marmot.startConversation(listing.pubkey, { listingRef: listing.address, label: `Order: ${listing.title}`.slice(0, 60) });
  const groupId = out?.id ?? out?.groupId;
  if (!groupId) throw new Error('The Marmot module did not return a group id.');
  const orderId = crypto.randomUUID();
  setMeta(app, groupId, { listingRef: listing.address, title: listing.title, price: listing.price, seller: listing.pubkey, orderId, role: 'buyer', startedAt: Math.floor(Date.now() / 1000), inviteUndelivered: out.delivered === false, requestSent: false });
  try { await app.marmot.sendMessage(groupId, requestRumor({ orderId, listingRef: listing.address, amount: listing.price, title: listing.title })); setMeta(app, groupId, { requestSent: true }); }
  catch (error) { setMeta(app, groupId, { requestError: error.message }); }
  app.selectedGroup = groupId;
  app.emit('marmot');
  return out;
}

export function mountChats(root, app) {
  if (!app.identity) { root.replaceChildren(notice('warn', 'Create or import an identity to use private conversations.'), h('p', {}, h('a', { class: 'btn btn-primary', href: '#/identity' }, 'Identity'))); return () => {}; }
  let alive = true; let token = 0; let timer;
  const banner = h('div', { class: 'status-slot' });
  const inviteBox = h('div', { class: 'invites' });
  const listBox = h('ul', { class: 'convo-list' });
  const threadBox = h('div', { class: 'thread' });
  const head = h('div', { class: 'thread-head' });
  const timelineBox = h('div', { class: 'timeline-slot' });
  const msgBox = h('div', { class: 'messages', 'aria-live': 'polite' });
  const actionBox = h('div', { class: 'thread-actions' });
  const payBox = h('div', { class: 'pay-slot' });
  const sendStatus = h('div', { class: 'status-slot' });
  const draft = h('textarea', { rows: 2, placeholder: 'Write an encrypted message…', 'aria-label': 'Message' });
  const sendBtn = h('button', { type: 'button', class: 'btn btn-primary' }, 'Send');
  const composer = h('div', { class: 'composer' }, draft, sendBtn);
  threadBox.append(head, timelineBox, msgBox, actionBox, payBox, sendStatus, composer);
  msgBox.hidden = true; composer.hidden = true;
  root.replaceChildren(banner, h('div', { class: 'chat-layout' }, h('aside', { class: 'chat-side' }, inviteBox, h('h3', { class: 'side-title' }, 'Conversations'), listBox), threadBox));

  const me = () => app.identity.pubkey;
  let listSig = ''; let threadSig = '';
  let groups = []; let invites = []; let current = null; // current: {group, rumors, order, meta, role}

  async function loadLists() {
    if (!app.marmot) return;
    let g; let i;
    try { [g, i] = await Promise.all([app.marmot.listGroups(), app.marmot.listInvites()]); }
    catch (error) { banner.replaceChildren(notice('error', `Could not read conversations: ${error.message}`)); return; }
    const sig = JSON.stringify([g.map((x) => [x.id, x.name, x.status]), i.map((x) => [x.id, x.joinable]), app.selectedGroup]);
    groups = g; invites = i;
    if (sig !== listSig) { listSig = sig; drawLists(); }
  }
  function drawBanner() {
    const s = app.marmotState;
    banner.replaceChildren();
    if (s.status === 'starting') banner.append(notice('info', 'Private messaging is starting (loading groups, publishing your key package)…'));
    if (s.status === 'error') banner.append(notice('error', `Private messaging is not available: ${s.error}`, button('Retry', () => app.restartMarmot(), { cls: 'btn-small' })));
    if (s.status === 'off') banner.append(notice('warn', 'Private messaging is off.'));
    if (s.warn) banner.append(notice('warn', s.warn));
  }
  function drawLists() {
    inviteBox.replaceChildren();
    if (invites.length) {
      inviteBox.append(h('h3', { class: 'side-title' }, `Invites (${invites.length})`), ...invites.map((inv) => {
        const slot = h('div', { class: 'status-slot' });
        const accept = button(inv.joinable === false ? 'Cannot join' : 'Accept & join', async () => {
          try { const id = await busy(accept, 'Joining…', () => app.marmot.acceptInvite(inv.id)); app.selectedGroup = id; await loadLists(); await openGroup(id); }
          catch (error) { slot.replaceChildren(notice('error', `Could not join: ${error.message}. The invite is kept; retry later.`)); }
        }, { cls: 'btn-small btn-primary', disabled: inv.joinable === false });
        const sender = inv.from || inv.pubkey;
        return h('div', { class: 'invite' }, h('div', {}, h('b', {}, inv.group?.name || 'Invitation'), ' from ', h('span', { class: 'mono' }, sender ? shortKey(npubOf(sender)) : 'unknown sender'), inv.created_at ? ` · ${ago(inv.created_at)}` : ''),
          inv.joinable === false ? h('div', { class: 'step-error small' }, 'This invite can no longer be joined (its key package was used, rotated or is unreadable). Ask the sender to start a new conversation.') : null, accept, slot);
      }));
    } else inviteBox.append(h('p', { class: 'quiet small' }, 'No pending invites. If a buyer invited you while you were away, it appears here and can be accepted later.'));
    const meta = getMeta(app);
    listBox.replaceChildren(...(groups.length ? groups.map((g) => h('li', { class: g.id === app.selectedGroup ? 'active' : '' },
      h('button', { type: 'button', class: 'convo-btn', onClick: () => openGroup(g.id) }, h('b', {}, meta[g.id]?.title || g.name || 'Private conversation'), h('span', { class: 'small quiet' }, `${(g.members || []).length || '?'} member(s)${g.pendingWelcomes ? ' · invite pending' : ''}`)))) : [h('li', { class: 'quiet small' }, 'No conversations yet. Open a listing and start one.')]));
  }

  async function openGroup(id, force = false) {
    if (id !== app.selectedGroup) { threadSig = ''; }
    app.selectedGroup = id; storage.set(`sr.sel.${me()}`, id); const mine = ++token;
    if (force || id !== current?.id) drawLists();
    if (!app.marmot) return;
    let rumors = []; let outbox = [];
    try { rumors = await app.marmot.history(id); outbox = await app.marmot.outbox(id); }
    catch (error) { if (mine === token) { msgBox.replaceChildren(notice('error', `Could not read message history: ${error.message}`, button('Retry', () => openGroup(id), { cls: 'btn-small' }))); } return; }
    if (mine !== token || !alive) return;
    const grp = groups.find((g) => g.id === id);
    const meta = { ...(getMeta(app)[id] || {}) };
    if (!meta.seller) meta.seller = /^30402:([0-9a-f]{64}):/.exec(grp?.listingRef || '')?.[1] || '';
    const redeemRecord = storage.getJSON(redeemKey(app, id), null);
    const order = deriveOrder(rumors, { parsePayment: (r) => cashu.parseSync(r, parsePaymentTags), redeemRecord, sellerPubkey: meta.seller || '' });
    const role = (order.seller || meta.seller) === me() ? 'seller' : 'buyer';
    const sig = JSON.stringify([id, rumors.map((r) => r.id), outbox.length, redeemRecord, meta, grp?.status, order.status]);
    current = { id, rumors, order, meta, role, redeemRecord, outbox, group: grp };
    if (sig === threadSig) return;
    threadSig = sig;
    drawThread();
  }

  const listingTitle = (ref, meta) => app.listings.find((l) => l.address === ref)?.title || meta?.title || ref?.slice(0, 24) || 'unknown listing';

  function drawThread() {
    const { id, rumors, order, meta, role, group } = current;
    msgBox.hidden = false; composer.hidden = false;
    head.replaceChildren(h('h2', {}, listingTitle(order.listingRef, meta)), h('div', { class: 'small quiet' },
      `You are the ${role}. `, order.amount ? `Order ${sats(order.amount)} · ` : '', h('span', { class: `pill pill-${order.paid ? 'ok' : order.redeemFailed ? 'bad' : 'wait'}` }, order.status.toUpperCase())));
    timelineBox.replaceChildren(h('ol', { class: 'timeline' }, ...order.steps.map((s) => h('li', { class: `${s.done ? 'done' : ''} ${s.error ? 'bad' : ''}` }, h('span', { class: 'step-mark', 'aria-hidden': 'true' }, s.error ? '!' : s.done ? '✔' : '○'), h('span', {}, h('b', {}, s.label), s.at ? ` · ${ago(s.at)}` : '', s.detail ? ` · ${s.detail}` : '', s.error ? h('div', { class: 'step-error' }, s.error) : null)))));
    // messages
    msgBox.replaceChildren(...(rumors.length ? [...rumors].sort((a, b) => a.created_at - b.created_at).map((r) => messageEl(r, order, role)) : [h('p', { class: 'quiet' }, 'No messages yet.')]));
    msgBox.scrollTop = msgBox.scrollHeight;
    // action bar
    actionBox.replaceChildren();
    const notes = [];
    if (meta.inviteUndelivered && role === 'buyer') {
      const slot = h('span', {});
      const retry = button('Retry invite delivery', async () => { try { await busy(retry, 'Retrying…', () => app.marmot.retryInvite(id)); setMeta(app, id, { inviteUndelivered: false }); await openGroup(id); } catch (e) { slot.replaceChildren(notice('error', e.message)); } }, { cls: 'btn-small' });
      notes.push(notice('warn', 'The seller’s invite (Welcome) was not confirmed as delivered. They cannot read this conversation until it arrives.', retry), slot);
    }
    if (role === 'buyer' && meta.orderId && !order.steps[1].done) {
      const retry = button('Resend order request', async () => { try { await busy(retry, 'Sending…', () => app.marmot.sendMessage(id, requestRumor({ orderId: meta.orderId, listingRef: meta.listingRef, amount: meta.price, title: meta.title }))); setMeta(app, id, { requestError: '' }); await openGroup(id); } catch (e) { sendStatus.replaceChildren(notice('error', `Order request not sent: ${e.message}`)); } }, { cls: 'btn-small' });
      notes.push(notice('warn', `The order request has not been sent${meta.requestError ? ` (${meta.requestError})` : ''}.`, retry));
    }
    if (current.outbox?.length) {
      const slot = h('span', {});
      const retry = button('Retry delivery', async () => { try { await busy(retry, 'Retrying…', () => app.marmot.retryPending(id)); await openGroup(id); } catch (e) { slot.replaceChildren(notice('error', `Still not delivered: ${e.message}`)); } }, { cls: 'btn-small' });
      notes.push(notice('warn', `${current.outbox.length} message(s) saved on this device but not acknowledged by any relay yet.`, retry), slot);
    }
    actionBox.append(...notes);
    const bar = h('div', { class: 'actions' });
    if (role === 'buyer' && !order.paid) bar.append(button(order.payments.length ? 'Pay with ecash again' : 'Pay with ecash', () => openPay()));
    if (role === 'seller') {
      const pending = order.payments.filter((p) => !p.duplicate);
      if (!order.paid && pending.length) bar.append(redeemButton(pending[pending.length - 1]));
      if (!order.paid && !pending.length) bar.append(h('span', { class: 'quiet small' }, 'Waiting for the buyer’s ecash.'));
      if (order.paid && !order.fulfilled) bar.append(button('Mark fulfilled', async function () { await act(this, 'Marking…', () => app.marmot.sendMessage(id, shippedRumor({ orderId: order.orderId, listingRef: order.listingRef }))); }, { cls: 'btn-primary' }));
    }
    actionBox.append(bar);
    if (current.redeemRecord?.state === 'failed' && role === 'seller' && !order.paid) actionBox.append(notice('error', `Last redemption failed: ${current.redeemRecord.error}`));
    if (current.redeemRecord?.state === 'ok' && !order.paid && role === 'seller') {
      const slot = button('Send receipt to buyer', async function () { await act(this, 'Sending…', async () => { await app.marmot.sendMessage(id, receiptRumor({ orderId: order.orderId, listingRef: order.listingRef, amount: current.redeemRecord.amount })); storage.del(redeemKey(app, id)); }); }, { cls: 'btn-small' });
      actionBox.append(notice('warn', `Tokens were redeemed (${current.redeemRecord.amount} sats) but the buyer was not told yet.`, slot));
    }
  }

  async function act(btn, label, work) {
    sendStatus.replaceChildren();
    try { await busy(btn, label, work); await openGroup(current.id); } catch (error) { sendStatus.replaceChildren(notice('error', error.message)); }
  }

  function redeemButton(payment) {
    const btn = button(`Redeem ${payment.amount ? sats(payment.amount) : 'payment'}`, async () => {
      sendStatus.replaceChildren(notice('info', 'Contacting the mint…'));
      const { id, order } = current;
      let result;
      try { result = await busy(btn, 'Redeeming…', () => cashu.redeem(payment, { orderId: order.orderId, expectedAmount: order.amount || undefined })); }
      catch (error) {
        storage.setJSON(redeemKey(app, id), { state: 'failed', error: error.message, at: Math.floor(Date.now() / 1000) });
        sendStatus.replaceChildren(notice('error', `Redemption failed: ${error.message} The order is NOT marked paid.`));
        await openGroup(id); return;
      }
      storage.setJSON(redeemKey(app, id), { state: 'ok', amount: result.amount, at: Math.floor(Date.now() / 1000) });
      try { await app.marmot.sendMessage(id, receiptRumor({ orderId: order.orderId, listingRef: order.listingRef, amount: result.amount })); storage.del(redeemKey(app, id)); sendStatus.replaceChildren(notice('ok', `Redeemed ${result.amount} sats at the mint. Order marked paid.`)); }
      catch (error) { sendStatus.replaceChildren(notice('error', `Redeemed ${result.amount} sats, but the paid receipt could not be sent to the buyer: ${error.message}`)); }
      await openGroup(id);
    }, { cls: 'btn-primary' });
    return btn;
  }

  function messageEl(r, order, role) {
    const mineMsg = r.pubkey === me();
    const subject = tagOf(r, 'subject')?.[1];
    const parsed = subject === SUBJECT.payment ? cashu.parseSync(r, parsePaymentTags) : null;
    const dup = parsed && order.payments.find((p) => p.rumor === r || p.rumor?.id === r.id)?.duplicate;
    let body;
    if (parsed) body = h('div', { class: 'ecash' }, h('b', {}, `Ecash payment${parsed.amount ? ` — ${sats(parsed.amount)}` : ''}`), h('div', { class: 'mono small wrap' }, `${parsed.token.slice(0, 22)}…${parsed.token.slice(-6)}`), dup ? h('div', { class: 'step-error' }, 'Duplicate of an earlier token in this order.') : null, h('div', { class: 'small quiet' }, 'Bearer token. Not confirmed until the seller redeems it at the mint.'));
    else if (subject && subject !== undefined && r.tags?.some((t) => t[0] === 'order')) body = h('div', { class: 'sysmsg' }, r.content || subject);
    else body = h('div', { class: 'text' }, r.content);
    return h('div', { class: `msg ${mineMsg ? 'msg-me' : 'msg-them'}` }, h('div', { class: 'msg-meta' }, mineMsg ? 'you' : shortKey(npubOf(r.pubkey)), ' · ', ago(r.created_at)), body);
  }

  function openPay() {
    const { id, meta, order } = current;
    const expected = order.amount || meta.price;
    const tokenIn = h('textarea', { rows: 3, placeholder: 'Paste a Cashu token (cashuB…), or create one from your wallet below', 'aria-label': 'Cashu token', class: 'mono' });
    const status = h('div', { class: 'status-slot' });
    const mintUrl = h('input', { type: 'url', value: cashu.mintUrl(), 'aria-label': 'Mint URL' });
    const balance = h('span', { class: 'small quiet' }, 'wallet balance: …');
    const refreshBalance = async () => { try { balance.textContent = `wallet balance at this mint: ${sats(await cashu.balance(mintUrl.value.trim()))}`; } catch (e) { balance.textContent = `wallet balance unavailable (${e.message})`; } };
    refreshBalance(); mintUrl.addEventListener('change', refreshBalance);
    const fund = button('Fund test wallet', async function () {
      status.replaceChildren(notice('info', 'Minting test ecash (local FakeWallet mints only)…'));
      try { await busy(this, 'Minting…', () => cashu.fundTestWallet(mintUrl.value.trim(), Math.max(expected || 0, 1000))); cashu.setMintUrl(mintUrl.value.trim()); status.replaceChildren(notice('ok', 'Test wallet funded.')); refreshBalance(); }
      catch (error) { status.replaceChildren(notice('error', `Could not fund the wallet: ${error.message} Only a local FakeWallet mint (npm run mint) auto-pays; a real mint needs a Lightning payment.`)); }
    }, { cls: 'btn-small', title: 'Test only: works against a local FakeWallet mint' });
    const make = button('Create token from wallet', async function () {
      status.replaceChildren(notice('info', 'Swapping proofs at the mint…'));
      try { const out = await busy(this, 'Swapping…', () => cashu.makeToken({ mintUrl: mintUrl.value.trim(), amount: expected, orderId: order.orderId || meta.orderId })); cashu.setMintUrl(mintUrl.value.trim()); tokenIn.value = out.token; status.replaceChildren(notice('ok', `Token for ${sats(out.amount)} created and removed from your wallet. Send it now; if sending fails, the token stays in the box above.`)); refreshBalance(); }
      catch (error) { status.replaceChildren(notice('error', `Could not create a token: ${error.message}`)); }
    }, { cls: 'btn-small' });
    const sendPay = button('Send ecash in this conversation', async () => {
      status.replaceChildren();
      try {
        const info = await cashu.inspect(tokenIn.value);
        if (order.payments.some((p) => p.token === info.token)) throw new Error('This exact token was already sent in this order.');
        if (expected && info.amount < expected) throw new Error(`The token is worth ${info.amount} sats, the order costs ${expected} sats.`);
        const rumor = await cashu.paymentRumor({ token: info.token, orderId: order.orderId || meta.orderId, listingRef: order.listingRef || meta.listingRef, amount: info.amount, buyerPubkey: me() });
        await busy(sendPay, 'Sending…', () => app.marmot.sendMessage(id, rumor));
        payBox.replaceChildren(); await openGroup(id);
      } catch (error) { status.replaceChildren(notice('error', `Payment not sent: ${error.message}${error.code === 'NO_RELAY_ACK' ? ' The payment message is saved on this device; use “Retry delivery” in the conversation. The token is still in the box above: do not discard it.' : ''}`)); if (error.code === 'NO_RELAY_ACK') await openGroup(id); }
    }, { cls: 'btn-primary' });
    payBox.replaceChildren(h('div', { class: 'panel inner' }, h('div', { class: 'panel-title' }, h('span', {}, `Pay ${expected ? sats(expected) : ''} with ecash`), button('close', () => payBox.replaceChildren(), { cls: 'btn-link' })),
      h('p', { class: 'small quiet' }, 'The token is sent only inside this end-to-end encrypted group, never as a public event. It is a bearer token: whoever holds it can spend it. It is NOT paid until the seller redeems it at the mint.'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Mint'), mintUrl), h('div', { class: 'row-inline' }, balance, fund, make),
      tokenIn, h('div', { class: 'actions' }, sendPay), status));
  }

  sendBtn.addEventListener('click', async () => {
    const text = draft.value.trim(); if (!text || !current) return;
    sendStatus.replaceChildren();
    try {
      await busy(sendBtn, 'Sending…', () => app.marmot.sendMessage(current.id, { kind: 9, content: text, tags: [] }));
      draft.value = ''; await openGroup(current.id);
    } catch (error) { deliveryFailure(error, 'Message'); if (error.code === 'NO_RELAY_ACK') { draft.value = ''; await openGroup(current.id); } }
  });
  function deliveryFailure(error, what) {
    const id = current.id;
    const retry = error.code === 'NO_RELAY_ACK' ? button('Retry delivery', async () => { try { await busy(retry, 'Retrying…', () => app.marmot.retryPending(id)); sendStatus.replaceChildren(notice('ok', 'Delivered after retry.')); await openGroup(id); } catch (e) { sendStatus.replaceChildren(notice('error', `Still not delivered: ${e.message}`, retry)); } }, { cls: 'btn-small' }) : null;
    sendStatus.replaceChildren(notice('error', `${what} not delivered: ${error.message}${retry ? ' It is saved on this device.' : ' Your text is kept; press Send to retry.'}`, retry));
  }
  draft.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendBtn.click(); });

  async function tick() {
    drawBanner(); await loadLists();
    if (!app.selectedGroup && groups.length) { const saved = storage.get(`sr.sel.${me()}`); app.selectedGroup = groups.find((g) => g.id === saved)?.id || groups[0].id; }
    if (app.selectedGroup && app.marmot) await openGroup(app.selectedGroup);
  }
  head.replaceChildren(h('p', { class: 'quiet' }, 'Select a conversation.'));
  tick();
  const offs = [app.on('marmot', () => { if (alive) tick(); }), app.on('identity', () => {})];
  timer = setInterval(() => { if (alive && app.marmot && !document.hidden) { loadLists(); if (app.selectedGroup) openGroup(app.selectedGroup); } }, 5000);
  return () => { alive = false; clearInterval(timer); offs.forEach((o) => o()); };
}
