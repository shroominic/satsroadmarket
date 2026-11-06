// Integration tests against a REAL local Cashu mint (nutshell, FakeWallet).
// Start it first:  npm run mint     (scripts/local-mint.sh, http://127.0.0.1:3338)
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { getEncodedToken } from '@cashu/cashu-ts';
import {
  fundTestWallet, createPaymentToken, payFromStore, buildPaymentRumor, parsePaymentRumor,
  redeem, createMemoryStore, getBalance, loadProofs, proofY,
} from '../src/payments/cashu.js';

const MINT = process.env.MINT_URL ?? 'http://127.0.0.1:3338';
const LISTING = `30402:${'a'.repeat(64)}:camel-saddle`;

before(async () => {
  try { await fetch(`${MINT}/v1/info`, { signal: AbortSignal.timeout(3000) }); }
  catch { throw new Error(`Local mint not reachable at ${MINT}. Run: npm run mint`); }
});

const funded = async (amount = 64) => {
  const buyer = createMemoryStore();
  await fundTestWallet(MINT, amount, { store: buyer });
  return buyer;
};

test('happy path: fund -> pay -> rumor -> parse -> redeem; balances move', async () => {
  const buyer = await funded(64);
  assert.equal(await getBalance(buyer, MINT), 64);

  const { token } = await payFromStore(buyer, MINT, 21, { orderId: 'o-happy' });
  assert.match(token, /^cashuB/);
  assert.equal(await getBalance(buyer, MINT), 43, 'change persisted, sent proofs removed');
  assert.ok(await buyer.getItem('cashu:sent:o-happy'), 'outgoing token journaled');

  const rumor = buildPaymentRumor({ token, orderId: 'o-happy', listingRef: LISTING, amount: 21 });
  assert.equal(rumor.kind, 14);
  assert.deepEqual(rumor.tags.find((t) => t[0] === 'payment'), ['payment', 'ecash', token]);

  const parsed = parsePaymentRumor(rumor);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tokenAmount, 21);
  assert.equal(parsed.listingRef, LISTING);

  const seller = createMemoryStore();
  const res = await redeem(parsed.token, MINT, { store: seller, expectedAmount: parsed.amount, orderId: parsed.orderId });
  assert.equal(res.status, 'redeemed');
  assert.equal(res.amount, 21);
  assert.equal(await getBalance(seller, MINT), 21, 'seller wallet holds fresh proofs');
});

test('invalid token: garbage string and well-formed token with forged proof', async () => {
  const seller = createMemoryStore();
  assert.equal((await redeem('not a token', MINT, { store: seller })).status, 'invalid');
  assert.equal((await redeem('cashuBgarbage', MINT, { store: seller })).status, 'invalid');

  // Real keyset id from the mint, but the signature C is made up.
  const info = await (await fetch(`${MINT}/v1/keysets`)).json();
  const id = info.keysets.find((k) => k.active && k.unit === 'sat').id;
  const forged = getEncodedToken({ mint: MINT, unit: 'sat', proofs: [{ id, amount: 1, secret: 'f0'.repeat(32), C: '02' + '11'.repeat(32) }] });
  const res = await redeem(forged, MINT, { store: seller });
  assert.equal(res.status, 'invalid');
  assert.equal(await getBalance(seller, MINT), 0);
});

test('double-spend: same token to two independent sellers; second is already_spent', async () => {
  const buyer = await funded(16);
  const { token } = await payFromStore(buyer, MINT, 8);
  const s1 = createMemoryStore(); const s2 = createMemoryStore();
  assert.equal((await redeem(token, MINT, { store: s1 })).status, 'redeemed');
  const second = await redeem(token, MINT, { store: s2 });
  assert.equal(second.status, 'already_spent');
  assert.equal(await getBalance(s2, MINT), 0, 'nothing credited on double-spend');
});

test('duplicate delivery: same message twice (sequential, concurrent, after restart)', async () => {
  const buyer = await funded(16);
  const { token } = await payFromStore(buyer, MINT, 8);
  const seller = createMemoryStore();

  const [a, b] = await Promise.all([
    redeem(token, MINT, { store: seller, orderId: 'o-dup' }),
    redeem(token, MINT, { store: seller, orderId: 'o-dup' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), ['duplicate', 'redeemed'], 'concurrent delivery credits once');

  const again = await redeem(token, MINT, { store: seller, orderId: 'o-dup' });
  assert.equal(again.status, 'duplicate');
  assert.equal(again.firstSeen.orderId, 'o-dup');
  assert.equal(await getBalance(seller, MINT), 8, 'credited exactly once');

  // "Restart": same persisted store, fresh calls. Still duplicate without needing the mint.
  assert.equal((await redeem(token, 'http://127.0.0.1:1', { store: seller, allowedMints: [MINT] })).status, 'duplicate');
});

test('wrong mint: token from a mint not on the allow-list is rejected before any network call', async () => {
  const other = 'http://127.0.0.1:3999';
  const tok = getEncodedToken({ mint: other, unit: 'sat', proofs: [{ id: '009a1f293253e41e', amount: 5, secret: 'aa'.repeat(16), C: '02' + '22'.repeat(32) }] });
  const seller = createMemoryStore();
  const res = await redeem(tok, MINT, { store: seller });
  assert.equal(res.status, 'wrong_mint');
  assert.equal(res.tokenMint, other);
});

test('wrong amount: underpayment is rejected and the token stays unspent', async () => {
  const buyer = await funded(16);
  const { token } = await payFromStore(buyer, MINT, 5);
  const seller = createMemoryStore();
  const res = await redeem(token, MINT, { store: seller, expectedAmount: 100 });
  assert.equal(res.status, 'amount_mismatch');
  assert.equal(await getBalance(seller, MINT), 0);
  // proof it was not consumed: a correctly-priced redeem still works
  assert.equal((await redeem(token, MINT, { store: seller, expectedAmount: 5 })).status, 'redeemed');
});

test('mint down: allowed mint that refuses connections -> mint_unreachable, nothing recorded', async () => {
  const dead = 'http://127.0.0.1:3999';
  const tok = getEncodedToken({ mint: dead, unit: 'sat', proofs: [{ id: '009a1f293253e41e', amount: 5, secret: 'bb'.repeat(16), C: '02' + '22'.repeat(32) }] });
  const seller = createMemoryStore();
  const res = await redeem(tok, dead, { store: seller, timeoutMs: 3000 });
  assert.equal(res.status, 'mint_unreachable');
  assert.equal(seller._dump().size, 0, 'no paid/duplicate marker written, so retry is possible');
});

test('createPaymentToken rejects overspend; rumor/parse validate input', async () => {
  const { proofs } = await fundTestWallet(MINT, 4);
  await assert.rejects(createPaymentToken(proofs, 5, MINT), /Insufficient/);
  assert.equal(parsePaymentRumor({ kind: 14, tags: [], content: '' }).ok, false);
  assert.equal(parsePaymentRumor({ kind: 14, tags: [['subject', 'order-payment'], ['order', 'x'], ['amount', '1'], ['payment', 'ecash', 'junk']], content: '' }).ok, false);
  assert.throws(() => buildPaymentRumor({ token: 'nope', orderId: 'x', listingRef: LISTING, amount: 1 }));
  assert.equal(proofY(proofs[0]).length, 66);
});
