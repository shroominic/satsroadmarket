/** Prices follow Shopstr: ["price", amount, currency], currency defaults to sats; fiat converts to sats with a live BTC rate. */
import currencies from './currencies.json' with { type: 'json' };

export const CURRENCIES = currencies; // Shopstr's public/currencySelection.json (code -> symbol, decimals, name)
export const TOLERANCE = 0.02; // seller accepts up to 2% less than the order's sats amount (rate movement)
const SAT_CODES = new Set(['SAT', 'SATS']);

/** -> { amount, currency, kind: 'sat' | 'btc' | 'fiat' | 'unknown' }; amount is null when the tag has no valid number. */
export function parsePrice(tag) {
  const n = Number(tag?.[1]);
  const amount = tag?.[1] !== undefined && tag?.[1] !== '' && Number.isFinite(n) && n >= 0 ? n : null;
  const currency = (String(tag?.[2] ?? '').trim() || 'SATS').toUpperCase();
  const kind = SAT_CODES.has(currency) ? 'sat' : currency === 'BTC' ? 'btc' : Object.prototype.hasOwnProperty.call(CURRENCIES, currency) ? 'fiat' : 'unknown';
  return { amount, currency, kind };
}

/**
 * Convert a parsed price to sats. `rates` maps CODE -> fiat units per 1 BTC.
 * Never guesses: unknown currency or a missing rate returns { ok: false, reason }.
 */
export function toSats(price, rates = {}) {
  if (price.amount == null) return { ok: false, reason: 'no valid price' };
  if (price.kind === 'sat') return { ok: true, sats: Math.round(price.amount), rate: null };
  if (price.kind === 'btc') return { ok: true, sats: Math.round(price.amount * 1e8), rate: null };
  if (price.kind === 'unknown') return { ok: false, reason: `unsupported currency ${price.currency}` };
  const rate = Number(rates[price.currency]);
  if (!Number.isFinite(rate) || rate <= 0) return { ok: false, reason: `rate unavailable for ${price.currency}` };
  return { ok: true, sats: Math.round((price.amount / rate) * 1e8), rate };
}

/** Rounds big sat amounts sensibly for "≈" display: to 3 significant digits above 10,000 sats, exact below. */
export const approxSats = (n) => (n < 10000 ? n : Number(String(Math.round(n)).replace(/^(\d{3})(\d+)$/, (_, a, b) => a + '0'.repeat(b.length))));
const grouped = (n) => Number(n).toLocaleString('en-US');
export const formatSats = (n) => `${grouped(n)} sats`;
/**
 * Display-only (cards, lists, headings). >= 1,000,000 and a multiple of 10,000 -> millions with up to 2 decimals ("1.45M sats", "2M sats");
 * 1,000..999,999 and a multiple of 1,000 -> "60K sats"; everything else keeps full digits. Never rounds. Payments use formatSats.
 */
export function compactSats(n) {
  n = Number(n);
  if (Number.isInteger(n) && n >= 1_000_000 && n % 10_000 === 0) return `${String(n / 1_000_000).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}M sats`;
  if (Number.isInteger(n) && n >= 1000 && n < 1_000_000 && n % 1000 === 0) return `${n / 1000}K sats`;
  return formatSats(n);
}

