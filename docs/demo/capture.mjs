// Captures the demo journey against a LOCAL stack only: npm run relay (ws://127.0.0.1:7777), npm run mint (127.0.0.1:3338),
// E2E build on 127.0.0.1:4173, and docs/seed served on 127.0.0.1:8099. Two isolated browser contexts. No public relay, no real funds.
// Dev-only chrome (mode banner, "Fund TEST wallet") is hidden with CSS at capture time because production does not show it.
import { chromium } from '@playwright/test';
const BASE = 'http://127.0.0.1:4173', IMG = 'http://127.0.0.1:8099/';
const OUT = new URL('./src/', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
async function mk() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { try {
    localStorage.setItem('sr.localMode', '0'); localStorage.setItem('sr.relays', JSON.stringify(['ws://127.0.0.1:7777']));
    localStorage.setItem('sr.listingRelays', JSON.stringify(['ws://127.0.0.1:7777'])); localStorage.setItem('sr.mint', 'http://127.0.0.1:3338');
  } catch {} });
  const page = await ctx.newPage(); await page.goto(BASE, { waitUntil: 'load' });
  await page.addStyleTag({ content: '#mode-banner{display:none!important}' });
  return page;
}
const T = 60000;
const go = async (p, h) => { await p.evaluate((x) => { location.hash = x; }, h); await p.waitForTimeout(400); };
const ready = async (p) => { await p.waitForFunction(() => globalThis.__satsroad?.marmotState?.status === 'ready', null, { timeout: T }); await p.waitForFunction(() => globalThis.__satsroad.keyPackage.status === 'ok', null, { timeout: T }); await p.waitForTimeout(1500); };
const hideDev = (p) => p.evaluate(() => { for (const b of document.querySelectorAll('button')) if (/Fund TEST/i.test(b.textContent)) b.style.display = 'none'; for (const e of document.querySelectorAll('.pill')) if (/TEST MINT/i.test(e.textContent)) e.style.display = 'none'; });
const shot = async (p, n) => { await hideDev(p); await p.mouse.move(1270, 5); await p.screenshot({ path: `${OUT}${n}.png` }); console.log('shot', n); };
async function list(p, { title, summary, price, img, snap }) {
  await go(p, '#/sell');
  await p.fill('input[name=title]', title); await p.fill('textarea[name=summary]', summary); await p.fill('input[name=price]', String(price));
  await p.fill('input[name=image]', IMG + img); await p.waitForTimeout(800); for (let i = 0; i < 5 && !(await p.isChecked('input[name=legal]')); i++) { await p.locator('input[name=legal]').click({ force: true }).catch(() => {}); await p.waitForTimeout(400); }
  await p.waitForTimeout(1200); if (snap) await shot(p, snap);
  await p.getByRole('button', { name: 'Sign and publish to relays' }).click();
  await p.getByText(/Published: at least one relay/).waitFor({ timeout: T });
}
// shop with several product photos so the market looks like a real one
const shop = await mk(); await go(shop, '#/identity'); await shop.getByRole('button', { name: 'Generate new identity' }).click(); await ready(shop);
for (const [t, s, pr, im] of [['Merino scarf', 'Soft undyed merino, hand finished.', 12000, 'merino-scarf.jpg'], ['Brass compass', 'Pocket compass, solid brass.', 8500, 'brass-compass.jpg'], ['Single-origin coffee beans', 'Medium roast, 500 g.', 15800, 'coffee-beans.jpg'], ['Medjool dates', 'One kilo box.', 9000, 'medjool-dates.jpg']])
  await list(shop, { title: t, summary: s, price: pr, img: im });
