/**
 * Marmot (MLS over Nostr) messaging for SatsRoad Market, on @internet-privacy/marmot-ts 0.9.0.
 *
 * Works in the browser (localforage/IndexedDB) and in Node (inject `storeFactory`, or load
 * `fake-indexeddb/auto` before this module). Local state and history are NOT encrypted at rest.
 *
 * Publish results are real per-relay ACKs: `{ [relayUrl]: { from, ok, message, uncertain? } }`.
 * "ok" means the relay accepted the event, not that the other party has read it.
 */
import { MarmotClient, createApplicationMessageIntent, createInviteIntent } from '@internet-privacy/marmot-ts';
import { makeKeyValueRumorHistoryFactory } from '@internet-privacy/marmot-ts/extra';
import { PrivateKeySigner } from 'applesauce-signers';
import { SimplePool } from 'nostr-tools/pool';
import { getEventHash } from 'nostr-tools/pure';
import { normalizeURL } from 'nostr-tools/utils';
import { createInboxRelayListEvent, createNip65RelayListEvent } from '@internet-privacy/marmot-ts';
import localforage from 'localforage';

const KIND_KEY_PACKAGE = 30443;
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const asFilters = filters => Array.isArray(filters) ? filters : [filters];
const anyOk = results => Object.values(results || {}).some(r => r?.ok);

/** Typed error. code: NO_KEY_PACKAGE | NO_RELAY_ACK | PERSIST_FAILED | INVITE_NOT_FOUND | INVALID_MESSAGE | UNKNOWN_GROUP | NOTHING_PENDING */
export class MarmotError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'MarmotError'; this.code = code; Object.assign(this, extra); }
}

/**
 * Nostr network for marmot-ts over a nostr-tools SimplePool.
 * Every publish is reported per relay; failures are `{ok:false}` with the relay's/transport's reason.
 */
export function createMarmotNetwork(pool, fallbackRelays, { onError = () => {}, onPublish = () => {}, publishTimeout = 5000 } = {}) {
  return {
    async publish(relays, event) {
      const settled = await Promise.allSettled(pool.publish(relays, event, { maxWait: publishTimeout }));
      const result = Object.fromEntries(settled.map((r, i) => {
        const message = r.status === 'fulfilled' ? String(r.value ?? '') : String(r.reason?.message ?? r.reason);
        // A timeout means we do not know whether the relay stored it.
        return [relays[i], r.status === 'fulfilled'
          ? { from: relays[i], ok: true, message }
          : { from: relays[i], ok: false, uncertain: /timed out/i.test(message), message }];
      }));
      onPublish({ kind: event.kind, id: event.id, results: result });
      return result;
    },
    async request(relays, filters) {
      const batches = await Promise.all(asFilters(filters).map(f => pool.querySync(relays, f, { maxWait: 5000 })));
      return [...new Map(batches.flat().map(e => [e.id, e])).values()];
    },
    subscription(relays, filters) {
      return { subscribe(observer) {
        let closed = false, subs = [], timer, attempt = 0;
        const open = () => {
          subs = asFilters(filters).map(f => pool.subscribeMany(relays, f, {
            onevent: e => { attempt = 0; observer.next?.(e); },
            onclose: reasons => {
              if (closed) return;
              // nostr-tools does not resubscribe after a failed connect: do it ourselves with backoff.
              const err = new Error(`Relay subscription closed: ${JSON.stringify(reasons)}; reconnecting`);
              onError(err);
              clearTimeout(timer);
              timer = setTimeout(() => { if (!closed) { subs.forEach(s => { try { s.close(); } catch {} }); open(); } }, Math.min(500 * 2 ** attempt++, 10000));
            },
          }));
        };
        open();
        return { unsubscribe: () => { closed = true; clearTimeout(timer); subs.forEach(s => { try { s.close(); } catch {} }); } };
      } };
    },
    async getUserInboxRelays(pubkey) {
      const events = await this.request(fallbackRelays, { kinds: [10050], authors: [pubkey], limit: 5 });
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
      const urls = newest?.tags.filter(t => t[0] === 'relay').map(t => t[1]) || [];
      return urls.length ? urls : fallbackRelays;
    },
  };
}

/** Default browser store: one IndexedDB database per identity, one object store per name. */
export const localforageStoreFactory = (pubkey, name) => localforage.createInstance({ name: `satsroad-marmot-${pubkey}`, storeName: name });

