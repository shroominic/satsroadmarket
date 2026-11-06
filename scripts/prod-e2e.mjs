// Production end-to-end journey with two isolated Playwright browser contexts. Usage: BASE=https://satsroadmarket.pages.dev node scripts/prod-e2e.mjs
import { chromium } from '@playwright/test';
import zlib from 'node:zlib';
import fs from 'node:fs';
import { deleteTestEvents, rememberKey } from './e2e-cleanup.mjs';
const testKeys = [];
const grabKey = async (w) => { const k = await w.page.evaluate(() => globalThis.__satsroad?.identity?.nsec); if (k && !testKeys.includes(k)) { testKeys.push(k); rememberKey(k); } return k; };
import crypto from 'node:crypto';

const BASE = process.env.BASE || 'https://satsroadmarket.pages.dev';
const SHOTS = new URL('../docs/screens/', import.meta.url).pathname;
const results = [];
const consoleErrors = { seller: [], buyer: [] };

function png() { // unique 160x160 gradient PNG
  const w = 160, h = 160, raw = Buffer.alloc((w * 3 + 1) * h); const r0 = crypto.randomInt(255);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = (x + r0) & 255; raw[o + 1] = y * 1.5 & 255; raw[o + 2] = 120; } }
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const imgPath = '/private/tmp/claude-501/e2e/test.png'; fs.writeFileSync(imgPath, png());

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
async function mk(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { try { if (!localStorage.getItem('sr.mint')) localStorage.setItem('sr.mint', 'https://testnut.cashu.space'); if (!localStorage.getItem('sr.localMode')) localStorage.setItem('sr.localMode', '0'); } catch {} });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors[name].push(m.text().slice(0, 300)); });
  page.on('response', (r) => { if (r.status() >= 400) consoleErrors[name].push(`HTTP ${r.status()} ${r.request().method()} ${r.url().slice(0, 120)}`); });
  page.on('pageerror', (e) => consoleErrors[name].push('pageerror: ' + e.message.slice(0, 300)));
  return { ctx, page, name };
}
const seller = await mk('seller'), buyer = await mk('buyer');
const shot = (who, n) => who.page.screenshot({ path: `${SHOTS}prod-${n}.png` });
async function step(name, fn) {
  const t = Date.now();
  try { const note = await fn(); results.push({ name, ok: true, ms: Date.now() - t, note: note || '' }); console.log('PASS', name, Date.now() - t, 'ms', note || ''); }
  catch (e) { results.push({ name, ok: false, ms: Date.now() - t, note: e.message.split('\n')[0].slice(0, 300) }); console.log('FAIL', name, e.message.split('\n')[0]); }
}
const T = 60000;
const go = async (w, hash) => { await w.page.evaluate((h) => { location.hash = h; }, hash); await w.page.waitForTimeout(300); };

