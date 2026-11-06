import test from 'node:test';
import assert from 'node:assert/strict';
import { compactSats, formatSats, parsePrice, toSats, formatMoney, priceLabel, approxSats, minAcceptableSats, createRateService } from '../src/lib/money.js';

test('parsePrice: default sats, codes are case-insensitive, unknown flagged, bad numbers null', () => {
  assert.deepEqual(parsePrice(['price', '210']), { amount: 210, currency: 'SATS', kind: 'sat' });
  assert.equal(parsePrice(['price', '5', 'sat']).kind, 'sat'); assert.equal(parsePrice(['price', '5', 'SATS']).kind, 'sat');
  assert.equal(parsePrice(['price', '0.001', 'btc']).kind, 'btc');
  for (const c of ['USD', 'EUR', 'GBP', 'KRW', 'JPY']) assert.equal(parsePrice(['price', '1', c]).kind, 'fiat', c);
  assert.equal(parsePrice(['price', '1', 'XYZ']).kind, 'unknown');
  assert.equal(parsePrice(['price', 'abc', 'USD']).amount, null); assert.equal(parsePrice(undefined).amount, null); assert.equal(parsePrice(['price', '-3']).amount, null);
});
test('toSats: sat/btc exact, fiat via rate, never guesses', () => {
  assert.equal(toSats(parsePrice(['price', '210', 'SAT'])).sats, 210);
  assert.equal(toSats(parsePrice(['price', '0.5', 'BTC'])).sats, 50_000_000);
  const usd = toSats(parsePrice(['price', '59', 'USD']), { USD: 75550.03 }); assert.ok(usd.ok); assert.equal(usd.sats, Math.round(59 / 75550.03 * 1e8)); assert.equal(usd.sats, 78094);
  assert.equal(toSats(parsePrice(['price', '1100', 'USD']), { USD: 75550.03 }).sats, 1_455_989);
  assert.equal(toSats(parsePrice(['price', '59', 'USD']), {}).ok, false);
  assert.match(toSats(parsePrice(['price', '5', 'XYZ']), { XYZ: 1 }).reason, /unsupported/);
  assert.equal(toSats(parsePrice(['price', '59', 'USD']), { USD: 0 }).ok, false);
});
test('formatting: own currency first, fiat shows sats equivalent, unknown shows raw code and is not payable', () => {
  assert.equal(formatMoney(parsePrice(['price', '59', 'USD'])), '$59.00 USD');
  assert.equal(formatMoney(parsePrice(['price', '1100', 'USD'])), '$1,100.00 USD');
  assert.equal(formatMoney(parsePrice(['price', '210', 'SAT'])), '210 sats');
  assert.equal(formatMoney(parsePrice(['price', '50000', 'KRW'])), '₩50,000 KRW');
  const label = priceLabel(parsePrice(['price', '59', 'USD']), { USD: 75550.03 }); assert.equal(label.text, '$59.00 USD ≈ 78K sats'); assert.ok(label.payable);
  assert.equal(priceLabel(parsePrice(['price', '1100', 'USD']), { USD: 75550.03 }).text, '$1,100.00 USD ≈ 1.45M sats');
  assert.match(priceLabel(parsePrice(['price', '59', 'USD']), {}).text, /rate unavailable/); assert.equal(priceLabel(parsePrice(['price', '59', 'USD']), {}).payable, false);
  const unk = priceLabel(parsePrice(['price', '7', 'ZZZ']), {}); assert.match(unk.text, /7 ZZZ/); assert.equal(unk.payable, false);
  assert.equal(approxSats(9999), 9999); assert.equal(approxSats(78094), 78000);
  assert.ok(!/sats/.test(formatMoney(parsePrice(['price', '59', 'USD']))), 'a USD price is never rendered as sats');
});
test('seller tolerance: 2% for fiat orders, exact for sats orders', () => {
  assert.equal(minAcceptableSats(10000, true), 9800); assert.equal(minAcceptableSats(10000, false), 10000);
});
test('rate service: getalby first, mempool fallback, cache, and a hard error when unavailable', async () => {
  let calls = 0; let t = 0; const mem = new Map(); const storage = { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) };
  const ok = async (url) => { calls++; return url.includes('getalby') ? { ok: true, json: async () => ({ rate_float: 75550.03 }) } : { ok: true, json: async () => ({ USD: 70000, EUR: 60000 }) }; };
  const rs = createRateService({ fetchImpl: ok, storage, now: () => t });
  const q = await rs.quote(parsePrice(['price', '59', 'USD'])); assert.equal(q.sats, 78094); assert.equal(q.source, 'getalby.com'); assert.equal(calls, 1);
  await rs.quote(parsePrice(['price', '10', 'USD'])); assert.equal(calls, 1, 'cached within 5 minutes');
  t = 6 * 60 * 1000; await rs.ensure('USD'); assert.equal(calls, 2, 'refetched after ttl');
  const warm = createRateService({ fetchImpl: async () => { throw new Error('offline'); }, storage, now: () => t }); assert.ok(warm.map().USD, 'localStorage cache survives reload');
  const fb = createRateService({ fetchImpl: async (u) => (u.includes('getalby') ? { ok: false } : { ok: true, json: async () => ({ EUR: 60000 }) }), now: () => t });
  assert.equal((await fb.quote(parsePrice(['price', '60', 'EUR']))).source, 'mempool.space');
  const dead = createRateService({ fetchImpl: async () => { throw new Error('offline'); }, now: () => t });
  await assert.rejects(() => dead.quote(parsePrice(['price', '5', 'KRW'])), /unavailable/);
  assert.equal((await dead.quote(parsePrice(['price', '5', 'SAT']))).sats, 5, 'sat prices never need a rate');
});

test('compactSats: K only for exact multiples of 1,000 below 1M, M only for exact multiples of 1M, else full digits', () => {
  const cases = [[999, '999 sats'], [1000, '1K sats'], [60000, '60K sats'], [61000, '61K sats'], [62300, '62,300 sats'], [1099, '1,099 sats'], [250000, '250K sats'], [1000000, '1M sats'], [2000000, '2M sats'], [1500000, '1.5M sats'], [1450000, '1.45M sats'], [1455000, '1,455,000 sats'], [999000, '999K sats'], [10000000, '10M sats'], [1010000, '1.01M sats'], [1000001, '1,000,001 sats'], [0, '0 sats']];
  for (const [n, want] of cases) assert.equal(compactSats(n), want, String(n));
  assert.equal(formatSats(60000), '60,000 sats', 'payment flow keeps the exact full number');
  assert.equal(priceLabel(parsePrice(['price', '60000', 'SAT']), {}).text, '60K sats');
  assert.equal(formatMoney(parsePrice(['price', '60000', 'SAT'])), '60,000 sats');
});
