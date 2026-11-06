/**
 * Thin adapters around the Marmot and Cashu modules owned by other workstreams.
 * Each adapter normalises whichever API generation is present, and reports a clear error otherwise.
 * Nothing here fakes success: if a capability is missing the adapter throws a readable message.
 */
import { orderRumor, SUBJECT } from '../marketplace/orders.js';


/* ---------------- Marmot ---------------- */
/** Append real per-relay answers to a Marmot error, so the UI can show what each relay said. */
export function relayDetail(results) {
  const entries = Object.entries(results || {}).map(([relay, r]) => `${relay}: ${r?.ok ? 'accepted' : (r?.message || 'no answer')}`);
  return entries.length ? ` Relay answers: ${entries.join('; ')}.` : '';
}
function explain(error) {
  if (!error || error.__explained) return error;
  const text = String(error.message || error).replace(/\s*(It is (kept|stored) locally;?\s*)?call retryPending\(groupId\) when a relay is reachable\.?/i, '').replace(/\s*It is stored locally;?\s*$/i, '');
  const out = new Error(`${text}${relayDetail(error.results)}`);
  out.code = error.code; out.results = error.results; out.__explained = true; return out;
}
const guard = (fn) => async (...args) => { try { return await fn(...args); } catch (error) { throw explain(error); } };

export async function startMarmot({ privateKey, relays, onChange = () => {}, onError = () => {} }) {
  let mod;
  try { mod = await import('../lib/marmot.js'); }
  catch (error) { throw new Error(`The Marmot module failed to load: ${error.message}`); }
  if (typeof mod.createMarmot !== 'function') throw new Error('src/lib/marmot.js does not export createMarmot.');
  let m;
  try { m = await mod.createMarmot({ privateKey, relays }); } catch (error) { throw explain(error); }
  const unsubs = [];
  for (const name of ['invite', 'group', 'message', 'change']) unsubs.push(m.on?.(name, () => onChange(name)));
  unsubs.push(m.on?.('error', onError));
  try { await m.start(); } catch (error) { throw explain(error); }
  const need = (name) => { if (typeof m[name] !== 'function') throw new Error(`The Marmot module has no ${name}().`); return m[name].bind(m); };

  return {
    pubkey: m.pubkey,
    raw: m,
    publishKeyPackage: guard(async () => need('publishKeyPackage')()),
    async startConversation(sellerPubkey, { listingRef, label }) {
      try {
        const out = await need('startConversation')(sellerPubkey, { listingRef, title: label });
        return { id: out.groupId, delivered: out.welcome?.delivered !== false, results: out.welcome?.results };
      } catch (error) { throw explain(error); }
    },
    retryInvite: guard(async (groupId) => {
      const out = await need('retryWelcome')(groupId);
      if (!out.delivered) throw new Error('Welcome delivery is still unconfirmed. Retry when a relay is reachable.');
      return out;
    }),
    listInvites: guard(async () => (typeof m.listInvites === 'function' ? m.listInvites() : [])),
    acceptInvite: guard(async (id) => need('acceptInvite')(id)),
    listGroups: guard(async () => (typeof m.listGroups === 'function' ? m.listGroups() : [])),
    sendMessage: guard(async (groupId, rumor) => need('sendMessage')(groupId, { kind: rumor.kind ?? 9, content: rumor.content || '', tags: rumor.tags || [] })),
    retryPending: guard(async (groupId) => need('retryPending')(groupId)),
    outbox: async (groupId) => { try { return typeof m.outbox === 'function' ? await m.outbox(groupId) : []; } catch { return []; } },
    history: guard(async (groupId) => (await need('history')(groupId)).map((r) => ({ ...r, tags: r.tags || [] }))),
    stop() { for (const off of unsubs) { try { off?.(); } catch { /* ignore */ } } try { m.stop?.(); } catch { /* ignore */ } },
  };
}

/* ---------------- Cashu ---------------- */
import { storage } from '../lib/nostr.js';

let cashuModule; let walletStore;
async function cashuMod() {
  if (cashuModule?.createPaymentToken || cashuModule?.loadError) return cashuModule;
  try { cashuModule = await import('../payments/cashu.js'); } catch (error) { cashuModule = { loadError: error.message }; }
  return cashuModule;
}
const need = (mod, name) => { if (typeof mod[name] !== 'function') throw new Error(`The ecash module has no ${name}()${mod.loadError ? ` (load error: ${mod.loadError})` : ''}.`); return mod[name]; };
const walletOf = async (mod) => (walletStore ||= await need(mod, 'createDefaultStore')());
const MINT_KEY = 'sr.mint';
export const defaultMint = () => storage.get(MINT_KEY) || 'http://127.0.0.1:3338';

export const cashu = {
  async preload() { await cashuMod(); },
  mintUrl: defaultMint,
  setMintUrl(url) { storage.set(MINT_KEY, url); },
  /** Validate a pasted token locally. Does NOT prove it is unspent: only the mint can. */
  async inspect(token) { const m = await cashuMod(); return need(m, 'inspectCashuToken')(token); },
  async balance(mintUrl) { const m = await cashuMod(); return need(m, 'getBalance')(await walletOf(m), mintUrl); },
  /** TEST ONLY: the module mints from an auto-paying FakeWallet mint; a real mint will time out. */
  async fundTestWallet(mintUrl, amount) { const m = await cashuMod(); return need(m, 'fundTestWallet')(mintUrl, amount, { store: await walletOf(m) }); },
  /** Swap proofs from this browser's wallet into a sendable token (change is kept in the wallet). */
  async makeToken({ mintUrl, amount, orderId }) { const m = await cashuMod(); const out = await need(m, 'payFromStore')(await walletOf(m), mintUrl, amount, { orderId }); return { token: out.token, amount: out.amount }; },
  async paymentRumor({ token, orderId, listingRef, amount, buyerPubkey }) {
    const m = await cashuMod();
    if (typeof m.buildPaymentRumor === 'function') return m.buildPaymentRumor({ token, orderId, listingRef, amount, buyerPubkey });
    return orderRumor({ subject: SUBJECT.payment, orderId, listingRef, amount, type: 2, payment: ['ecash', token], content: `Ecash payment of ${amount} sats.` });
  },
  /** Synchronous, for rendering. The ecash module wins; tag parsing is the fallback. */
  parseSync(rumor, fallback) {
    const m = cashuModule;
    if (m && typeof m.parsePaymentRumor === 'function') {
      try { const out = m.parsePaymentRumor(rumor); if (out?.ok) return { token: out.token, amount: out.tokenAmount ?? out.amount, claimed: out.amount, mint: out.tokenMint, orderId: out.orderId }; if (out && out.ok === false) return null; } catch { /* use fallback */ }
    }
    return fallback(rumor);
  },
  /** Redeem into the seller's wallet at the mint. Resolves only if the mint's swap succeeded; otherwise throws the real reason. */
  async redeem(payment, { orderId, expectedAmount } = {}) {
    const m = await cashuMod();
    const mint = defaultMint();
    const result = await need(m, 'redeem')(payment.token, mint, { store: await walletOf(m), allowedMints: [mint], orderId, expectedAmount });
    if (result?.status !== 'redeemed') {
      const labels = { already_spent: 'Already spent', duplicate: 'Duplicate token', wrong_mint: 'Mint not accepted', amount_mismatch: 'Wrong amount', mint_unreachable: 'Mint unreachable', invalid: 'Invalid token' };
      throw new Error(`${labels[result?.status] || 'Redemption failed'}: ${result?.reason || 'the mint did not accept the token.'}`);
    }
    return { amount: result.amount, raw: result };
  },
};
