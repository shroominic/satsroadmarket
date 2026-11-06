import WebSocket from 'ws'; import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'; useWebSocketImplementation(WebSocket);
process.on('uncaughtException', () => {});
const relays = ['wss://nos.lol','wss://relay.primal.net','wss://purplepag.es','wss://relay.nostr.band','wss://nostr.mom','wss://relay.snort.social','wss://nostr.oxtr.dev','wss://relay.ditto.pub','wss://relay.gulugulu.moe','wss://freelay.sovbit.host','wss://relay.damus.io','wss://nostr.bitcoiner.social','wss://relay.coinos.io','wss://offchain.pub','wss://nostr-pub.wellorder.net','wss://relay.nostr.net','wss://relay.noswhere.com'];
const pool = new SimplePool(); const seen = new Map();
await Promise.all(relays.map(async (r) => { try { const evs = await pool.querySync([r], { kinds: [30402], '#t': ['shopstr'], limit: 500 }, { maxWait: 8000 }); for (const e of evs) { const t = e.tags.find(x=>x[0]==='title')?.[1]||''; const d = e.tags.find(x=>x[0]==='d')?.[1]||''; if (/^probe/i.test(t)||/^probe-/.test(d)||/^\[test\]/i.test(t)||/Test camel saddle|Fail-/.test(t)) { const k=e.id; if(!seen.has(k)) seen.set(k,{id:e.id,pub:e.pubkey.slice(0,8),d,t,relays:[]}); seen.get(k).relays.push(r.replace('wss://','')); } } } catch {} }));
console.log(JSON.stringify([...seen.values()], null, 0).replace(/\},/g, '},\n'));
console.log('total', seen.size); process.exit(0);
