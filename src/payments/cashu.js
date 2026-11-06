import {
  Wallet, Amount, getTokenMetadata, getEncodedToken, hashToCurve,
  NetworkError, HttpResponseError, MintOperationError,
} from '@cashu/cashu-ts';

const encoder = new TextEncoder();
const hex = (bytes) => Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');

/**
 * Inspect a bearer token locally. This does not contact the mint and does not
 * establish that its proofs are valid, unspent, or redeemable.
 */
export async function inspectCashuToken(input) {
  const token = typeof input === 'string' ? input.trim() : '';
  if (!token || token.length > 100_000) throw new Error('Enter a Cashu token.');
  let metadata;
  try { metadata = getTokenMetadata(token); }
  catch { throw new Error('This is not a readable Cashu token.'); }
  let mint;
  try { mint = new URL(metadata.mint); }
  catch { throw new Error('This token has an invalid mint URL.'); }
  if (!['https:', 'http:'].includes(mint.protocol) || mint.username || mint.password) {
    throw new Error('This token has an invalid mint URL.');
  }
  if (metadata.unit !== 'sat') throw new Error('Only sat-denominated Cashu tokens are supported.');
  const amount = metadata.amount.toNumber();
  if (!Number.isSafeInteger(amount) || amount < 1 || !metadata.incompleteProofs.length) {
    throw new Error('This token has no usable amount.');
  }
  // Fingerprint each bearer secret, so re-encoding or partially reusing a
  // token cannot make an overlapping proof look like a new payment.
  const proofIds = await Promise.all(metadata.incompleteProofs.map(async (proof) => {
    if (typeof proof.secret !== 'string' || !proof.secret) throw new Error('This token has an invalid proof.');
    return hex(await crypto.subtle.digest('SHA-256', encoder.encode(`${mint.href}\0${proof.secret}`)));
  }));
  if (new Set(proofIds).size !== proofIds.length) throw new Error('This token repeats a proof.');
  return { token, mint: mint.href, amount, unit: metadata.unit, proofIds, status: 'unverified' };
}

/** Build a payload for an authenticated encrypted chat only; never publish it as a Nostr event. */
export async function createCashuPaymentMessage(token, listingAddress) {
  if (typeof listingAddress !== 'string' || !/^30402:[a-f0-9]{64}:.+/i.test(listingAddress)) {
    throw new Error('Open a listing before sending a payment.');
  }
  const payment = await inspectCashuToken(token);
  return { type: 'cashu', token: payment.token, listing: listingAddress };
}

/** Detect both complete duplicates and tokens that reuse only some prior proofs. */
export function overlapsPriorPayment(payment, priorProofIds) {
  const known = new Set(priorProofIds);
  return payment.proofIds.some((id) => known.has(id));
}

// ---------------------------------------------------------------------------
// Real ecash leg: wallet persistence, token creation, payment rumor, redeem.
// All crypto (blinding, swaps, DLEQ, hash-to-curve) is @cashu/cashu-ts.
// ---------------------------------------------------------------------------

const ALREADY_SPENT = 11001;       // NUT-00 "token already spent"
const QUOTE_NOT_PAID = 20001;      // NUT-04 "quote not paid"
const TIMEOUT_MS = 15_000;

/** Canonical mint URL (scheme+host lowercased, no trailing slash). Throws on junk. */
export function normalizeMintUrl(input) {
  const u = new URL(String(input));
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new Error('Invalid mint URL.');
  }
  return u.href.replace(/\/+$/, '');
}
const safeMint = (input) => { try { return normalizeMintUrl(input); } catch { return null; } };

/** Minimal async KV (localforage-compatible): getItem / setItem / removeItem. */
export function createMemoryStore() {
  const m = new Map();
  return {
    async getItem(k) { return m.has(k) ? structuredClone(m.get(k)) : null; },
    async setItem(k, v) { m.set(k, structuredClone(v)); return v; },
    async removeItem(k) { m.delete(k); },
    _dump: () => m,
  };
}

/**
 * Browser: localforage (IndexedDB). Node / no usable driver: in-memory store
 * (NOT persistent - inject your own store in Node if you need persistence).
 */