await step('load app on pages.dev (seller+buyer)', async () => {
  for (const w of [seller, buyer]) await w.page.goto(BASE, { waitUntil: 'load' });
  await seller.page.waitForSelector('#relay-status');
});
for (const w of [seller, buyer]) await step(`${w.name}: generate identity`, async () => {
  await go(w, '#/identity'); await w.page.getByRole('button', { name: 'Generate new identity' }).click();
  await w.page.waitForFunction(() => globalThis.__satsroad?.marmotState?.status === 'ready', null, { timeout: T });
  await w.page.waitForFunction(() => globalThis.__satsroad.keyPackage.status === 'ok', null, { timeout: T });
  await grabKey(w);
  return `relays: ${await w.page.evaluate(() => globalThis.__satsroad.relays.join(','))}`;
});
await shot(seller, 'identity-seller');
let listingTitle = `[test] camel saddle ${Date.now().toString(36)}`;
await step('seller: upload real image to Blossom', async () => {
  await go(seller, '#/sell');
  await seller.page.locator('input[type=file]').setInputFiles(imgPath);
  await seller.page.getByRole('button', { name: 'Upload to Blossom' }).click();
  await seller.page.getByText(/Uploaded\. Image URL filled in/).waitFor({ timeout: T });
  const url = await seller.page.locator('input[name=image]').inputValue();
  const r = await fetch(url); if (!r.ok || !/image/.test(r.headers.get('content-type'))) throw new Error('uploaded URL not fetchable: ' + r.status);
  return url;
});
await step('seller: publish listing to public relays', async () => {
  await seller.page.fill('input[name=title]', listingTitle); await seller.page.fill('textarea[name=summary]', 'Hand stitched saddle, test listing from the production E2E run.');
  await seller.page.fill('input[name=price]', '210'); await seller.page.check('input[name=legal]');
  await shot(seller, 'sell-form');
  await seller.page.getByRole('button', { name: 'Sign and publish to relays' }).click();
  await seller.page.getByText(/Published: at least one relay/).waitFor({ timeout: T });
  await seller.page.locator('.acks li').first().waitFor();
  return (await seller.page.locator('.acks li').allTextContents()).join(' | ');
});
await shot(seller, 'listing-published-acks');
await step('buyer: sees listing (with image) via public relays', async () => {
  await go(buyer, '#/market');
  const card = buyer.page.locator('article.card', { hasText: listingTitle });
  for (let i = 0; i < 6 && !(await card.count()); i++) { await buyer.page.getByRole('button', { name: 'Refresh' }).click(); await buyer.page.waitForTimeout(4000); }
  await card.first().waitFor({ timeout: 10000 });
  await buyer.page.waitForFunction((t) => [...document.querySelectorAll('article.card')].find((c) => c.textContent.includes(t))?.querySelector('img')?.naturalWidth > 0, listingTitle, { timeout: T });
});
await shot(buyer, 'market-buyer-sees-listing');
await step('buyer: start private conversation', async () => {
  await buyer.page.locator('article.card', { hasText: listingTitle }).first().getByRole('link').first().click();
  await buyer.page.getByRole('button', { name: 'Start private conversation' }).click();
  await buyer.page.waitForURL(/#\/chats/, { timeout: T });
  await buyer.page.getByText(/Order|ORDER/).first().waitFor({ timeout: T });
});
await shot(buyer, 'chat-buyer-started');
await step('seller: sees invite, accepts', async () => {
  await go(seller, '#/chats');
  const accept = seller.page.getByRole('button', { name: 'Accept & join' });
  await accept.waitFor({ timeout: 90000 }); await shot(seller, 'invite-seller');
  await accept.click(); await seller.page.getByText(/You are the seller/).waitFor({ timeout: T });
});
await step('messages both ways', async () => {
  const send = async (w, text) => { await w.page.getByLabel('Message').fill(text); await w.page.getByRole('button', { name: 'Send', exact: true }).click(); };
  await go(buyer, '#/chats'); await send(buyer, 'hello from the buyer'); await seller.page.getByText('hello from the buyer').waitFor({ timeout: 90000 });
  await send(seller, 'hello from the seller'); await buyer.page.getByText('hello from the seller').waitFor({ timeout: 90000 });
});
await shot(seller, 'chat-seller-messages');
await step('buyer: fund TEST wallet from testnut', async () => {
  await buyer.page.getByRole('button', { name: 'Pay with ecash' }).click();
  await buyer.page.getByRole('button', { name: /Fund TEST wallet/ }).click();
  await buyer.page.getByText('Test wallet funded.').waitFor({ timeout: T });
});
await step('buyer: create token and pay in chat', async () => {
  await buyer.page.getByRole('button', { name: 'Create token from wallet' }).click();
  await buyer.page.getByText(/Token for .* created/).waitFor({ timeout: T });
  await shot(buyer, 'pay-token-created');
  await buyer.page.getByRole('button', { name: 'Send ecash in this conversation' }).click();
  await buyer.page.getByText(/Ecash payment/).first().waitFor({ timeout: T });
});
await step('seller: redeems token at testnut -> PAID', async () => {
  const b = seller.page.getByRole('button', { name: /^Redeem/ }); await b.waitFor({ timeout: 90000 }); await shot(seller, 'redeem-button');
  await b.click(); await seller.page.getByText(/Redeemed \d+ sats at the mint/).waitFor({ timeout: T });
  await seller.page.locator('.pill', { hasText: /PAID/i }).first().waitFor({ timeout: T });
});
await shot(seller, 'redeemed-paid-seller');
await step('buyer: sees PAID receipt', async () => { await buyer.page.locator('.pill', { hasText: /PAID/i }).first().waitFor({ timeout: 90000 }); });
await step('seller: mark fulfilled', async () => { await seller.page.getByRole('button', { name: 'Mark fulfilled' }).click(); await seller.page.locator('.pill', { hasText: /FULFILLED/i }).first().waitFor({ timeout: T }); });
await step('buyer sees FULFILLED', async () => { await buyer.page.locator('.pill', { hasText: /FULFILLED/i }).first().waitFor({ timeout: 90000 }); });
await shot(buyer, 'fulfilled-buyer');
await step('reload both: persistence', async () => {
  for (const w of [seller, buyer]) { await w.page.reload({ waitUntil: 'load' }); await go(w, '#/chats'); await w.page.getByText(/hello from the (buyer|seller)/).first().waitFor({ timeout: T }); await w.page.locator('.pill', { hasText: /FULFILLED/i }).first().waitFor({ timeout: T }); }
});
await shot(seller, 'persist-seller'); await shot(buyer, 'persist-buyer');
fs.writeFileSync('/private/tmp/claude-501/e2e/state.json', JSON.stringify({ listingTitle }));
console.log('\nCONSOLE ERRORS', JSON.stringify(consoleErrors, null, 1));
fs.writeFileSync('/private/tmp/claude-501/e2e/journey.json', JSON.stringify({ results, consoleErrors }, null, 1));
const cleanup = await deleteTestEvents({ keys: testKeys }); console.log('CLEANUP', JSON.stringify(cleanup)); fs.writeFileSync('/private/tmp/claude-501/e2e/cleanup-journey.json', JSON.stringify(cleanup, null, 1));
await browser.close();
