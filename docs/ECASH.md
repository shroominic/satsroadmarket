# Ecash (Cashu) payment leg

Code: `src/payments/cashu.js` (uses `@cashu/cashu-ts` 4.13 for all crypto). Tests: `test/cashu.mint.test.mjs` (real local mint) and `test/cashu.test.mjs` (offline parsing).

## Local mint
```
npm run mint            # = bash scripts/local-mint.sh start  (needs Docker running)
scripts/local-mint.sh status | logs | stop
```
Runs `cashubtc/nutshell` (v0.22.1 at time of writing) with the FakeWallet backend on `http://127.0.0.1:3338`. `FAKEWALLET_BRR=True` makes it pay mint quotes itself, so `fundTestWallet()` gets sats with no Lightning. First start pulls the image (~1 min). Keys are throwaway; do not expose the port. Override with `MINT_PORT`, `MINT_IMAGE`, `MINT_CONTAINER`.

Run tests: `scripts/local-mint.sh start && node --test test/cashu.*.mjs`. (Node 26 does not accept the bare directory in `node --test test/`; use the glob.)

## API
| Function | Who | Notes |
|---|---|---|
| `fundTestWallet(mintUrl, amount, {store})` | tests | Mints via auto-paid quote. Optionally persists proofs. Fails on a real mint. |
| `createPaymentToken(proofs, amount, mintUrl)` | buyer | Swap at mint, returns `{token (cashuB), send, keep}`. Caller must persist `keep`. |
| `payFromStore(store, mintUrl, amount, {orderId})` | buyer | Persisted version: stores change and journals the outgoing token (`cashu:sent:*`) before returning. |
| `buildPaymentRumor({token, orderId, listingRef, amount, buyerPubkey})` | buyer | `{kind:14, content, tags}` using Shopstr tags: `subject=order-payment`, `order`, `type=2`, `amount`, `payment [ecash, token]`, `item`, `a`, `b`. Send it through the Marmot group. |
| `parsePaymentRumor(rumor)` | seller | `{ok, token, orderId, listingRef, amount (claimed), tokenAmount, tokenMint}` or `{ok:false,error}`. No network. |
| `redeem(token, mintUrl, {store, allowedMints, expectedAmount, orderId, timeoutMs})` | seller | Returns `{status, ...}`, see below. |
| `loadProofs / saveProofs / getBalance / proofY / normalizeMintUrl / createMemoryStore / createDefaultStore` | both | Store is any `{getItem,setItem,removeItem}` (localforage in browser). |

### redeem statuses
`redeemed` (mint swap succeeded, proofs persisted; carries `amount` net of fees, `faceAmount`, `fee`) |
`already_spent` (mint NUT-07 says SPENT, or swap rejected with 11001) | `invalid` (unreadable, non-sat, forged/unknown proofs, proofs PENDING with `pending:true`) | `wrong_mint` (token mint not in `allowedMints`, default `[mintUrl]`; checked before any network call) | `amount_mismatch` (token face value < `expectedAmount`) | `mint_unreachable` (connect failure/timeout/5xx; `uncertain:true` if it dropped during the swap) | `duplicate` (a proof Y already redeemed here, or the same token is being redeemed concurrently; includes `firstSeen`).

"Paid" must be derived only from `status === 'redeemed'`. Nothing else may mark an order paid.

## Storage keys
`cashu:proofs:<mint>` (array of `{id,amount,secret,C,dleq?}`), `cashu:seen:<Y>` (redeemed proof markers), `cashu:sent:<orderId>` (outgoing token journal).

## Limits and gotchas
- **Unencrypted bearer funds.** Proofs sit in IndexedDB in clear text. Clearing site data loses the money. No seed/backup (random secrets, not deterministic).
- **Crash window.** After the mint swap succeeds and before `saveProofs` finishes, a crash loses the new proofs (the token is then spent). Proofs are saved before duplicate markers.
- **Multi-tab.** The mutex and in-flight set are per JS context. Two tabs on the same IndexedDB can race; the mint still prevents double-spend, but wallet read-modify-write could lose an update.
- **Duplicate = redeemed here only.** Duplicates are recorded only after success; a failed attempt can be retried. Cross-device double delivery is caught by the mint (`already_spent`).
- **Fees.** `createPaymentToken` uses `includeFees`, so the face value can exceed the price on a mint with input fees. Seller accepts `faceAmount >= expectedAmount`; overpayment is accepted, not refunded. Local mint has 0 fees, so fee logic is untested against a fee-charging mint.
- **Mint URLs** are compared after normalisation only; `localhost` and `127.0.0.1` are different mints.
- **Not covered:** P2PK/locked tokens, refunds, melting to Lightning, mint-down detection by actually stopping the container (tests use a closed port), real-mint (testnut/public) runs, DLEQ enforcement (not required on receive).
- FakeWallet quotes are unpaid-looking until minted; `fundTestWallet` retries on "quote not paid".