export async function createDefaultStore(name = 'satsroad-cashu') {
  try {
    const mod = await import('localforage');
    const lf = (mod.default ?? mod).createInstance({ name });
    await lf.ready();
    return lf;
  } catch {
    return createMemoryStore();
  }
}

// In-process mutex per store so concurrent redeem/send calls cannot interleave
// read-modify-write cycles. (Does not protect against two browser tabs.)
const locks = new WeakMap();
async function withLock(store, fn) {
  const prev = locks.get(store) ?? Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  locks.set(store, prev.then(() => next));
  await prev;
  try { return await fn(); } finally { release(); }
}

const toPlainProof = (p) => {
  const out = {
    id: p.id,
    amount: Amount.from(p.amount).toNumber(),
    secret: p.secret,
    C: p.C,
  };
  if (p.dleq) out.dleq = JSON.parse(JSON.stringify(p.dleq));
  if (p.witness) out.witness = p.witness;
  return out;
};
const proofsKey = (mint) => `cashu:proofs:${mint}`;
const seenKey = (y) => `cashu:seen:${y}`;
const sum = (proofs) => proofs.reduce((n, p) => n + Amount.from(p.amount).toNumber(), 0);

export async function loadProofs(store, mintUrl) {
  return (await store.getItem(proofsKey(normalizeMintUrl(mintUrl)))) ?? [];
}
export async function saveProofs(store, mintUrl, proofs) {
  await store.setItem(proofsKey(normalizeMintUrl(mintUrl)), proofs.map(toPlainProof));
}
export async function getBalance(store, mintUrl) { return sum(await loadProofs(store, mintUrl)); }

/** Proof Y = hash_to_curve(secret), hex compressed (NUT-00 / NUT-07). */
export function proofY(proof) {
  return hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true);
}

function withTimeout(promise, ms = TIMEOUT_MS) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new NetworkError('Mint timed out.')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function isNetworkError(e) {
  if (e instanceof NetworkError) return true;
  if (e instanceof MintOperationError) return false;
  if (e instanceof HttpResponseError) return e.status >= 500 || e.status === 429;
  return e instanceof TypeError || /fetch failed|ECONNREFUSED|ENOTFOUND|network|timed out/i.test(String(e?.message));
}

async function loadWallet(mintUrl, timeoutMs) {
  const wallet = new Wallet(mintUrl, { unit: 'sat' });
  await withTimeout(wallet.loadMint(), timeoutMs);
  return wallet;
}

/**
 * TEST ONLY. Mint `amount` sat from a mint whose backend auto-pays quotes
 * (scripts/local-mint.sh, nutshell FakeWallet). A real mint would wait for a
 * Lightning payment and this will time out with an error.
 * If `store` is given the new proofs are added to the persisted wallet.
 */
export async function fundTestWallet(mintUrl, amount, { store, timeoutMs = TIMEOUT_MS } = {}) {
  const mint = normalizeMintUrl(mintUrl);
  const wallet = await loadWallet(mint, timeoutMs);
  const quote = await withTimeout(wallet.createMintQuoteBolt11(amount), timeoutMs);
  let proofs;
  // Poll the quote state first (GET, 200) so we do not spam the mint with 400 "quote not paid" mint requests.
  for (let i = 0; i < 20; i++) {
    let st; try { st = await withTimeout(wallet.checkMintQuoteBolt11(quote.quote), timeoutMs); } catch { break; }
    if (st?.state === 'PAID' || st?.state === 'ISSUED') break;
    await new Promise((r) => setTimeout(r, 400));
  }
  for (let i = 0; ; i++) {
    try { proofs = await withTimeout(wallet.mintProofsBolt11(amount, quote.quote), timeoutMs); break; }
    catch (e) {
      if (e instanceof MintOperationError && e.code === QUOTE_NOT_PAID && i < 10) { await new Promise((r) => setTimeout(r, 300)); continue; }
      throw e;
    }
  }
  const plain = proofs.map(toPlainProof);
  if (store) {
    await withLock(store, async () => saveProofs(store, mint, [...(await loadProofs(store, mint)), ...plain]));
  }
  return { mint, proofs: plain, balance: sum(plain) };
}

