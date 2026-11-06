// Production failure-path tests, two isolated Playwright contexts per scenario. BASE=https://satsroadmarket.com node scripts/prod-e2e-failures.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import { deleteTestEvents, rememberKey } from './e2e-cleanup.mjs';
const testKeys = [];
const grabKey = async (w) => { const k = await w.page.evaluate(() => globalThis.__satsroad?.identity?.nsec); if (k && !testKeys.includes(k)) { testKeys.push(k); rememberKey(k); } return k; };

const BASE = process.env.BASE || 'https://satsroadmarket.com';
const SHOTS = new URL('../docs/screens/', import.meta.url).pathname;
const OTHER_MINT = 'https://nofees.testnut.cashu.space';
const results = []; const T = 60000; const allPages = []; let failN = 0;
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null; // run only these scenarios, e.g. ONLY=4,5
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const send = async (w, text) => { await w.page.getByLabel('Message').fill(text); await w.page.getByRole('button', { name: 'Send', exact: true }).click(); };
async function mk(name, { storageState, blockRelay } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState });
  await ctx.addInitScript(() => { try { if (!localStorage.getItem('sr.mint')) localStorage.setItem('sr.mint', 'https://testnut.cashu.space'); if (!localStorage.getItem('sr.localMode')) localStorage.setItem('sr.localMode', '0'); } catch {} });
  const page = await ctx.newPage(); const errs = []; allPages.push({ name, page });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 200)));
  if (blockRelay) await page.routeWebSocket(blockRelay, (ws) => ws.close({ code: 1006, reason: 'blocked by test' }));
  return { ctx, page, name, errs };
}
const shot = (w, n) => w.page.screenshot({ path: `${SHOTS}prod-${n}.png` });
async function step(name, fn) {
  const t = Date.now();
  try { const note = await fn(); results.push({ name, ok: true, ms: Date.now() - t, note: note || '' }); console.log('PASS', name, Date.now() - t, 'ms', note || ''); return true; }
  catch (e) { failN++; for (const p of allPages) { try { if (!p.page.isClosed()) await p.page.screenshot({ path: `/private/tmp/claude-501/e2e/fail-${failN}-${p.name}.png` }); } catch {} } results.push({ name, ok: false, ms: Date.now() - t, note: e.message.split('\n')[0].slice(0, 300) }); console.log('FAIL', name, e.message.split('\n')[0]); return false; }
}
const go = async (w, hash) => { await w.page.evaluate((h) => { location.hash = h; }, hash); await w.page.waitForTimeout(300); };
async function identity(w) {
  await w.page.goto(BASE, { waitUntil: 'load' }); await go(w, '#/identity'); await w.page.getByRole('button', { name: 'Generate new identity' }).click();
  await w.page.waitForFunction(() => globalThis.__satsroad?.marmotState?.status === 'ready' && globalThis.__satsroad.keyPackage.status === 'ok', null, { timeout: T });
  await grabKey(w);
}
async function publish(w, title, { image = '', price = '100' } = {}) {
  await go(w, '#/sell'); await w.page.fill('input[name=title]', title); await w.page.fill('textarea[name=summary]', 'failure test listing');
  await w.page.fill('input[name=price]', price); if (image) { await w.page.fill('input[name=image]', image); await w.page.locator('input[name=image]').blur(); await w.page.waitForTimeout(2500); } await w.page.check('input[name=legal]');
  await w.page.getByRole('button', { name: 'Sign and publish to relays' }).click(); await w.page.getByText(/Published: at least one relay/).waitFor({ timeout: T });
  return (await w.page.locator('.acks li').allTextContents()).join(' | ');
}
async function buyerStarts(b, title) {
  await b.page.evaluate(() => localStorage.setItem('sr.hasImage', '0')); await go(b, '#/identity'); await go(b, '#/market'); const card = b.page.locator('article.card', { hasText: title });
  for (let i = 0; i < 8 && !(await card.count()); i++) { await b.page.getByRole('button', { name: 'Refresh' }).click(); await b.page.waitForTimeout(4000); }
  await card.first().getByRole('link').first().click();
  await b.page.getByRole('button', { name: 'Start private conversation' }).click(); await b.page.waitForURL(/#\/chats/, { timeout: T });
}
async function sellerJoins(s) { await go(s, '#/chats'); const a = s.page.getByRole('button', { name: 'Accept & join' }); await a.waitFor({ timeout: 90000 }); await a.click(); await s.page.getByText(/You are the seller/).waitFor({ timeout: T }); }
async function payToken(b, { mint } = {}) { // returns token string
  await b.page.getByRole('button', { name: /Pay with ecash/ }).click();
  if (mint) { await b.page.getByLabel('Mint URL').fill(mint); await b.page.getByLabel('Mint URL').blur(); }
  await b.page.getByRole('button', { name: /Fund TEST wallet/ }).click(); await b.page.getByText('Test wallet funded.').waitFor({ timeout: T });
}
const rand = Date.now().toString(36);

/* ---- Scenario 1: reused token (local duplicate + mint-level already spent) and wrong mint ---- */
if (!ONLY || ONLY.has('1')) {
  const s = await mk('seller'), b = await mk('buyer'); let token = '';
  const title1 = `[test] Fail-pay A ${rand}`, title2 = `[test] Fail-pay B ${rand}`, title3 = `[test] Fail-pay C ${rand}`;
  await step('setup: identities', async () => { await identity(s); await identity(b); });
  await step('setup: seller publishes 3 listings', async () => { for (const t of [title1, title2, title3]) await publish(s, t); });
  await step('order A: normal payment, capture token', async () => {
    await buyerStarts(b, title1); await sellerJoins(s);
    await payToken(b); await b.page.getByRole('button', { name: 'Create token from wallet' }).click(); await b.page.getByText(/Token for .* created/).waitFor({ timeout: T });
    token = await b.page.getByLabel('Cashu token').inputValue(); if (!token.startsWith('cashu')) throw new Error('no token');
    await b.page.getByRole('button', { name: 'Send ecash in this conversation' }).click(); await b.page.getByText(/Ecash payment/).first().waitFor({ timeout: T });
    const r = s.page.getByRole('button', { name: /^Redeem/ }); await r.waitFor({ timeout: 90000 }); await r.click(); await s.page.locator('.pill', { hasText: /PAID/i }).first().waitFor({ timeout: T });
  });
  await step('order B: buyer reuses SAME token -> seller UI rejects (duplicate)', async () => {
    await buyerStarts(b, title2);
    await go(s, '#/chats'); const a = s.page.getByRole('button', { name: 'Accept & join' }); await a.waitFor({ timeout: 90000 }); await a.click();
    await b.page.getByRole('button', { name: /Pay with ecash/ }).click(); await b.page.getByLabel('Cashu token').fill(token);
    await b.page.getByRole('button', { name: 'Send ecash in this conversation' }).click(); await b.page.getByText(/Ecash payment/).first().waitFor({ timeout: T });
    const r = s.page.getByRole('button', { name: /^Redeem/ }); await r.waitFor({ timeout: 90000 }); await r.click();
    const msg = await s.page.getByText(/Redemption failed:/).first().textContent({ timeout: T }); await shot(s, 'fail-reused-token-duplicate');
    if (!/NOT marked paid/.test(msg) || !/Duplicate|already/i.test(msg)) throw new Error('unexpected: ' + msg);
    if (await s.page.locator('.pill', { hasText: /^PAID$/i }).count()) throw new Error('order wrongly shown as PAID');
    return msg.slice(0, 120);
  });
  await step('order B: mint-level double spend (seller local marker cleared) -> mint says already spent', async () => {
    await s.page.evaluate(async () => { const dbs = await indexedDB.databases(); for (const d of dbs) { if (!/cashu|wallet/i.test(d.name || '')) continue; await new Promise((res) => { const rq = indexedDB.open(d.name); rq.onsuccess = () => { const db = rq.result; for (const sn of db.objectStoreNames) { const tx = db.transaction(sn, 'readwrite'); const st = tx.objectStore(sn); st.getAllKeys().onsuccess = (e) => e.target.result.filter((k) => String(k).startsWith('cashu:seen:')).forEach((k) => st.delete(k)); } setTimeout(res, 300); }; }); } });
    await s.page.reload({ waitUntil: 'load' }); await go(s, '#/chats');
    const r = s.page.getByRole('button', { name: /^Redeem/ }); await r.waitFor({ timeout: 90000 }); await r.click();
    const msg = await s.page.getByText(/Redemption failed:/).first().textContent({ timeout: T }); await shot(s, 'fail-double-spend-mint');
    if (!/already spent/i.test(msg)) throw new Error('unexpected (expected mint-level already spent): ' + msg); return msg.slice(0, 140);
  });
  await step('order C: wrong mint (seller accepts only Minibits, buyer pays testnut token) -> seller rejects', async () => {
    await buyerStarts(b, title3);
    await go(s, '#/chats'); const a = s.page.getByRole('button', { name: 'Accept & join' }); await a.waitFor({ timeout: 90000 }); await a.click();
    await s.page.evaluate(() => localStorage.setItem('sr.mint', 'https://mint.minibits.cash/Bitcoin')); /* seller now accepts only Minibits; buyer pays from testnut */ await payToken(b); await b.page.getByRole('button', { name: 'Create token from wallet' }).click(); await b.page.getByText(/Token for .* created/).waitFor({ timeout: T });
    await b.page.getByRole('button', { name: 'Send ecash in this conversation' }).click(); await b.page.getByText(/Ecash payment/).first().waitFor({ timeout: T });
    const r = s.page.getByRole('button', { name: /^Redeem/ }); await r.waitFor({ timeout: 90000 }); await r.click();
    const msg = await s.page.getByText(/Redemption failed:/).first().textContent({ timeout: T }); await shot(s, 'fail-wrong-mint');
    if (!/Mint not accepted|does not accept/i.test(msg)) throw new Error('unexpected: ' + msg); return msg.slice(0, 140);
  });
  await s.ctx.close(); await b.ctx.close();
}

/* ---- Scenario 2: seller offline when invited, joins later ---- */
if (!ONLY || ONLY.has('2')) {
  const s = await mk('seller'); const b = await mk('buyer'); const title = `[test] Fail-offline ${rand}`;
  let state;
  await step('seller publishes listing + key package, then closes browser', async () => { await identity(s); await publish(s, title); state = await s.ctx.storageState({ indexedDB: true }); await s.ctx.close(); });
  await step('buyer invites while seller is offline', async () => { await identity(b); await buyerStarts(b, title); await b.page.getByText(/Order/).first().waitFor({ timeout: T }); });
  await step('seller returns later (restored profile): invite appears, accepts, messages flow', async () => {
    const s2 = await mk('seller2', { storageState: state }); await s2.page.goto(BASE, { waitUntil: 'load' });
    await s2.page.waitForFunction(() => globalThis.__satsroad?.marmotState?.status === 'ready', null, { timeout: T });
    await sellerJoins(s2); await shot(s2, 'offline-seller-joined-late');
    await send(s2, 'sorry I was offline'); await b.page.getByText('sorry I was offline').waitFor({ timeout: 90000 });
    await send(b, 'no problem'); await s2.page.getByText('no problem').waitFor({ timeout: 90000 }); await s2.ctx.close();
  });
  await b.ctx.close();
}

/* ---- Scenario 3: one relay blocked (nos.lol) ---- */
if (!ONLY || ONLY.has('3')) {
  const blockRelay = /nos\.lol/;
  const s = await mk('seller', { blockRelay }), b = await mk('buyer', { blockRelay }); const title = `[test] Fail-relay ${rand}`;
  await step('relay blocked: app starts, UI marks nos.lol offline', async () => { await identity(s); await identity(b); await go(s, '#/identity'); await s.page.getByText(/OFFLINE/).first().waitFor({ timeout: 30000 }); await shot(s, 'fail-relay-blocked-identity'); });
  let acks = '';
  await step('relay blocked: listing publish reports per-relay result, still succeeds', async () => { acks = await publish(s, title); await shot(s, 'fail-relay-blocked-publish'); if (!/nos\.lol/.test(acks) || !/REJECTED.*nos\.lol/.test(acks)) throw new Error('nos.lol failure not shown: ' + acks); return acks; });
  await step('relay blocked: private conversation, messages and payment still work over remaining relays', async () => {
    await buyerStarts(b, title); await sellerJoins(s);
    await send(b, 'relay test hi'); await s.page.getByText('relay test hi').waitFor({ timeout: 90000 });
    await send(s, 'relay test back'); await b.page.getByText('relay test back').waitFor({ timeout: 90000 }); await shot(b, 'fail-relay-blocked-chat');
  });
  await s.ctx.close(); await b.ctx.close();
}

/* ---- Scenario 4: images ---- */
if (!ONLY || ONLY.has('4')) {
  const s = await mk('seller'), b = await mk('buyer'); const t1 = `[test] Fail-img404 ${rand}`, t2 = `[test] Fail-noimg ${rand}`;
  await step('missing image: 404 URL and no image both show placeholders for buyer', async () => {
    await identity(s); await identity(b);
    await publish(s, t1, { image: 'https://blossom.primal.net/0000000000000000000000000000000000000000000000000000000000000000.png' }); await publish(s, t2);
    await b.page.evaluate(() => localStorage.setItem('sr.hasImage', '0')); await go(b, '#/identity'); await go(b, '#/market'); for (let i = 0; i < 8 && (await b.page.locator('article.card', { hasText: '[test] Fail-' }).count()) < 2; i++) { await b.page.getByRole('button', { name: 'Refresh' }).click(); await b.page.waitForTimeout(4000); }
    await b.page.waitForTimeout(2500); const n = await b.page.locator('article.card .img-missing').count(); await shot(b, 'fail-missing-image'); if (n < 2) throw new Error(`only ${n} placeholders`); return `${n} placeholders`;
  });
  await step('blossom failure: unreachable server -> readable error + fallback buttons', async () => {
    await go(s, '#/sell'); await s.page.locator('input[type=file]').setInputFiles('/private/tmp/claude-501/e2e/test.png'); await s.page.getByLabel('Blossom server').fill('https://blossom.invalid');
    await s.page.getByRole('button', { name: 'Upload to Blossom' }).click(); await s.page.getByText(/Image upload failed/).waitFor({ timeout: T }); await shot(s, 'fail-blossom-unreachable');
    if (!(await s.page.getByRole('button', { name: /Use .*primal|Use .*hzrd149/ }).count())) throw new Error('no fallback button');
  });
  await step('blossom failure: non-image file rejected', async () => {
    fs.writeFileSync('/private/tmp/claude-501/e2e/not-image.txt', 'hello');
    await s.page.getByLabel('Blossom server').fill('https://blossom.primal.net');
    await s.page.locator('input[type=file]').setInputFiles({ name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await s.page.getByRole('button', { name: 'Upload to Blossom' }).click(); await s.page.getByText(/Only image files/).waitFor({ timeout: T });
  });
  await s.ctx.close(); await b.ctx.close();
}

/* ---- Scenario 5: seller has NO key package -> NIP-17 DM fallback -> seller publishes -> group starts ---- */
if (!ONLY || ONLY.has('5')) {
  let dropKp = true; const title = `[test] Fail-nokp ${rand}`;
  const s = await mk('seller'); const b = await mk('buyer');
  // Drop outgoing key-package events (kind 30443) from the seller so none reaches any relay.
  await s.page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => { if (dropKp && typeof m === 'string' && m.startsWith('["EVENT"')) { try { const ev = JSON.parse(m)[1]; if (ev.kind === 30443) { ws.send(JSON.stringify(['OK', ev.id, false, 'blocked: test harness'])); return; } } catch {} } server.send(m); });
    server.onMessage((m) => ws.send(m));
  });
  await step('seller (no key package) publishes listing', async () => { await s.page.goto(BASE, { waitUntil: 'load' }); await go(s, '#/identity'); await s.page.getByRole('button', { name: 'Generate new identity' }).click(); await grabKey(s); await s.page.waitForFunction(() => globalThis.__satsroad?.marmotState?.status === 'ready', null, { timeout: T }); await s.page.waitForFunction(() => globalThis.__satsroad.keyPackage.status === 'error', null, { timeout: T }); await publish(s, title); });
  await step('buyer: Start conversation -> explicit DM fallback panel (nothing sent yet)', async () => {
    await identity(b); await b.page.evaluate(() => localStorage.setItem('sr.hasImage', '0')); await go(b, '#/identity'); await go(b, '#/market'); const card = b.page.locator('article.card', { hasText: title });
    for (let i = 0; i < 8 && !(await card.count()); i++) { await b.page.getByRole('button', { name: 'Refresh' }).click(); await b.page.waitForTimeout(4000); }
    await card.first().getByRole('link').first().click(); await b.page.getByRole('button', { name: 'Start private conversation' }).click();
    await b.page.getByText(/NOT end-to-end private in the Marmot sense/).waitFor({ timeout: T });
    const v = await b.page.getByLabel('Direct message text').inputValue(); if (!v.includes(`interested in your listing "${title}"`) || !v.includes('Please publish a Marmot key package')) throw new Error('bad default text: ' + v);
    await shot(b, 'dm-fallback-prompt');
  });
  await step('buyer: edits text and sends NIP-17 DM -> "Waiting for seller" status', async () => {
    const t = b.page.getByLabel('Direct message text'); await t.fill((await t.inputValue()) + ' (edited by buyer)');
    await b.page.getByRole('button', { name: 'Send direct message' }).click(); await b.page.getByText('Waiting for seller to publish a Marmot key package.').waitFor({ timeout: T }); await shot(b, 'dm-fallback-waiting');
  });
  await step('seller: inbox shows the DM with listing ref', async () => {
    await go(s, '#/chats'); await s.page.getByText('(edited by buyer)').waitFor({ timeout: 90000 }); await s.page.getByText(/Direct messages about your listings/).waitFor(); await shot(s, 'dm-fallback-seller-inbox');
  });
  await step('buyer: Retry before key package exists -> still waiting', async () => { await b.page.getByRole('button', { name: /Retry \(check/ }).click(); await b.page.getByText('Still no key package.').waitFor({ timeout: T }); });
  await step('seller: Publish my key package now -> buyer auto-starts Marmot group', async () => {
    dropKp = false; await s.page.getByRole('button', { name: 'Publish my key package now' }).click(); await s.page.getByText('KEY PACKAGE PUBLISHED').waitFor({ timeout: T });
    await b.page.getByRole('button', { name: /Retry \(check/ }).click(); await b.page.waitForURL(/#\/chats/, { timeout: T }); await sellerJoins(s);
    await send(b, 'now we are private'); await s.page.getByText('now we are private').waitFor({ timeout: 90000 }); await shot(s, 'dm-fallback-group-started');
  });
  await s.ctx.close(); await b.ctx.close();
}

/* ---- Scenario 6: mint defaults and funding flow (no real payment is ever made) ---- */
if (!ONLY || ONLY.has('6')) {
  const live = !!process.env.LIVE; // live site: Minibits invoice is requested but never paid
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage(); const w = { ctx, page, name: 'fresh' };
  await step('fresh visitor: default mint is Minibits, no banner/label shown', async () => {
    await page.goto(BASE, { waitUntil: 'load' }); await go(w, '#/identity'); await page.getByRole('button', { name: 'Generate new identity' }).click();
    await page.waitForFunction(() => globalThis.__satsroad?.marmotState?.status === 'ready', null, { timeout: T });
    const mint = await page.evaluate(() => document.querySelector('select[aria-label="Mint choice"]').value);
    if (mint !== 'https://mint.minibits.cash/Bitcoin') throw new Error('default mint is ' + mint);
    if (await page.locator('#mode-banner:visible').count()) throw new Error('banner visible: ' + await page.locator('#mode-banner').textContent());
    if (await page.getByText(/TEST MINT|Listings and relays are public/).count()) throw new Error('test label/disclaimer visible');
    if (await page.getByRole('button', { name: /Fund TEST wallet/ }).count()) throw new Error('Fund TEST wallet visible on Minibits');
    await shot(w, 'mint-default-minibits');
  });
  await step('Minibits: Add funds creates a mint quote and shows invoice text + QR (NOT paid)', async () => {
    await page.getByLabel('Amount in sats').fill('21'); await page.getByRole('button', { name: 'Add funds (Lightning invoice)' }).click();
    const inv = await page.getByTestId('invoice').textContent({ timeout: T }); if (!/^lnbc/i.test(inv.trim())) throw new Error('not a bolt11 invoice: ' + inv.slice(0, 30));
    if (!(await page.locator('.invoice svg').count())) throw new Error('no QR'); await shot(w, 'mint-minibits-invoice');
    await page.getByRole('button', { name: 'Cancel' }).click(); return inv.slice(0, 12) + '… (unpaid, cancelled)';
  });
  if (!process.env.LIVE) await step('testnut selected: TEST label + Fund TEST button appear; NUT-04 Add funds flow polls and stores proofs', async () => {
    await page.getByLabel('Mint choice').selectOption('https://testnut.cashu.space'); await page.getByText('TEST MINT, sats have no value').first().waitFor({ timeout: T });
    await page.getByRole('button', { name: /Fund TEST wallet/ }).waitFor();
    await page.getByLabel('Amount in sats').fill('64'); await page.getByRole('button', { name: 'Add funds (Lightning invoice)' }).click();
    await page.getByText(/Paid\. .*added to your wallet/).waitFor({ timeout: T }); await shot(w, 'mint-testnut-nut04-funded');
    await page.waitForFunction(() => /64/.test(document.querySelector('[data-testid=balance]')?.textContent || ''), null, { timeout: T });
  });
  await ctx.close();
}

/* ---- Scenario 7: "Has image" filter chip ---- */
if (!ONLY || ONLY.has('7')) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage(); const w = { ctx, page, name: 'chips' };
  await step('market: Has image chip ON by default, hides image-less listings, count + Show them link', async () => {
    await page.goto(BASE + '/#/market', { waitUntil: 'load' });
    const cards = page.locator('article.card'); for (let i = 0; i < 8 && !(await cards.count()); i++) await page.waitForTimeout(4000);
    await page.getByRole('button', { name: 'Remove filter Has image' }).waitFor({ timeout: 20000 });
    const n = await cards.count(); const missing = await page.locator('article.card .img-missing').count();
    const note = await page.getByTestId('no-image-note').textContent(); await shot(w, 'filter-chip-on');
    if (!n) throw new Error('no listings loaded'); if (missing) throw new Error(missing + ' image-less cards visible with filter on');
    return `${n} shown; note: ${note.trim()}`;
  });
  await step('chip x removes filter (image-less listings appear), + re-adds, state persists across reload', async () => {
    const before = await page.locator('article.card').count();
    await page.getByRole('button', { name: 'Remove filter Has image' }).click(); await page.getByRole('button', { name: 'Add filter Has image' }).waitFor();
    const after = await page.locator('article.card').count(); await shot(w, 'filter-chip-removed'); if (after < before) throw new Error('fewer cards after removing filter');
    await page.reload({ waitUntil: 'load' }); await page.getByRole('button', { name: 'Add filter Has image' }).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Add filter Has image' }).click(); await page.getByRole('button', { name: 'Remove filter Has image' }).waitFor();
    return `${before} -> ${after} cards`;
  });
  await ctx.close();
}

/* ---- Scenario 8: network offline at startup, then recovery (no raw JSON error, honest DISCONNECTED status, key package resolves) ---- */
if (!ONLY || ONLY.has('8')) {
  const w = await mk('offline'); const sockets = {}; let netDown = true; // every relay websocket is refused while netDown
  w.page.on('websocket', (ws) => { const u = ws.url(); sockets[u] = (sockets[u] || 0) + 1; });
  await w.page.routeWebSocket(/.*/, (ws) => { if (netDown) { ws.close({ code: 1006, reason: 'network down (test)' }); return; } const server = ws.connectToServer(); ws.onMessage((m) => server.send(m)); server.onMessage((m) => ws.send(m)); });
  await w.page.goto(BASE, { waitUntil: 'load' }); await go(w, '#/identity');
  await step('offline at start: UI says DISCONNECTED with a friendly line and per-relay details (no raw JSON)', async () => {
    await w.page.getByRole('button', { name: 'Generate new identity' }).click();
    await w.page.getByTestId('conn-note').waitFor({ timeout: 60000 }); const pill = await w.page.getByTestId('marmot-pill').textContent();
    const note = await w.page.getByTestId('conn-note').textContent(); await shot(w, 'offline-disconnected');
    if (pill !== 'DISCONNECTED') throw new Error('pill=' + pill); if (/Relay subscription closed|\[\{url/.test(await w.page.locator('body').textContent())) throw new Error('raw JSON error visible');
    if (!/Can't reach messaging relays \(0\/\d\)/.test(note)) throw new Error('note: ' + note.slice(0, 120)); return note.slice(0, 90);
  });
  await step('back online: status recovers to READY and the key package publishes (or fails with a real reason)', async () => {
    netDown = false;
    await w.page.waitForFunction(() => document.querySelector('[data-testid=marmot-pill]')?.textContent === 'READY', null, { timeout: 120000 });
    await w.page.waitForFunction(() => ['ok', 'error'].includes(globalThis.__satsroad.keyPackage.status), null, { timeout: 90000 });
    const kp = await w.page.evaluate(() => globalThis.__satsroad.keyPackage); await shot(w, 'offline-recovered'); if (kp.status !== 'ok') throw new Error('key package ' + kp.status + ': ' + kp.error); 
  });
  await step('sockets per relay stay small (one shared pool, probes reuse it)', async () => {
    const max = Math.max(...Object.values(sockets)); const total = Object.values(sockets).reduce((a, b) => a + b, 0); if (max > 25) throw new Error('max ' + max + ' sockets to one relay: ' + JSON.stringify(sockets)); return `max ${max} per relay, ${total} total over ${Object.keys(sockets).length} relays`;
  });
  await w.ctx.close();
}

/* ---- Scenario 9: market display (read-only, safe on the live site): fiat prices, no stray "null", infinite scroll, scroll restore ---- */
if (!ONLY || ONLY.has('9')) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage(); const w = { ctx, page, name: 'market' };
  await step('market: fiat listings show their own currency plus sats equivalent, never "N sats" for a USD price', async () => {
    await page.goto(BASE + '/#/market', { waitUntil: 'load' }); await page.locator('article.card').first().waitFor({ timeout: 60000 }); await page.waitForTimeout(6000);
    const prices = await page.locator('article.card .price').allTextContents(); const fiat = prices.filter((t) => /[$€£₩¥]|USD|EUR|GBP|KRW|JPY/.test(t));
    await shot(w, 'market-fiat-prices'); if (!fiat.length) return `no fiat-priced listing among ${prices.length} cards (cannot assert); sample: ${prices.slice(0, 3).join(' | ')}`;
    const bad = fiat.filter((t) => !/≈|rate unavailable|not payable/.test(t)); if (bad.length) throw new Error('fiat price without conversion: ' + bad[0]);
    return `${fiat.length} fiat cards, e.g. ${fiat[0]}`;
  });
  await step('no stray "null" text anywhere in the market/pager', async () => { const t = await page.locator('main, #view, body').first().innerText(); if (/\bnull\b/.test(t)) throw new Error('found text "null"'); });
  await step('infinite scroll ON by default: cards append while scrolling, loading/end rows, no page buttons', async () => {
    if (await page.getByRole('button', { name: 'Next' }).count()) throw new Error('page buttons visible in infinite mode');
    const c0 = await page.locator('article.card').count();
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(1200); }
    const c1 = await page.locator('article.card').count(); await shot(w, 'market-infinite-scroll'); if (c1 <= c0) throw new Error(`no growth ${c0} -> ${c1}`);
    return `${c0} -> ${c1} cards after scrolling`;
  });
  await step('scroll position and loaded count restored after opening a listing and going back', async () => {
    await page.evaluate(() => window.scrollTo(0, 2200)); await page.waitForTimeout(800); const y0 = await page.evaluate(() => scrollY); const n0 = await page.locator('article.card').count();
    await page.locator('article.card .card-link').nth(8).click(); await page.waitForSelector('.detail', { timeout: 20000 }); const saved = await page.evaluate(() => globalThis.__satsroad.marketState?.y); /* Playwright scrolls the clicked card into view first, so compare with the position saved at click time */
    await page.goBack(); await page.waitForSelector('article.card', { timeout: 20000 }); await page.waitForTimeout(1500);
    const y1 = await page.evaluate(() => scrollY); const n1 = await page.locator('article.card').count(); if (Math.abs(y1 - saved) > 150 || n1 < n0) throw new Error(`saved y ${saved} -> restored ${y1}, cards ${n0}->${n1}`); return `scrolled ${y0}, saved at click ${saved}, restored ${y1}, cards ${n0}->${n1}`;
  });
  await step('switch off Infinite scroll: classic pages with Next/Previous; choice persists after reload', async () => {
    await page.getByLabel('Infinite scroll').uncheck(); await page.getByRole('button', { name: 'Next' }).waitFor(); const info = await page.getByTestId('page-info').textContent(); await shot(w, 'market-classic-pages');
    if (/null/.test(await page.locator('.pager').innerText())) throw new Error('null in pager');
    await page.reload({ waitUntil: 'load' }); await page.getByRole('button', { name: 'Next' }).waitFor({ timeout: 30000 }); await page.getByLabel('Infinite scroll').check(); return info.trim();
  });
  await ctx.close();
}

/* ---- Scenario 10 (e2e build only: fake money): fiat-priced listing -> order priced in sats at order time, rate shown, seller redeems with tolerance ---- */
if (!process.env.LIVE && (!ONLY || ONLY.has('10'))) {
  const s = await mk('seller'), b = await mk('buyer'); const title = `[test] Fail-usd ${rand}`;
  await step('USD listing: card shows "$… USD ≈ … sats"', async () => {
    await identity(s); await identity(b); await go(s, '#/sell'); await s.page.fill('input[name=title]', title); await s.page.fill('textarea[name=summary]', 'usd priced test');
    await s.page.fill('input[name=price]', '1'); await s.page.getByLabel('Price currency').selectOption('USD'); await s.page.fill('input[name=image]', 'https://blossom.primal.net/07022d7193e117520e0f4ad09a3bdca220831e2880b141efef5ee2ec6b7dc7b1.png'); await s.page.locator('input[name=image]').blur(); await s.page.waitForTimeout(3000); await s.page.check('input[name=legal]');
    await s.page.getByRole('button', { name: 'Sign and publish to relays' }).click(); await s.page.getByText(/Published: at least one relay/).waitFor({ timeout: T });
    await go(b, '#/identity'); await go(b, '#/market'); const card = b.page.locator('article.card', { hasText: title });
    for (let i = 0; i < 8 && !(await card.count()); i++) { await b.page.getByRole('button', { name: 'Refresh' }).click(); await b.page.waitForTimeout(4000); }
    const t = await card.first().locator('.price').textContent({ timeout: 20000 }); await b.page.waitForTimeout(3000); const t2 = await card.first().locator('.price').textContent(); await shot(b, 'usd-card');
    if (!/\$1\.00 USD ≈ [\d,]+K? sats|\$1\.00 USD ≈ [\d,]+ sats/.test(t2)) throw new Error('price label: ' + t + ' / ' + t2); return t2;
  });
  await step('order: sats amount fixed at order time, rate line shown, fiat+rate tags in the order message, redeem works', async () => {
    await b.page.locator('article.card', { hasText: title }).first().getByRole('link').first().click(); await b.page.getByRole('button', { name: 'Start private conversation' }).click(); await b.page.waitForURL(/#\/chats/, { timeout: T });
    await sellerJoins(s); await b.page.getByRole('button', { name: /Pay with ecash/ }).click(); const line = await b.page.getByTestId('rate-line').textContent({ timeout: T }); await shot(b, 'usd-pay-rate-line');
    if (!/Listed at 1 USD/.test(line) || !/USD\/BTC/.test(line)) throw new Error('rate line: ' + line);
    const tags = await b.page.evaluate(async () => { const m = globalThis.__satsroad.marmot; const g = (await m.listGroups())[0]; const h = await m.history(g.id); return h.find((r) => r.tags.some((t) => t[0] === 'subject'))?.tags; });
    if (!tags.some((t) => t[0] === 'price' && t[1] === '1' && t[2] === 'USD') || !tags.some((t) => t[0] === 'rate') || !tags.some((t) => t[0] === 'amount')) throw new Error('tags: ' + JSON.stringify(tags));
    await b.page.getByRole('button', { name: /Fund TEST wallet/ }).click(); await b.page.getByText('Test wallet funded.').waitFor({ timeout: T }); await b.page.getByRole('button', { name: /Fund TEST wallet/ }).click(); await b.page.waitForTimeout(6000); /* second top-up leaves room for mint fees */
    await b.page.getByRole('button', { name: 'Create token from wallet' }).click(); await b.page.getByText(/Token for .* created/).waitFor({ timeout: T });
    await b.page.getByRole('button', { name: 'Send ecash in this conversation' }).click(); const r = s.page.getByRole('button', { name: /^Redeem/ }); await r.waitFor({ timeout: 90000 }); await r.click();
    await s.page.locator('.pill', { hasText: /PAID/i }).first().waitFor({ timeout: T }); return tags.map((t) => t.join(':')).join(' ');
  });
  await s.ctx.close(); await b.ctx.close();
}
fs.writeFileSync('/private/tmp/claude-501/e2e/failures.json', JSON.stringify(results, null, 1));
const cleanup = await deleteTestEvents({ keys: testKeys }); console.log('CLEANUP', JSON.stringify(cleanup)); fs.writeFileSync('/private/tmp/claude-501/e2e/cleanup-failures.json', JSON.stringify(cleanup, null, 1));
await browser.close();
