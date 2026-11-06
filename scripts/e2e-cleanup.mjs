// Teardown for automated tests: NIP-09 delete (e + a tags) of every 30402/30443/443 event of the test keys on all relays,
// plus an empty replacement for each listing (for relays that ignore kind 5), then re-query to verify.
import WebSocket from 'ws';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import * as nip19 from 'nostr-tools/nip19';
import { useWebSocketImplementation } from 'nostr-tools/pool';
useWebSocketImplementation(WebSocket);
process.on('uncaughtException', (e) => { if (/WebSocket/.test(String(e.message))) return console.error('ws error ignored:', String(e.message).slice(0, 100)); console.error(e); process.exit(1); });
process.on('unhandledRejection', () => {});

export const TEST_RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.ditto.pub', 'wss://nostr.mom', 'wss://relay.snort.social', 'wss://nostr.oxtr.dev', 'wss://offchain.pub', 'wss://nostr-pub.wellorder.net', 'wss://relay.gulugulu.moe', 'wss://freelay.sovbit.host', 'wss://relay.damus.io', 'wss://sendit.nosflare.com', 'wss://nostr.bitcoiner.social', 'wss://relay.nostr.net', 'wss://relay.coinos.io'];
const skOf = (s) => (s.startsWith('nsec') ? nip19.decode(s).data : Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16))));

export async function deleteTestEvents({ keys, relays = TEST_RELAYS, kinds = [30402, 30443, 443] }) {
  const pool = new SimplePool(); const report = [];
  for (const k of keys) {
    const sk = skOf(k); const pub = getPublicKey(sk);
    const events = (await pool.querySync(relays, { authors: [pub], kinds }, { maxWait: 6000 }));
    const uniq = [...new Map(events.map((e) => [e.id, e])).values()];
    if (uniq.length) {
      const now = Math.floor(Date.now() / 1000);
      const tags = []; for (const e of uniq) { tags.push(['e', e.id]); const d = e.tags.find((t) => t[0] === 'd')?.[1]; if (d !== undefined && e.kind >= 30000) tags.push(['a', `${e.kind}:${pub}:${d}`]); }
      for (const kind of kinds) tags.push(['k', String(kind)]);
      const del = finalizeEvent({ kind: 5, created_at: now, tags, content: 'automated test cleanup' }, sk);
      const acks = await Promise.allSettled(pool.publish(relays, del, { maxWait: 6000 }));
      // empty replacement for relays that ignore kind 5 (same coordinate, newer timestamp, no title/price/image)
      for (const e of uniq.filter((x) => x.kind === 30402)) {
        const d = e.tags.find((t) => t[0] === 'd')?.[1];
        await Promise.allSettled(pool.publish(relays, finalizeEvent({ kind: 30402, created_at: now + 1, tags: [['d', d], ['status', 'deleted']], content: '' }, sk), { maxWait: 6000 }));
      }
      report.push({ pub, deleted: uniq.length, kind5acks: acks.map((a, i) => `${relays[i]}:${a.status === 'fulfilled' ? 'ok' : String(a.reason?.message || a.reason).slice(0, 40)}`) });
    }
    await new Promise((r) => setTimeout(r, 1500));
    const left = await pool.querySync(relays, { authors: [pub], kinds: [30402] }, { maxWait: 6000 });
    const live = left.filter((e) => e.tags.some((t) => t[0] === 'title') && e.content !== '');
    report.push({ pub, remainingListingsWithTitle: live.map((e) => e.id) });
  }
  pool.destroy(); return report;
}

/** Keys are persisted the moment they exist so a crashed run can still be cleaned: node scripts/e2e-cleanup.mjs */
export const KEYS_FILE = '/private/tmp/claude-501/e2e/test-keys.json';
import fs from 'node:fs';
export function rememberKey(k) { let a = []; try { a = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch {} if (!a.includes(k)) { a.push(k); fs.writeFileSync(KEYS_FILE, JSON.stringify(a)); } }
if (process.argv[1] && process.argv[1].endsWith('e2e-cleanup.mjs')) {
  const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); console.log(JSON.stringify(await deleteTestEvents({ keys }), null, 1)); process.exit(0);
}