/** "$59.00 USD", "1,100.00 EUR", "0.5 BTC", "210 sats". Unknown codes show the raw code. */
export function formatMoney(price, { compact = false } = {}) {
  if (price.amount == null) return 'Price not provided';
  if (price.kind === 'sat') return compact ? compactSats(price.amount) : formatSats(price.amount);
  if (price.kind === 'btc') return `${price.amount} BTC`;
  if (price.kind === 'unknown') return `${grouped(price.amount)} ${price.currency}`;
  const c = CURRENCIES[price.currency]; const d = c.decimals ?? 2;
  return `${c.symbol}${Number(price.amount).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })} ${price.currency}`;
}
/** Card text: own currency, plus the sats equivalent for non-sat currencies. */
export function priceLabel(price, rates) {
  const own = formatMoney(price, { compact: true });
  if (price.kind === 'sat' || price.amount == null) return { text: own, payable: price.amount != null };
  const r = toSats(price, rates);
  if (price.kind === 'unknown') return { text: `${own} (not payable: unsupported currency)`, payable: false };
  return r.ok ? { text: `${own} ≈ ${compactSats(approxSats(r.sats))}`, payable: true, sats: r.sats } : { text: `${own} (rate unavailable)`, payable: false };
}
/** Seller-side check: is the token amount enough for the order, allowing rate-movement tolerance for non-sat prices? */
export const minAcceptableSats = (orderSats, isFiat) => (isFiat ? Math.floor(orderSats * (1 - TOLERANCE)) : orderSats);

/* ---------- live BTC rates: getalby (Shopstr's own source) first, mempool.space as fallback; memory + localStorage cache ---------- */
export function createRateService({ fetchImpl = globalThis.fetch?.bind(globalThis), storage = null, now = () => Date.now(), ttlMs = 5 * 60 * 1000, onChange = () => {} } = {}) {
  const mem = new Map(); const inflight = new Map();
  const readStore = () => { try { return JSON.parse(storage?.get('sr.rates') || '{}'); } catch { return {}; } };
  const writeStore = () => { try { storage?.set('sr.rates', JSON.stringify(Object.fromEntries(mem))); } catch { /* ignore */ } };
  for (const [k, v] of Object.entries(readStore())) mem.set(k, v);
  async function fetchRate(code) {
    try { const r = await fetchImpl(`https://getalby.com/api/rates/${code.toLowerCase()}.json`, { signal: AbortSignal.timeout(12000) }); if (r.ok) { const j = await r.json(); const v = Number(j.rate_float ?? j.rate); if (v > 0) return { rate: v, source: 'getalby.com' }; } } catch { /* fall through */ }
    try { const r = await fetchImpl('https://mempool.space/api/v1/prices', { signal: AbortSignal.timeout(12000) }); if (r.ok) { const j = await r.json(); const v = Number(j[code]); if (v > 0) return { rate: v, source: 'mempool.space' }; } } catch { /* unavailable */ }
    return null;
  }
  const api = {
    /** Cached rate, fresh within ttl unless allowStale. */
    peek(code, { allowStale = false } = {}) { const e = mem.get(code); return e && (allowStale || now() - e.at <= ttlMs) ? e : null; },
    /** Rates map for display (stale values are fine for a label, never for paying). */
    map() { return Object.fromEntries([...mem].map(([k, v]) => [k, v.rate])); },
    /** Ensure a fresh rate. Resolves null when unavailable. */
    async ensure(code) {
      const hit = api.peek(code); if (hit) return hit;
      if (inflight.has(code)) return inflight.get(code);
      const p = (async () => { const got = await fetchRate(code); if (got) { mem.set(code, { ...got, at: now() }); writeStore(); onChange(); } return got ? mem.get(code) : null; })().finally(() => inflight.delete(code));
      inflight.set(code, p); return p;
    },
    /** For payments: a fresh rate or a hard error. Returns { sats, rate, source, at }. */
    async quote(price) {
      if (price.kind === 'fiat') { const e = await api.ensure(price.currency); if (!e) throw new Error(`The exchange rate for ${price.currency} is unavailable right now, so this order cannot be priced. Try again shortly.`); }
      const r = toSats(price, api.map()); if (!r.ok) throw new Error(`Cannot price this listing: ${r.reason}.`);
      const e = price.kind === 'fiat' ? mem.get(price.currency) : null;
      return { sats: r.sats, rate: r.rate, source: e?.source || null, at: e?.at ? Math.floor(e.at / 1000) : null };
    },
  };
  return api;
}
