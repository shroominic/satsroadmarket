// Idle re-render measurement: counts DOM nodes removed/added (and <img> replacements) over N seconds on the market page.
import { chromium } from '@playwright/test';
import crypto from 'node:crypto';
const BASE = process.env.BASE || 'https://satsroadmarket.com'; const SECS = Number(process.env.SECS || 60);
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript(() => {
  window.__mut = { removed: 0, added: 0, imgRemoved: 0, imgAdded: 0, byTarget: {}, log: [] };
  const start = () => new MutationObserver((list) => {
    for (const m of list) {
      const t = m.target?.id || m.target?.className || m.target?.nodeName; if (m.removedNodes.length || m.addedNodes.length) window.__mut.byTarget[String(t).slice(0, 40)] = (window.__mut.byTarget[String(t).slice(0, 40)] || 0) + m.removedNodes.length;
      for (const n of m.removedNodes) { if (n.nodeType === 1) { window.__mut.removed += 1 + n.querySelectorAll('*').length; window.__mut.imgRemoved += (n.tagName === 'IMG' ? 1 : 0) + n.querySelectorAll('img').length; } }
      for (const n of m.addedNodes) { if (n.nodeType === 1) { window.__mut.added += 1 + n.querySelectorAll('*').length; window.__mut.imgAdded += (n.tagName === 'IMG' ? 1 : 0) + n.querySelectorAll('img').length; } }
    }
  }).observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', start);
});
const page = await ctx.newPage();
await page.goto(BASE + '/#/market', { waitUntil: 'load' }); await page.locator('article.card').first().waitFor({ timeout: 60000 });
await page.waitForTimeout(15000); // let the initial load + background paging settle
const sample = async () => page.evaluate(() => ({ ...window.__mut, byTarget: undefined, cards: document.querySelectorAll('article.card').length }));
const s0 = await sample(); const marks = [];
const shots = []; const t0 = Date.now();
while (Date.now() - t0 < SECS * 1000) { shots.push(crypto.createHash('md5').update(await page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 700 } })).digest('hex')); await page.waitForTimeout(5000); marks.push(await sample()); }
const s1 = await sample(); const byTarget = await page.evaluate(() => window.__mut.byTarget);
const changedFrames = shots.filter((h, i) => i && h !== shots[i - 1]).length;
console.log(JSON.stringify({ secs: SECS, removedNodes: s1.removed - s0.removed, addedNodes: s1.added - s0.added, imgRemoved: s1.imgRemoved - s0.imgRemoved, imgAdded: s1.imgAdded - s0.imgAdded, framesSampled: shots.length, framesChanged: changedFrames, cards: s1.cards, topTargets: Object.entries(byTarget).sort((a, b) => b[1] - a[1]).slice(0, 6) }, null, 1));
await browser.close();