function emitter() {
  const handlers = new Map();
  return {
    on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); return () => handlers.get(event)?.delete(fn); },
    emit(event, payload) { for (const fn of handlers.get(event) || []) { try { fn(payload); } catch (e) { console.error('marmot handler failed', e); } } },
  };
}

/**
 * @param {object} o
 * @param {Uint8Array|string} o.privateKey  32 bytes, hex or nsec
 * @param {string[]} o.relays               relays for key packages, welcomes (inbox) and groups
 * @param {(pubkey:string,name:string)=>object} [o.storeFactory]  returns a GenericKeyValueStore (getItem/setItem/removeItem/clear/keys); default localforage
 * @param {object} [o.network]              override the NostrNetworkInterface (tests)
 */
export async function createMarmot({ privateKey, relays: rawRelays, storeFactory = localforageStoreFactory, network: suppliedNetwork, clientName = 'satsroad-market' }) {
  if (!rawRelays?.length) throw new MarmotError('NO_RELAYS', 'At least one relay is required.');
  const relays = [...new Set(rawRelays.map(normalizeURL))]; // result keys are normalized URLs (trailing slash)
  const signer = PrivateKeySigner.fromKey(privateKey);
  const pubkey = await signer.getPublicKey();
  const bus = emitter();
  const emitError = e => bus.emit('error', e);
  const publishLog = [];

  const pool = suppliedNetwork ? null : new SimplePool({ enableReconnect: true });
  const baseNetwork = suppliedNetwork || createMarmotNetwork(pool, relays, { onError: emitError });
  // Record every publish with its per-relay result, so failures are visible even when marmot-ts throws.
  const network = Object.create(baseNetwork);
  network.publish = async (rs, event) => {
    const results = await baseNetwork.publish(rs, event);
    const entry = { kind: event.kind, id: event.id, results };
    publishLog.push(entry); if (publishLog.length > 200) publishLog.shift(); bus.emit('publish', entry);
    return results;
  };
  const store = name => storeFactory(pubkey, name);

  const config = store('config');
  let clientId = await config.getItem('clientId');
  if (!clientId) { clientId = hex(crypto.getRandomValues(new Uint8Array(32))); await config.setItem('clientId', clientId); }

  const client = new MarmotClient({
    signer, network, clientId,
    groupStateStore: store('groups'), keyPackageStore: store('keys'), inviteStore: store('invites'),
    ingestStateStore: store('ingest'), rewindStore: store('rewind'), removedMarkerStore: store('removed'),
    historyFactory: makeKeyValueRumorHistoryFactory(id => store(`history_${hex(id)}`)),
  });

  // Track which welcomes could not be delivered (kept in the store so a restart can retry).
  const pendingWelcomes = store('pendingWelcomes');
  const welcomeWork = new Map(); // groupId -> in-memory work (needed to re-wrap the welcome)

  // Rumor created_at has 1 s resolution and the history backend is unordered within a second,
  // so remember local arrival order to keep same-second messages (e.g. token then receipt) in sequence.
  const arrival = store('arrival');
  let lastSeq = 0, arrivalQueue = Promise.resolve();
  const noteArrival = (groupId, rumorId) => {
    const seq = lastSeq = Math.max(lastSeq + 1, Date.now() * 1000);
    arrivalQueue = arrivalQueue.then(async () => { const key = `${groupId}:${rumorId}`; if ((await arrival.getItem(key)) == null) await arrival.setItem(key, seq); }).catch(emitError);
  };

  // marmot-ts retries unacknowledged commits itself but does not keep unacknowledged application messages,
  // so we keep our own outbox and re-send the same rumor (same id) on retryPending().
  const outbox = store('outbox');
  const outboxKeys = async groupId => (await outbox.keys()).filter(k => k.startsWith(`${groupId}:`));
  const sendRumor = (groupId, rumor) => client.groups.send(groupId, createApplicationMessageIntent(rumor));

  const attached = new WeakSet();
  const attach = group => {
    if (attached.has(group)) return; attached.add(group);
    const groupId = group.idStr;
    group.history?.on('rumor', rumor => { noteArrival(groupId, rumor.id); bus.emit('message', { groupId, rumor, own: rumor.pubkey === pubkey }); });
    group.on('historyError', e => emitError(e));
    group.on('changed', () => bus.emit('change', { groupId }));
  };
  for (const ev of ['loaded', 'created', 'joined', 'imported']) client.groups.on(ev, g => { attach(g); bus.emit('group', { groupId: g.idStr, event: ev }); });
  client.groups.on('unreadable', (...args) => emitError(new Error(`A group event could not be read: ${String(args.at(-1))}`)));
  client.invites.on('decrypted', invite => bus.emit('invite', summariseInvite(invite)));
  client.invites.on('error', e => emitError(e));

  function summariseInvite(invite) {
    return { id: invite.id, from: invite.pubkey, created_at: invite.created_at };
  }

  let inviteSub, groupsSub, started = false;

  async function publishRelayLists() {
    const out = {};
    const inbox = await signer.signEvent(createInboxRelayListEvent({ pubkey, relays }));
    out.inbox = await network.publish(relays, inbox);
    const nip65 = await signer.signEvent(createNip65RelayListEvent({ pubkey, relays }));
    out.nip65 = await network.publish(relays, nip65);
    return out;
  }

  async function findKeyPackage(recipient) {
    let lookup = relays;
    try { // the recipient's NIP-65 write relays are where inviters should look
      const lists = await network.request(relays, { kinds: [10002], authors: [recipient], limit: 3 });
      const newest = lists.sort((a, b) => b.created_at - a.created_at)[0];
      const write = newest?.tags.filter(t => t[0] === 'r' && (!t[2] || t[2] === 'write')).map(t => t[1]) || [];
      lookup = [...new Set([...relays, ...write])];
    } catch { /* fall back to our relays */ }
    const events = await network.request(lookup, { kinds: [KIND_KEY_PACKAGE], authors: [recipient], limit: 20 });
    return events.sort((a, b) => b.created_at - a.created_at);
  }

  const lastResults = mark => Object.assign({}, ...publishLog.slice(mark).map(e => e.results));
  const publishFailure = (e, groupId, mark, extra = {}) => new MarmotError('NO_RELAY_ACK', `Not acknowledged by any relay (${e.message}). It is kept locally; call retryPending(groupId) when a relay is reachable.`, { groupId, results: lastResults(mark), cause: e, ...extra });

  const api = {
    pubkey, client, relays, clientId, publishLog,

    /** Subscribe: 'invite' {id,from}, 'group' {groupId,event}, 'message' {groupId,rumor,own}, 'change' {groupId}, 'publish' {kind,id,results}, 'error' Error. Returns unsubscribe. */
    on: bus.on,

    /** Load persisted groups, resume receiving (backfill + live) and listen for welcomes. Idempotent. */
    async start() {
      if (started) return; started = true;
      await client.groups.loadAll();
      for (const g of client.groups.loaded) attach(g);
      groupsSub = client.groups.connectAll();
      inviteSub = await client.invites.listen(relays);
      bus.emit('change', {});
    },

    stop() {
      started = false;
      inviteSub?.unsubscribe(); groupsSub?.unsubscribe();
      for (const g of client.groups.loaded) g.removeAllListeners?.();
      pool?.destroy();
    },

    /**
     * Make this identity invitable: publish relay lists (10050/10002) and a key package (30443).
     * Verifies against the relays and republishes if the relay no longer holds it (e.g. relay restarted).
     * @returns {{ok:boolean, keyPackage:{id:string,results:object}, relayLists:object}} results are per-relay ACKs
     */
    async publishKeyPackage() {
      const relayLists = await publishRelayLists();
      const before = publishLog.length;
      let listed = await client.keyPackages.ensurePublished({ relays, client: clientName });
      let published = publishLog.slice(before).filter(e => e.kind === KIND_KEY_PACKAGE).at(-1);
      const onRelays = await network.request(relays, { kinds: [KIND_KEY_PACKAGE], authors: [pubkey], limit: 5 }).catch(() => []);
      if (!onRelays.length || !published) {
        // Local package exists but no relay holds it (lost, or ensurePublished was a no-op): publish a fresh one into the same slot.
        if (!onRelays.length) {
          const mark = publishLog.length;
          listed = await client.keyPackages.create({ relays, client: clientName });
          published = publishLog.slice(mark).filter(e => e.kind === KIND_KEY_PACKAGE).at(-1);
        } else published = { id: onRelays[0].id, results: Object.fromEntries(relays.map(r => [r, { from: r, ok: true, message: 'already published' }])) };
      }
      const results = published?.results || {};
      return { ok: anyOk(results), keyPackage: { id: published?.id, results }, relayLists };
    },

    /**
     * Create a group with `sellerPubkey` and invite them with a Welcome (gift wrap, kind 1059).
     * The Welcome stays on the relay, so a seller who comes online later still receives it.
     * @throws MarmotError NO_KEY_PACKAGE (nothing created), NO_RELAY_ACK (commit not acknowledged; group kept locally)
     * @returns {{groupId, welcome:{delivered:boolean, results:object[]}, commit:object}}
     */
    async startConversation(sellerPubkey, { listingRef, title = 'Private order' } = {}) {
      if (sellerPubkey === pubkey) throw new MarmotError('INVALID_MESSAGE', 'Cannot start a conversation with yourself.');
      const packages = await findKeyPackage(sellerPubkey);
      if (!packages.length) throw new MarmotError('NO_KEY_PACKAGE', 'Seller has no published Marmot key package. They must open the app (publish a key package) before you can start a private conversation.', { sellerPubkey });
      const intentFor = ev => createInviteIntent({ keyPackageEvent: ev, actorPubkey: pubkey });
      let keyPackageEvent = packages[0];
      const group = await client.groups.create(title, { relays, adminPubkeys: [pubkey], description: listingRef ? JSON.stringify({ listingRef }) : '' });
      const results = await client.groups.send(group.id, intentFor(keyPackageEvent));
      const result = results[0];
      if (!result || !anyOk(result.response)) throw new MarmotError('NO_RELAY_ACK', 'The invite commit was not acknowledged by any relay.', { groupId: group.idStr, results: result?.response });
      if (result.persistence?.kind === 'failed') throw new MarmotError('PERSIST_FAILED', `Relay accepted the invite but saving group state failed: ${result.persistence.error}`, { groupId: group.idStr });
      const welcome = describeWelcome(result, sellerPubkey);
      if (!welcome.delivered && result.work?.welcome && result.work?.welcomeRecipients) welcomeWork.set(group.idStr, result.work);
      return { groupId: group.idStr, welcome, commit: result.response };
    },

    /** Re-send a Welcome that was not acknowledged. Works within this session; after a restart ask the peer to publish a new key package and start again. */
    async retryWelcome(groupId) {
      const work = welcomeWork.get(groupId);
      if (!work) throw new MarmotError('NOTHING_PENDING', 'No undelivered welcome is held for this group.');
      const group = await client.groups.get(groupId);
      const outcomes = await group.runtime.welcomeDelivery.deliverMany({ welcome: work.welcome, author: pubkey, groupRelays: group.relays, recipients: work.welcomeRecipients });
      const ok = outcomes.every(o => o.kind === 'succeeded');
      if (ok) welcomeWork.delete(groupId);
      return { delivered: ok, results: outcomes.map(o => o.kind === 'succeeded' ? { ok: true, recipient: o.recipient.pubkey, relays: o.response } : { ok: false, recipient: o.recipient.pubkey, error: o.error }) };
    },

    /** Unread, decrypted welcomes. Each: {id, from, joinable, group:{name,listingRef}} */
    async listInvites() {
      const invites = await client.invites.getUnread();
      return Promise.all(invites.map(async invite => {
        let joinable = false, preview = null;
        try { joinable = await client.canJoinInvite(invite); preview = await client.previewWelcome(invite); } catch (e) { emitError(e); }
        return { ...summariseInvite(invite), joinable, group: preview?.group ? { name: preview.group.name, listingRef: parseListingRef(preview.group.description) } : null };
      }));
    },

    /** Join the group from a welcome, mark it read, rotate the consumed key package. @returns groupId */
    async acceptInvite(inviteId) {
      const invite = (await client.invites.getUnread()).find(i => i.id === inviteId);
      if (!invite) throw new MarmotError('INVITE_NOT_FOUND', 'Invite no longer available.');
      const { group } = await client.joinGroupFromWelcome({ welcomeRumor: invite });
      attach(group);
      await client.invites.markAsRead(inviteId);
      groupsSub?.unsubscribe(); groupsSub = client.groups.connectAll(); // pick up the new group's backlog
      try {
        for (const kp of await client.keyPackages.list()) if (kp.used) await client.keyPackages.rotate(kp.keyPackageRef);
      } catch (e) { emitError(e); }
      bus.emit('group', { groupId: group.idStr, event: 'joined' });
      return group.idStr;
    },

    listGroups() {
      return client.groups.loaded.map(g => ({
        id: g.idStr,
        name: g.groupData?.name || 'Private conversation',
        listingRef: parseListingRef(g.groupData?.description),
        members: g.snapshot.members,
        status: g.status,
      }));
    },

    /**
     * Send an application message. `rumor` = { content, kind = 9, tags = [] }. Any kind/tags are carried verbatim
     * (e.g. Shopstr payment: tags [['subject','order-payment'],['order',id],['amount','1000'],['a','30402:pk:d'],['payment','cashu']]).
     * @throws MarmotError NO_RELAY_ACK with `.results` (per-relay) when no relay acknowledged; call retryPending(groupId).
     * @returns {{rumor, results}} per-relay ACKs
     */
    async sendMessage(groupId, { content = '', kind = 9, tags = [] } = {}) {
      if (!Number.isInteger(kind) || kind < 0) throw new MarmotError('INVALID_MESSAGE', 'Invalid rumor kind.');
      if (!Array.isArray(tags) || tags.some(t => !Array.isArray(t) || t.some(v => typeof v !== 'string'))) throw new MarmotError('INVALID_MESSAGE', 'tags must be string[][].');
      if (!content && !tags.length) throw new MarmotError('INVALID_MESSAGE', 'Message is empty.');
      if (!client.groups.loaded.some(g => g.idStr === groupId)) throw new MarmotError('UNKNOWN_GROUP', 'Unknown group.');
      const rumor = { kind, pubkey, created_at: Math.floor(Date.now() / 1000), content, tags };
      rumor.id = getEventHash(rumor);
      const mark = publishLog.length;
      let results;
      try { results = await client.groups.send(groupId, createApplicationMessageIntent(rumor)); }
      catch (e) { await outbox.setItem(`${groupId}:${rumor.id}`, rumor); throw publishFailure(e, groupId, mark, { rumor }); }
      const response = Object.assign({}, ...results.map(r => r.response || {}));
      if (!results.length || !results.some(r => anyOk(r.response))) { await outbox.setItem(`${groupId}:${rumor.id}`, rumor); throw new MarmotError('NO_RELAY_ACK', 'Message was not acknowledged by any relay. It is stored locally; call retryPending(groupId) when a relay is reachable.', { groupId, rumor, results: response }); }
      return { rumor, results: response };
    },

    /** Re-publish commits and messages that no relay acknowledged. @returns {{retried:number, results:object}} per-relay ACKs; throws NO_RELAY_ACK if still failing */
    async retryPending(groupId) {
      const group = await client.groups.get(groupId);
      const mark = publishLog.length;
      let retried = 0, failure;
      try { retried += (await group.retryPendingPublication()).length; } catch (e) { failure = e; }
      for (const key of await outboxKeys(groupId)) {
        const rumor = await outbox.getItem(key);
        try {
          const res = await sendRumor(groupId, rumor);
          if (res.length && res.some(r => anyOk(r.response))) { await outbox.removeItem(key); retried++; } else failure = failure || new Error('no relay acknowledged');
        } catch (e) { failure = e; }
      }
      const results = lastResults(mark);
      if (failure && !anyOk(results)) throw publishFailure(failure, groupId, mark);
      return { retried, remaining: (await outboxKeys(groupId)).length, results };
    },

    /** Messages not yet acknowledged by any relay (rumors). */
    async outbox(groupId) { return Promise.all((await outboxKeys(groupId)).map(k => outbox.getItem(k))); },

    /** Stored rumors, oldest first. Own messages included. */
    async history(groupId, filter = {}) {
      const group = await client.groups.get(groupId);
      const rumors = await group.history.queryRumors(filter);
      await arrivalQueue;
      const seqs = new Map(await Promise.all(rumors.map(async r => [r.id, (await arrival.getItem(`${groupId}:${r.id}`)) ?? 0])));
      return rumors.sort((a, b) => a.created_at - b.created_at || seqs.get(a.id) - seqs.get(b.id) || (a.id < b.id ? -1 : 1));
    },
  };
  return api;
}

function describeWelcome(result, recipient) {
  const fan = result.welcomeDelivery;
  if (fan?.kind !== 'attempted') return { delivered: false, results: [] };
  const results = fan.outcomes.map(o => o.kind === 'succeeded' ? { ok: true, recipient: o.recipient.pubkey, relays: o.response } : { ok: false, recipient: o.recipient.pubkey, error: o.error });
  return { delivered: results.some(r => r.ok && r.recipient === recipient), results };
}

function parseListingRef(description) {
  try { return JSON.parse(description || '{}').listingRef; } catch { return undefined; }
}