/**
 * Buyer: split `amount` sat out of `proofs` at the mint (swap) and encode a
 * cashuB token. Returns {token, send, keep}. The caller MUST persist `keep`
 * (use payFromStore to do it atomically) and MUST NOT reuse the proofs in `send`.
 * Fees: send is made with includeFees so the seller nets `amount` after input fees.
 */
export async function createPaymentToken(proofs, amount, mintUrl, { timeoutMs = TIMEOUT_MS } = {}) {
  const mint = normalizeMintUrl(mintUrl);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Amount must be a positive integer.');
  if (sum(proofs) < amount) throw new Error('Insufficient balance.');
  const wallet = await loadWallet(mint, timeoutMs);
  const res = await withTimeout(wallet.send(amount, proofs, { includeFees: true }), timeoutMs);
  const send = res.send.map(toPlainProof);
  const keep = res.keep.map(toPlainProof);
  const token = getEncodedToken({ mint, unit: 'sat', proofs: send }); // cashuB (V4)
  return { token, send, keep, amount: sum(send) };
}

/**
 * Buyer, persisted: take proofs from the store, make a token, store the change
 * and write the outgoing token to `cashu:sent:<id>` BEFORE returning, so a
 * crash while posting the message cannot lose funds.
 */
export async function payFromStore(store, mintUrl, amount, { orderId = '', timeoutMs } = {}) {
  const mint = normalizeMintUrl(mintUrl);
  return withLock(store, async () => {
    const proofs = await loadProofs(store, mint);
    const out = await createPaymentToken(proofs, amount, mint, { timeoutMs });
    await saveProofs(store, mint, out.keep);
    await store.setItem(`cashu:sent:${orderId || out.send[0].secret.slice(0, 16)}`, { token: out.token, mint, amount: out.amount, orderId, at: Date.now() });
    return out;
  });
}

/** Shopstr-convention payment rumor (kind 14) to be sent through a Marmot group. */
export function buildPaymentRumor({ token, orderId, listingRef, amount, buyerPubkey, note }) {
  if (typeof token !== 'string' || !/^cashu[AB]/.test(token)) throw new Error('Not a Cashu token.');
  if (!orderId) throw new Error('orderId required.');
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('amount must be a positive integer.');
  if (typeof listingRef !== 'string' || !/^30402:[a-f0-9]{64}:.+/i.test(listingRef)) throw new Error('listingRef must be a 30402:<pubkey>:<d> address.');
  const tags = [
    ['subject', 'order-payment'],
    ['order', orderId],
    ['type', '2'],
    ['amount', String(amount)],
    ['payment', 'ecash', token],
    ['item', listingRef, '1'],
    ['a', listingRef],
  ];
  if (buyerPubkey) tags.push(['b', buyerPubkey]);
  return { kind: 14, content: `${note ?? 'Cashu ecash payment'} (order ${orderId}): ${token}`, tags };
}

/**
 * Parse an incoming rumor. Never trusts the claimed amount: `tokenAmount`/`tokenMint`
 * come from the token itself, `amount` is what the buyer claims. Does not touch the mint.
 * @returns {{ok:true, token, orderId, listingRef, amount, tokenAmount, tokenMint}|{ok:false, error}}
 */
export function parsePaymentRumor(rumor) {
  try {
    if (!rumor || rumor.kind !== 14 || !Array.isArray(rumor.tags)) return { ok: false, error: 'Not a kind 14 rumor.' };
    const tag = (n) => rumor.tags.find((t) => t[0] === n);
    if (tag('subject')?.[1] !== 'order-payment') return { ok: false, error: 'Not an order-payment message.' };
    const pay = tag('payment');
    if (!pay || !['ecash', 'cashu'].includes(pay[1]) || !pay[2]) return { ok: false, error: 'No ecash payment tag.' };
    const orderId = tag('order')?.[1];
    if (!orderId) return { ok: false, error: 'Missing order id.' };
    const amount = Number(tag('amount')?.[1]);
    if (!Number.isSafeInteger(amount) || amount < 1) return { ok: false, error: 'Missing or invalid amount.' };
    const listingRef = tag('a')?.[1] ?? tag('item')?.[1] ?? '';
    const meta = getTokenMetadata(pay[2]);
    return {
      ok: true, token: pay[2], orderId, listingRef, amount,
      tokenAmount: meta.amount.toNumber(), tokenMint: safeMint(meta.mint),
    };
  } catch (e) {
    return { ok: false, error: 'Unreadable payment token.' };
  }
}

