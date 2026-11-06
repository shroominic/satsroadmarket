/**
 * Listing loader: streamed first page, cursor-based background paging (one REQ per relay at a time, with backoff),
 * merge/dedupe by address, NIP-09 deletions, expiration, and a versioned persistent cache. The pool and storage are injected.
 */
import { latestListings } from './listings.js';

export const CACHE_VERSION = 1;
export const CACHE_KEY = `listings.v${CACHE_VERSION}`;
export const PROFILE_KEY = `profiles.v${CACHE_VERSION}`;
export const MAX_CACHED = 2000;
export const BASE_FILTER = { kinds: [30402], '#t': ['shopstr'] };

const tagOf = (e, name) => e.tags.find((t) => t[0] === name)?.[1];
export const addressOf = (e) => `30402:${e.pubkey}:${tagOf(e, 'd') ?? ''}`;
export const isExpired = (e, now) => { const x = Number(tagOf(e, 'expiration')); return Number.isFinite(x) && x > 0 && x <= now; };

export const newStore = () => ({ events: new Map(), deleted: new Map(), deletedIds: new Set() });

/** Merge events (pure, in place). Newest wins per address (tie: lower id). Returns how many entries changed. */
export function mergeEvents(store, events, now = Math.floor(Date.now() / 1000)) {
  let changed = 0;
  for (const e of events) {
    if (e.kind !== 30402 || !tagOf(e, 'd') || isExpired(e, now) || store.deletedIds.has(e.id)) continue;
    const a = addressOf(e);
    if ((store.deleted.get(a) ?? -1) >= e.created_at) continue; // a kind 5 covers this version
    const prev = store.events.get(a);
    if (prev && (prev.created_at > e.created_at || (prev.created_at === e.created_at && prev.id <= e.id))) continue;
    store.events.set(a, e); changed++;
  }
  return changed;
}
/** NIP-09: a kind 5 only counts when its author owns the target. Returns how many stored listings were removed. */
export function applyDeletions(store, deletions) {
  let removed = 0;
  for (const d of deletions) {
    if (d.kind !== 5) continue;
    for (const t of d.tags) {
      if (t[0] === 'a') {
        const [kind, pub] = String(t[1]).split(':'); if (kind !== '30402' || pub !== d.pubkey) continue;
        store.deleted.set(t[1], Math.max(store.deleted.get(t[1]) ?? 0, d.created_at));
        const cur = store.events.get(t[1]); if (cur && cur.created_at <= d.created_at) { store.events.delete(t[1]); removed++; }
      } else if (t[0] === 'e') {
        for (const [a, ev] of store.events) if (ev.id === t[1] && ev.pubkey === d.pubkey) { store.events.delete(a); store.deletedIds.add(ev.id); removed++; }
        // remember the id too, so a late copy of the same event is ignored
        store.deletedIds.add(t[1]);
      }
    }
  }
  return removed;
}
export function dropExpired(store, now = Math.floor(Date.now() / 1000)) { for (const [a, e] of store.events) if (isExpired(e, now)) store.events.delete(a); }
/** Next `until` cursor for a relay: one second older than the oldest event seen, or null when a page was empty. */
export const nextCursor = (events) => (events.length ? Math.min(...events.map((e) => e.created_at)) - 1 : null);
export function trimStore(store, cap = MAX_CACHED) {
  if (store.events.size <= cap) return 0;
  const keep = [...store.events.entries()].sort((a, b) => b[1].created_at - a[1].created_at).slice(0, cap);
  const dropped = store.events.size - keep.length; store.events = new Map(keep); return dropped;
}
export const serialize = (store, cursors, lastFetched) => ({ v: CACHE_VERSION, events: [...store.events.values()], deleted: [...store.deleted], deletedIds: [...store.deletedIds].slice(-2000), cursors, lastFetched });
export function hydrate(blob) {
  if (!blob || blob.v !== CACHE_VERSION || !Array.isArray(blob.events)) return null;
  const store = newStore();
  for (const e of blob.events) if (e?.id && Array.isArray(e.tags)) store.events.set(addressOf(e), e);
  for (const [a, t] of blob.deleted || []) store.deleted.set(a, t);
  for (const id of blob.deletedIds || []) store.deletedIds.add(id);
  return { store, cursors: blob.cursors || {}, lastFetched: blob.lastFetched || 0 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createListingLoader({ pool, relays, storage, onChange = () => {}, now = () => Math.floor(Date.now() / 1000), pageSize = 100, delayMs = 700, maxWait = 6000, cap = MAX_CACHED }) {
  let store = newStore(); const cursors = {}; let lastFetched = 0; let busy = false; let saveTimer = null; let cacheHit = false;
  const cur = (r) => (cursors[r] ||= { until: null, done: false, failures: 0, backoffUntil: 0 });
  const changed = () => { try { onChange(); } catch { /* ignore */ } schedulePersist(); };

  async function persist() {
    try { trimStore(store, cap); await storage?.set(CACHE_KEY, serialize(store, cursors, lastFetched)); } catch { /* storage may be blocked or full: the app keeps working without a cache */ }
  }
  function schedulePersist() { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 400); }

  const api = {
    get cacheHit() { return cacheHit; }, get busy() { return busy; }, get lastFetched() { return lastFetched; }, get size() { return store.events.size; },
    cursors, persist,
    listings() { dropExpired(store, now()); return latestListings([...store.events.values()]); },
    /** Render-from-cache. Resolves with the number of cached events (0 when none/unreadable). */
    async loadCache() {
      try { const h = hydrate(await storage?.get(CACHE_KEY)); if (!h) return 0; store = h.store; Object.assign(cursors, h.cursors); lastFetched = h.lastFetched; cacheHit = store.events.size > 0; if (cacheHit) onChange(); return store.events.size; }
      catch { return 0; }
    },
    /**
     * Newest page, streamed. With a cache only events since the last fetch are requested; without one each relay returns its newest page
     * (one REQ per relay) and its cursor is set from its own oldest event.
     */
    async initial() {
      busy = true;
      const started = now();
      await Promise.all(relays.map((r) => new Promise((resolve) => {
        const known = lastFetched && (cursors[r]?.until != null || cursors[r]?.done); // this relay already has a cursor from the cache
        const since = known ? { since: Math.max(0, lastFetched - 120) } : {};
        const seen = []; let timer;
        const finish = () => { clearTimeout(timer); try { sub?.close(); } catch { /* ignore */ } resolve(); };
        let sub;
        try {
          sub = pool.subscribeMany([r], { ...BASE_FILTER, ...since, limit: pageSize }, {
            onevent: (e) => { seen.push(e); if (mergeEvents(store, [e], now())) { clearTimeout(api._t); api._t = setTimeout(changed, 60); } },
            oneose: () => { if (!since.since) { const c = cur(r); c.until = nextCursor(seen); c.done = !seen.length; } finish(); },
            onclose: () => resolve(),
          });
        } catch { resolve(); return; }
        timer = setTimeout(finish, maxWait);
      })));
      try { const dels = await pool.querySync(relays, { kinds: [5], '#k': ['30402'], since: lastFetched ? Math.max(0, lastFetched - 120) : started - 30 * 86400, limit: 300 }, { maxWait }); if (applyDeletions(store, dels)) dropExpired(store); } catch { /* deletions are best effort */ }
      lastFetched = started; busy = false; changed(); return store.events.size;
    },
    /** Page older events, at most one REQ per relay at a time, `pages` pages with a small delay, exponential backoff on errors. */
    async more(pages = 1) {
      if (busy) return 0; busy = true; let added = 0;
      try {
        await Promise.all(relays.map(async (r) => {
          for (let i = 0; i < pages; i++) {
            const c = cur(r);
            if (c.done || c.until == null || now() < c.backoffUntil) return;
            try {
              const evs = await pool.querySync([r], { ...BASE_FILTER, until: c.until, limit: pageSize }, { maxWait });
              c.failures = 0;
              if (!evs.length) { c.done = true; return; }
              added += mergeEvents(store, evs, now()); c.until = nextCursor(evs);
            } catch { c.failures++; c.backoffUntil = now() + 2 ** c.failures * 2; if (c.failures >= 4) c.done = true; return; }
            changed(); if (i < pages - 1) await sleep(delayMs);
          }
        }));
      } finally { busy = false; changed(); }
      return added;
    },
    exhausted() { return relays.every((r) => cursors[r]?.done); },
    stop() { clearTimeout(saveTimer); clearTimeout(api._t); },
  };
  return api;
}

/* ---------------- seller profiles (kind 0) ---------------- */
export function createProfileCache({ pool, relays, storage, now = () => Math.floor(Date.now() / 1000), ttl = 86400, onChange = () => {} }) {
  const map = new Map(); let loaded = false; let timer;
  const save = () => { clearTimeout(timer); timer = setTimeout(async () => { try { await storage?.set(PROFILE_KEY, { v: CACHE_VERSION, profiles: [...map].slice(-1000) }); } catch { /* ignore */ } }, 500); };
  return {
    async load() { if (loaded) return; loaded = true; try { const b = await storage?.get(PROFILE_KEY); if (b?.v === CACHE_VERSION) for (const [k, v] of b.profiles) map.set(k, v); onChange(); } catch { /* ignore */ } },
    get: (pubkey) => map.get(pubkey)?.p || null,
    async ensure(pubkeys) {
      const need = [...new Set(pubkeys)].filter((p) => !map.has(p) || now() - map.get(p).at > ttl);
      for (let i = 0; i < need.length; i += 40) {
        const batch = need.slice(i, i + 40);
        try {
          const evs = await pool.querySync(relays, { kinds: [0], authors: batch }, { maxWait: 5000 });
          const best = new Map(); for (const e of evs) if (!best.has(e.pubkey) || best.get(e.pubkey).created_at < e.created_at) best.set(e.pubkey, e);
          for (const p of batch) { const e = best.get(p); let prof = {}; try { const j = JSON.parse(e?.content || '{}'); prof = { name: String(j.display_name || j.name || '').slice(0, 60), picture: typeof j.picture === 'string' && /^https?:/.test(j.picture) ? j.picture : '' }; } catch { /* ignore */ } map.set(p, { p: prof, at: now() }); }
          onChange(); save();
        } catch { /* try again later */ }
        if (i + 40 < need.length) await sleep(500);
      }
    },
  };
}
