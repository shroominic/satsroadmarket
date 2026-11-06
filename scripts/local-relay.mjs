// Minimal in-memory Nostr relay (NIP-01) for local dev and tests. No auth, no persistence.
import { WebSocketServer } from 'ws';
import { verifyEvent } from 'nostr-tools/pure';
import { fileURLToPath } from 'node:url';

const REPLACEABLE = k => k === 0 || k === 3 || (k >= 10000 && k < 20000);
const ADDRESSABLE = k => k >= 30000 && k < 40000;
const EPHEMERAL = k => k >= 20000 && k < 30000;

export function matches(filter, ev) {
  if (filter.ids && !filter.ids.some(p => ev.id.startsWith(p))) return false;
  if (filter.authors && !filter.authors.some(p => ev.pubkey.startsWith(p))) return false;
  if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
  if (filter.since != null && ev.created_at < filter.since) return false;
  if (filter.until != null && ev.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (key[0] !== '#' || key.length !== 2) continue;
    if (!ev.tags.some(t => t[0] === key[1] && values.includes(t[1]))) return false;
  }
  return true;
}

/** Starts a relay. port 0 picks a free port. Returns { url, port, close, events, setOffline }. */
export function startRelay({ port = 7777, host = '127.0.0.1', log = false } = {}) {
  const events = new Map(); // id -> event
  const subs = new Map(); // ws -> Map(subId -> filters)
  const wss = new WebSocketServer({ port, host });
  const say = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const dTag = ev => ev.tags.find(t => t[0] === 'd')?.[1] ?? '';

  function store(ev) {
    if (EPHEMERAL(ev.kind)) return { ok: true, message: '' };
    if (events.has(ev.id)) return { ok: true, message: 'duplicate: already have this event' };
    if (REPLACEABLE(ev.kind) || ADDRESSABLE(ev.kind)) {
      for (const old of events.values()) {
        if (old.kind === ev.kind && old.pubkey === ev.pubkey && (!ADDRESSABLE(ev.kind) || dTag(old) === dTag(ev))) {
          if (old.created_at > ev.created_at || (old.created_at === ev.created_at && old.id < ev.id)) return { ok: true, message: 'duplicate: newer version held' };
          events.delete(old.id);
        }
      }
    }
    if (ev.kind === 5) { // NIP-09 deletion by same author
      for (const t of ev.tags) {
        if (t[0] === 'e') { const old = events.get(t[1]); if (old && old.pubkey === ev.pubkey) events.delete(old.id); }
        if (t[0] === 'a') {
          const [k, pk, d] = t[1].split(':');
          for (const old of [...events.values()]) if (old.kind === +k && old.pubkey === pk && old.pubkey === ev.pubkey && dTag(old) === (d ?? '')) events.delete(old.id);
        }
      }
    }
    events.set(ev.id, ev);
    return { ok: true, message: '' };
  }

  wss.on('connection', ws => {
    subs.set(ws, new Map());
    ws.on('close', () => subs.delete(ws));
    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return say(ws, ['NOTICE', 'invalid JSON']); }
      if (!Array.isArray(msg)) return say(ws, ['NOTICE', 'invalid message']);
      const [type, ...rest] = msg;
      if (log) console.log('<-', type, JSON.stringify(rest).slice(0, 160));
      if (type === 'EVENT') {
        const ev = rest[0];
        if (!ev || typeof ev.id !== 'string') return say(ws, ['NOTICE', 'invalid event']);
        let valid = false; try { valid = verifyEvent(ev); } catch {}
        if (!valid) return say(ws, ['OK', ev.id, false, 'invalid: bad id or signature']);
        const res = store(ev);
        say(ws, ['OK', ev.id, res.ok, res.message]);
        if (res.ok && !res.message.startsWith('duplicate'))
          for (const [client, map] of subs) for (const [sid, filters] of map) if (filters.some(f => matches(f, ev))) say(client, ['EVENT', sid, ev]);
      } else if (type === 'REQ') {
        const [sid, ...filters] = rest;
        subs.get(ws).set(sid, filters);
        for (const filter of filters) {
          const found = [...events.values()].filter(e => matches(filter, e)).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
          for (const ev of found.slice(0, filter.limit ?? found.length)) say(ws, ['EVENT', sid, ev]);
        }
        say(ws, ['EOSE', sid]);
      } else if (type === 'CLOSE') {
        subs.get(ws)?.delete(rest[0]);
        say(ws, ['CLOSED', rest[0], '']);
      }
    });
  });

  return new Promise((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => {
      const actual = wss.address().port;
      resolve({
        url: `ws://${host}:${actual}`, port: actual, events,
        close: () => new Promise(res => { for (const c of wss.clients) c.terminate(); wss.close(() => res()); }),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 7777);
  startRelay({ port, log: !!process.env.RELAY_LOG }).then(r => console.log(`local relay listening on ${r.url} (in-memory, all kinds accepted)`));
}