const inflight = new Set();

/**
 * Seller: verify with the mint and swap the token into the seller's wallet.
 * `redeemed` is returned ONLY after the mint's swap succeeded and the new
 * proofs are persisted. Statuses:
 *   redeemed | already_spent | invalid | wrong_mint | amount_mismatch |
 *   mint_unreachable | duplicate
 * Checks in order (cheap/local first): parse -> mint allow-list -> duplicate ->
 * amount -> mint keysets -> proof state (NUT-07) -> swap (NUT-03).
 *
 * @param {string} token     cashuA/cashuB token string
 * @param {string} mintUrl   the seller's mint (default allow-list)
 * @param {object} [opts]    {store, allowedMints, expectedAmount, orderId, timeoutMs}
 */
export async function redeem(token, mintUrl, opts = {}) {
  const { allowedMints, expectedAmount, orderId = null, timeoutMs = TIMEOUT_MS } = opts;
  const store = opts.store ?? await createDefaultStore();
  const fail = (status, reason, extra = {}) => ({ status, reason, ...extra });

  let meta;
  try { meta = getTokenMetadata(typeof token === 'string' ? token.trim() : ''); }
  catch { return fail('invalid', 'Unreadable token.'); }
  if (meta.unit !== 'sat') return fail('invalid', 'Only sat tokens are supported.');
  const tokenMint = safeMint(meta.mint);
  if (!tokenMint) return fail('invalid', 'Bad mint URL in token.');
  const faceAmount = meta.amount.toNumber();
  const secrets = meta.incompleteProofs.map((p) => p.secret);
  if (!secrets.length || secrets.some((s) => typeof s !== 'string' || !s) || new Set(secrets).size !== secrets.length) {
    return fail('invalid', 'Token has no usable or repeated proofs.');
  }

  const allowed = (allowedMints ?? [mintUrl]).map(safeMint).filter(Boolean);
  if (!allowed.includes(tokenMint)) return fail('wrong_mint', 'Token is from a mint this shop does not accept.', { tokenMint, faceAmount });

  const Ys = meta.incompleteProofs.map((p) => proofY(p));
  const keys = Ys.map(seenKey);
  // Claim synchronously (no await between check and add) so concurrent deliveries cannot both pass.
  if (Ys.some((y) => inflight.has(y))) return fail('duplicate', 'This token is already being redeemed.', { Ys });
  Ys.forEach((y) => inflight.add(y));
  try {
    for (const k of keys) {
      const prior = await store.getItem(k);
      if (prior) return fail('duplicate', 'This token (or part of it) was already redeemed.', { Ys, firstSeen: prior });
    }

    if (expectedAmount != null && faceAmount < expectedAmount) {
      return fail('amount_mismatch', `Token is ${faceAmount} sat, order needs ${expectedAmount}.`, { faceAmount, expectedAmount });
    }

    let wallet;
    try { wallet = await loadWallet(tokenMint, timeoutMs); }
    catch { return fail('mint_unreachable', 'Mint is unreachable. Nothing was redeemed; try again.'); }

    let states;
    try {
      const decoded = wallet.decodeToken(token.trim());
      states = await withTimeout(wallet.checkProofsStates(decoded.proofs), timeoutMs);
    } catch (e) {
      return isNetworkError(e) ? fail('mint_unreachable', 'Mint is unreachable. Nothing was redeemed; try again.')
        : fail('invalid', 'Mint does not recognise these proofs.');
    }
    if (states.some((s) => s.state === 'SPENT')) return fail('already_spent', 'The mint says these proofs are already spent.');
    if (states.some((s) => s.state === 'PENDING')) return fail('invalid', 'Proofs are pending at the mint.', { pending: true });

    let received;
    try { received = await withTimeout(wallet.receive(token.trim()), timeoutMs); }
    catch (e) {
      if (e instanceof MintOperationError && e.code === ALREADY_SPENT) return fail('already_spent', 'The mint says these proofs are already spent.');
      return isNetworkError(e) ? fail('mint_unreachable', 'Mint connection lost during redeem. State is unknown: re-check before retrying.', { uncertain: true })
        : fail('invalid', `Mint rejected the token: ${e?.message ?? e}`);
    }

    // The swap succeeded: the funds are ours. Persist proofs first, then duplicate markers.
    const plain = received.map(toPlainProof);
    await withLock(store, async () => saveProofs(store, tokenMint, [...(await loadProofs(store, tokenMint)), ...plain]));
    const record = { orderId, at: Date.now(), mint: tokenMint };
    for (const k of keys) await store.setItem(k, record);
    const amount = sum(plain);
    return { status: 'redeemed', amount, faceAmount, fee: faceAmount - amount, mint: tokenMint, Ys, orderId, balance: await getBalance(store, tokenMint) };
  } finally {
    Ys.forEach((y) => inflight.delete(y));
  }
}

