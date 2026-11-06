// Measures listing load: cold visit (no cache), background paging, then a throttled warm visit that must paint from cache.
import { chromium } from '@playwright/test';
const BASE = process.env.BASE || 'https://satsroadmarket.com';
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage();
const info = () => page.evaluate(() => ({ cards: document.querySelectorAll('article.card').length, listings: globalThis.__satsroad?.listings?.length ?? 0, cached: globalThis.__satsroad?.loader?.size ?? 0, page: document.querySelector('[data-testid=page-info]')?.textContent?.trim() || '', loading: !!document.querySelector('[data-testid=loading-more]'), exhausted: globalThis.__satsroad?.loader?.exhausted?.() }));
const out = {};
let t = Date.now(); await page.goto(BASE + '/#/market', { waitUntil: 'load' });
await page.waitForSelector('article.card', { timeout: 60000 }); out.coldFirstCardMs = Date.now() - t;
await page.waitForTimeout(3000); out.coldAfter3s = await info();
await page.waitForTimeout(12000); out.coldAfterBackground15s = await info();
await page.getByRole('button', { name: 'Next' }).click().catch(() => {}); await page.waitForTimeout(3000); out.afterNextPage = await info();
await page.screenshot({ path: new URL('../docs/screens/prod-pagination.png', import.meta.url).pathname });
await page.waitForTimeout(2500); // let the cache persist (debounced)
// warm visit with slow network: CDP throttling (~400 kbit/s, 800 ms latency) applies to HTTP; wss frames are delayed by blocking relays entirely
const page2 = await ctx.newPage(); const cdp = await ctx.newCDPSession(page2);
await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 800, downloadThroughput: 50000, uploadThroughput: 50000 });
await page2.routeWebSocket(/.*/, () => { /* relays never answer: simulates a very slow/unreachable network */ });
t = Date.now(); await page2.goto(BASE + '/#/market', { waitUntil: 'domcontentloaded' });
await page2.waitForSelector('article.card', { timeout: 60000 }); out.warmThrottledFirstCardMs = Date.now() - t;
out.warmCards = await page2.evaluate(() => ({ cards: document.querySelectorAll('article.card').length, fromCache: globalThis.__satsroad.loader.cacheHit, relayStatus: [...globalThis.__satsroad.relayStatus.values()].map((r) => r.state).join(',') || 'none yet' }));
await page2.screenshot({ path: new URL('../docs/screens/prod-cache-first-paint.png', import.meta.url).pathname });
console.log(JSON.stringify(out, null, 1)); await browser.close();
