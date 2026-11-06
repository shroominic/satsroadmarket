/** Which vendors have a published Marmot key package (kind 30443)? Batched, cached, rate-limit friendly. */
export const SUPPORT_KEY = 'sr.marmotSupport.v1';
export const POS_TTL = 60 * 60 * 1000; // vendors found: re-check hourly
export const NEG_TTL = 10 * 60 * 1000; // not found: re-check after 10 min so new vendors appear
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createSupportCache({ pool, relays, storage = null, now = () => Date.now(), chunk = 50, delayMs = 600, onChange = () => {}, cap = 2000 }) {
  const map = new Map(); let inflight = null; const queued = new Set(); let timer;
  try { const raw = JSON.parse(storage?.get(SUPPORT_KEY) || '{}'); for (const [k, v] of Object.entries(raw)) map.set(k, v); } catch { /* ignore */ }
  const save = () => { clearTimeout(timer); timer = setTimeout(() => { try { const e = [...map].sort((a, b) => b[1].at - a[1].at).slice(0, cap); storage?.set(SUPPORT_KEY, JSON.stringify(Object.fromEntries(e))); } catch { /* ignore */ } }, 500); };
  const fresh = (e) => e && now() - e.at < (e.v ? POS_TTL : NEG_TTL);
  const api = {
    /** true / false when known, undefined when never looked up. Stale values are still returned (the UI refreshes them in the background). */
    get: (pk) => map.get(pk)?.v,
    /** Authors that need a (re)lookup. */
    stale: (pks) => [...new Set(pks)].filter((pk) => !fresh(map.get(pk))),
    /** One REQ per chunk of up to 50 authors, chunks sequential with a small delay. */
    async ensure(pks) {
      for (const pk of api.stale(pks)) queued.add(pk);
      if (inflight) return inflight;
      if (!queued.size) return;
      const run = (async () => {
        {
          while (queued.size) {
            const batch = [...queued].slice(0, chunk); batch.forEach((pk) => queued.delete(pk));
            let evs = []; let ok = true;
            try { evs = await pool.querySync(relays, { kinds: [30443, 10050], authors: batch, limit: batch.length * 3 }, { maxWait: 6000 }); } catch { ok = false; }
            if (ok) {
              const has = new Set(evs.filter((e) => e.kind === 30443).map((e) => e.pubkey));
              for (const pk of batch) map.set(pk, { v: has.has(pk), at: now() });
              onChange(); save();
            }
            if (queued.size) await sleep(delayMs);
          }
        }
      })();
      inflight = run; run.finally(() => { if (inflight === run) inflight = null; });
      return run;
    },
  };
  return api;
}
