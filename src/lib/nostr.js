/** Identity, relay list, relay ACK reporting and Blossom upload. No framework, no DOM. */
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';

/* ---------- safe storage (private windows / blocked storage must not crash the app) ---------- */
export const storage = {
  get(key) { try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; } },
  set(key, value) { try { globalThis.localStorage?.setItem(key, value); return true; } catch { return false; } },
  del(key) { try { globalThis.localStorage?.removeItem(key); } catch { /* ignore */ } },
  getJSON(key, fallback) { try { const raw = this.get(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } },
  setJSON(key, value) { return this.set(key, JSON.stringify(value)); },
};

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const fromHex = (hex) => Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));

/* ---------- identity ---------- */
const IDENTITY_KEY = 'sr.nsec';

/** Accepts nsec1… or 64-char hex. Returns { sk, pubkey, npub, nsec }. */
export function identityFromSecret(input) {
  const value = String(input || '').trim();
  let sk;
  if (/^nsec1/i.test(value)) {
    let decoded;
    try { decoded = nip19.decode(value.toLowerCase()); } catch { throw new Error('That nsec is not valid (bad checksum or characters).'); }
    if (decoded.type !== 'nsec') throw new Error('That is not an nsec private key.');
    sk = decoded.data;
  } else if (/^[0-9a-f]{64}$/i.test(value)) sk = fromHex(value.toLowerCase());
  else throw new Error('Enter an nsec1… key or 64 hex characters.');
  const pubkey = getPublicKey(sk);
  return { sk, pubkey, npub: nip19.npubEncode(pubkey), nsec: nip19.nsecEncode(sk) };
}
export const newIdentity = () => identityFromSecret(toHex(generateSecretKey()));
export function loadIdentity() {
  const stored = storage.get(IDENTITY_KEY);
  if (!stored) return null;
  try { return identityFromSecret(stored); } catch { return null; }
}
export function saveIdentity(identity) { if (!storage.set(IDENTITY_KEY, identity.nsec)) throw new Error('Browser storage is blocked, so this identity cannot be saved on this device.'); }
export function forgetIdentity() { storage.del(IDENTITY_KEY); }
export const signerFor = (identity) => ({ pubkey: identity.pubkey, signEvent: async (template) => finalizeEvent(template, identity.sk) });
export const shortKey = (hexOrNpub) => { const s = hexOrNpub.length === 64 ? nip19.npubEncode(hexOrNpub) : hexOrNpub; return `${s.slice(0, 10)}…${s.slice(-6)}`; };
export const npubOf = (pubkey) => nip19.npubEncode(pubkey);

/* ---------- relay list ---------- */
export const LOCAL_RELAY = 'ws://127.0.0.1:7777';
const RELAYS_KEY = 'sr.relays';
export function normalizeRelay(input) {
  let value = String(input || '').trim();
  if (!value) throw new Error('Enter a relay address.');
  if (!/^[a-z]+:\/\//i.test(value)) value = `wss://${value}`;
  let url;
  try { url = new URL(value); } catch { throw new Error('That relay address is not a valid URL.'); }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new Error('Relay addresses must start with wss:// or ws://.');
  if (url.username || url.password) throw new Error('Relay addresses must not contain credentials.');
  return url.href.replace(/\/$/, '');
}
export function defaultRelays(hostname = globalThis.location?.hostname || '') {
  const local = ['localhost', '127.0.0.1', '[::1]', ''].includes(hostname);
  return local ? [LOCAL_RELAY] : [LOCAL_RELAY, 'wss://relay.damus.io', 'wss://nos.lol'];
}
export function loadRelays() {
  const stored = storage.getJSON(RELAYS_KEY, null);
  if (Array.isArray(stored)) { const ok = stored.filter((u) => { try { normalizeRelay(u); return true; } catch { return false; } }); if (ok.length) return ok; }
  return defaultRelays();
}
export const saveRelays = (relays) => storage.setJSON(RELAYS_KEY, relays);

/** Reachability probe: opens a WebSocket and waits for the handshake. */
export function probeRelay(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const started = performance.now();
    let ws; let done = false;
    const finish = (state, error = '') => { if (done) return; done = true; clearTimeout(timer); try { ws?.close(); } catch { /* ignore */ } resolve({ url, state, ms: Math.round(performance.now() - started), error }); };
    const timer = setTimeout(() => finish('offline', 'Connection timed out'), timeoutMs);
    try {
      ws = new WebSocket(url);
      ws.onopen = () => finish('online');
      ws.onerror = () => finish('offline', 'Connection refused or blocked');
      ws.onclose = () => finish('offline', 'Connection closed');
    } catch (error) { finish('offline', error.message); }
  });
}

/* ---------- relay acknowledgements ---------- */
const withTimeout = (promise, ms, message) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer)); };

/** Publish to every relay and report each relay's own answer. Never throws for a single relay failing. */
export async function publishWithAcks(pool, relays, event, timeoutMs = 8000) {
  const promises = pool.publish(relays, event);
  const settled = await Promise.allSettled(promises.map((p, i) => withTimeout(Promise.resolve(p), timeoutMs, `No answer from ${relays[i]} within ${Math.round(timeoutMs / 1000)}s`)));
  return settled.map((result, i) => result.status === 'fulfilled'
    ? { relay: relays[i], ok: true, message: String(result.value || 'accepted') }
    : { relay: relays[i], ok: false, message: String(result.reason?.message || result.reason || 'failed') });
}

/* ---------- Blossom (BUD-02) upload with kind 24242 auth ---------- */
export const DEFAULT_BLOSSOM = 'https://blossom.primal.net';
export async function sha256Hex(buffer) { return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))); }
export function blossomAuthTemplate({ hash, name = 'upload', now = Math.floor(Date.now() / 1000), ttl = 300 }) {
  return { kind: 24242, created_at: now, content: `Upload ${name}`, tags: [['t', 'upload'], ['x', hash], ['expiration', String(now + ttl)]] };
}
export async function uploadToBlossom({ server, file, signer, fetchImpl = fetch }) {
  if (!signer) throw new Error('Create or import an identity before uploading.');
  if (!file) throw new Error('Choose an image first.');
  if (!/^image\//.test(file.type)) throw new Error('Only image files can be uploaded.');
  if (file.size > 10 * 1024 * 1024) throw new Error('Image is larger than 10 MB.');
  let base;
  try { base = new URL(server); if (!/^https?:$/.test(base.protocol)) throw new Error(); } catch { throw new Error('The Blossom server address is not a valid http(s) URL.'); }
  const buffer = await file.arrayBuffer();
  const hash = await sha256Hex(buffer);
  const auth = await signer.signEvent(blossomAuthTemplate({ hash, name: file.name }));
  let response;
  try {
    response = await fetchImpl(new URL('/upload', base).href, { method: 'PUT', body: buffer, headers: { 'Content-Type': file.type, 'X-SHA-256': hash, Authorization: `Nostr ${btoa(JSON.stringify(auth))}` } });
  } catch (error) { throw new Error(`Could not reach the Blossom server (${error.message}). The server may be offline or block browser uploads (CORS).`); }
  if (!response.ok) {
    const reason = response.headers.get('X-Reason') || (await response.text().catch(() => '')).slice(0, 200) || response.statusText;
    throw new Error(`Blossom server refused the upload (HTTP ${response.status}${reason ? `: ${reason}` : ''}).`);
  }
  const body = await response.json().catch(() => null);
  if (!body?.url) throw new Error('Blossom server accepted the upload but returned no file URL.');
  return { url: body.url, sha256: body.sha256 || hash };
}