const seller = await mk(), buyer = await mk();
for (const p of [seller, buyer]) { await go(p, '#/identity'); await p.getByRole('button', { name: 'Generate new identity' }).click(); await ready(p); }
await list(seller, { title: 'Leather saddlebag', summary: 'Full-grain leather, brass buckles, hand stitched.', price: 21000, img: 'leather-saddlebag.jpg', snap: 'sell-form' });
await go(buyer, '#/market');
const card = buyer.locator('article.card', { hasText: 'Leather saddlebag' });
for (let i = 0; i < 8 && !(await card.count()); i++) { await buyer.getByRole('button', { name: 'Refresh' }).click().catch(() => {}); await buyer.waitForTimeout(2000); }
await card.first().waitFor({ timeout: T });
await buyer.waitForFunction(() => [...document.querySelectorAll('article.card')].every((c) => !c.querySelector('img') || c.querySelector('img').naturalWidth > 0), null, { timeout: T }).catch(() => {});
await buyer.waitForTimeout(1500); await shot(buyer, 'market-buyer-sees-listing');
await card.first().getByRole('link').first().click();
await buyer.getByRole('button', { name: 'Start private conversation' }).click();
await buyer.waitForURL(/#\/chats/, { timeout: T }); await buyer.getByText(/Order|ORDER/).first().waitFor({ timeout: T }); await buyer.waitForTimeout(800);
await shot(buyer, 'chat-buyer-started');
await go(seller, '#/chats');
const accept = seller.getByRole('button', { name: 'Accept & join' }); await accept.waitFor({ timeout: 90000 }); await shot(seller, 'invite-seller');
await accept.click(); await seller.getByText(/You are the seller/).waitFor({ timeout: T });
const send = async (p, text) => { await p.getByLabel('Message').fill(text); await p.getByRole('button', { name: 'Send', exact: true }).click(); };
await go(buyer, '#/chats'); await send(buyer, 'Hi! Is the saddlebag still available?'); await seller.getByText('still available').waitFor({ timeout: 90000 });
await send(seller, 'Yes, ready to ship. Pay in ecash here.'); await buyer.getByText('ready to ship').waitFor({ timeout: 90000 });
await seller.waitForTimeout(800); await shot(seller, 'chat-seller-messages');
await buyer.getByRole('button', { name: 'Pay with ecash' }).click();
await buyer.getByRole('button', { name: /Fund TEST wallet/ }).click(); await buyer.getByText('Test wallet funded.').waitFor({ timeout: T });
await buyer.getByRole('button', { name: 'Create token from wallet' }).click(); await buyer.getByText(/Token for .* created/).waitFor({ timeout: T });
await buyer.waitForTimeout(500); await shot(buyer, 'pay-token-created');
await buyer.getByRole('button', { name: 'Send ecash in this conversation' }).click(); await buyer.getByText(/Ecash payment/).first().waitFor({ timeout: T });
const red = seller.getByRole('button', { name: /^Redeem/ }); await red.waitFor({ timeout: 90000 }); await seller.waitForTimeout(500); await shot(seller, 'redeem-button');
await red.click(); await seller.getByText(/Redeemed \d+ sats at the mint/).waitFor({ timeout: T }); await seller.locator('.pill', { hasText: /PAID/i }).first().waitFor({ timeout: T });
await seller.waitForTimeout(800); await shot(seller, 'redeemed-paid-seller');
await buyer.locator('.pill', { hasText: /PAID/i }).first().waitFor({ timeout: 90000 });
await seller.getByRole('button', { name: 'Mark fulfilled' }).click(); await seller.locator('.pill', { hasText: /FULFILLED/i }).first().waitFor({ timeout: T });
await buyer.locator('.pill', { hasText: /FULFILLED/i }).first().waitFor({ timeout: 90000 });
await buyer.reload({ waitUntil: 'load' }); await buyer.addStyleTag({ content: '#mode-banner{display:none!important}' }); await go(buyer, '#/chats');
await buyer.getByText(/ready to ship/).first().waitFor({ timeout: T }); await buyer.locator('.pill', { hasText: /FULFILLED/i }).first().waitFor({ timeout: T });
await ready(buyer); await buyer.waitForFunction(() => /Marmot\s*\d+\/\d+[\s\S]*Listings\s*\d+\/\d+/.test(document.body.innerText.slice(0, 200)), null, { timeout: T }).catch(async () => { console.log('HEADER', JSON.stringify(await buyer.evaluate(() => document.body.innerText.slice(0, 120)))); }); await buyer.waitForTimeout(2000); await shot(buyer, 'persist-buyer');
await browser.close();