/* ---------- real-money funding (NUT-04). This module NEVER pays an invoice; the user pays it from their own Lightning wallet. ---------- */
/** Ask the mint for a Lightning invoice for `amount` sat. Returns {quote, request (bolt11), expiry, amount}. */
export async function createMintQuote(mintUrl, amount, { timeoutMs = TIMEOUT_MS } = {}) {
  const mint = normalizeMintUrl(mintUrl);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Enter a whole number of sats (at least 1).');
  const wallet = await loadWallet(mint, timeoutMs);
  const q = await withTimeout(wallet.createMintQuoteBolt11(amount), timeoutMs);
  return { mint, quote: q.quote, request: q.request, expiry: q.expiry ?? null, amount, state: q.state };
}
/** Check the quote once. If the invoice is PAID, mint the proofs, save them and return {state:'ISSUED', amount}. Otherwise {state}. */
export async function checkAndMintQuote(mintUrl, amount, quoteId, { store, timeoutMs = TIMEOUT_MS } = {}) {
  const mint = normalizeMintUrl(mintUrl);
  const wallet = await loadWallet(mint, timeoutMs);
  const st = await withTimeout(wallet.checkMintQuoteBolt11(quoteId), timeoutMs);
  if (st.state === 'ISSUED') return { state: 'ISSUED', amount: 0, note: 'Already issued (proofs were stored earlier or elsewhere).' };
  if (st.state !== 'PAID') return { state: st.state, expiry: st.expiry ?? null };
  const proofs = await withTimeout(wallet.mintProofsBolt11(amount, quoteId), timeoutMs);
  const plain = proofs.map(toPlainProof);
  if (store) await withLock(store, async () => saveProofs(store, mint, [...(await loadProofs(store, mint)), ...plain]));
  return { state: 'ISSUED', amount: sum(plain), balance: store ? await getBalance(store, mint) : sum(plain) };
}
/** Receive a pasted cashuB/cashuA token into this browser's wallet (swap at the mint, keep the new proofs). */
export async function receiveIntoWallet(token, { store, timeoutMs = TIMEOUT_MS } = {}) {
  let meta; try { meta = getTokenMetadata(String(token || '').trim()); } catch { throw new Error('That does not look like a Cashu token.'); }
  if (meta.unit !== 'sat') throw new Error('Only sat tokens are supported.');
  const mint = safeMint(meta.mint); if (!mint) throw new Error('The token has a bad mint URL.');
  const wallet = await loadWallet(mint, timeoutMs);
  let received;
  try { received = await withTimeout(wallet.receive(String(token).trim()), timeoutMs); }
  catch (e) { throw new Error(e instanceof MintOperationError && e.code === ALREADY_SPENT ? 'The mint says this token is already spent.' : `The mint did not accept the token: ${e?.message ?? e}`); }
  const plain = received.map(toPlainProof);
  await withLock(store, async () => saveProofs(store, mint, [...(await loadProofs(store, mint)), ...plain]));
  return { mint, amount: sum(plain), balance: await getBalance(store, mint) };
}
