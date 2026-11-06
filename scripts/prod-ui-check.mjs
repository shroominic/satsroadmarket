// Live-site UI check (read-only): header status row, popover, NSFW chip, compact sats, screenshots at desktop and mobile widths.
import { chromium } from '@playwright/test';
const BASE = process.env.BASE || 'https://satsroadmarket.com'; const OUT = new URL('../docs/screens/', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined }); const res = {};
for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 800 }]]) {
  const ctx = await browser.newContext({ viewport: vp }); const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await page.goto(BASE + '/#/market', { waitUntil: 'load' }); await page.locator('article.card').first().waitFor({ timeout: 60000 }); await page.waitForTimeout(9000);
  res[name] = { header: (await page.locator('#status-row').innerText()).replace(/\s+/g, ' '), ariaMarmot: await page.locator('#marmot-status').getAttribute('aria-label'), prices: (await page.locator('article.card .price').allTextContents()).slice(0, 6), nsfwChip: await page.getByRole('button', { name: 'Remove filter NSFW filter' }).count(), hiddenNote: (await page.locator('[data-testid=no-image-note]').innerText()).trim() };
  await page.screenshot({ path: `${OUT}prod-header-${name}.png`, clip: { x: 0, y: 0, width: vp.width, height: 380 } });
  await page.locator('#marmot-status').click(); await page.waitForTimeout(400); res[name].popover = (await page.locator('#status-pop').innerText()).replace(/\s+/g, ' ').slice(0, 200);
  await page.screenshot({ path: `${OUT}prod-header-popover-${name}.png`, clip: { x: 0, y: 0, width: vp.width, height: 560 } });
  await page.keyboard.press('Escape'); res[name].errors = errs; await ctx.close();
}
console.log(JSON.stringify(res, null, 1)); await browser.close();
