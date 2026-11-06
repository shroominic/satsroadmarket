# Mints and funding

## Defaults
- Production default mint: **Minibits**, `https://mint.minibits.cash/Bitcoin` (checked: `/v1/info` returns a cdk-mintd mint with CORS `access-control-allow-origin: *`, one active `sat` keyset). Minibits describes itself as BETA: use small amounts.
- A buyer pays from the mint selected in Identity, a seller accepts tokens from the same mint plus the allow-list in Identity (Ecash wallet, "Seller allow-list"). Tokens from any other mint are rejected with "Mint not accepted".
- Custom mints: choose "Custom mint URL…" (https only) and add more accepted mints in the allow-list.
- The test mint (`testnut`), the local mint/relay and the "Fund test wallet" button exist only in development and E2E builds (`npm run dev`, `npm run build:e2e`). They are not in the production bundle.

## Funding the wallet (real mint)
Identity → Ecash wallet:
1. Enter an amount (for example 500 sats) and press "Add funds (Lightning invoice)".
2. The app asks the mint for a NUT-04 mint quote and shows the bolt11 invoice as text and as a QR code.
3. **You** pay that invoice from your own Lightning wallet. The app never pays an invoice and no automated test ever does.
4. The page polls the quote every 3 s. When the mint reports PAID, the app mints the proofs, stores them in this browser (IndexedDB, unencrypted) and shows the balance. A pending quote survives a reload.
5. Alternatively paste a `cashuB…` token (for example from the Minibits wallet) into "Receive ecash" and press "Receive token".

## The one manual real-money end-to-end check (owner)
1. In two separate browser profiles open https://satsroadmarket.com: A = seller, B = buyer. Create an identity in each.
2. A: Sell → publish a listing priced at 10 sats. B: Identity → Add funds with 100 sats and pay the invoice from your wallet.
3. B: open the listing → Start private conversation. A: Conversations → Accept & join.
4. B: Pay with ecash → Create token from wallet → Send. A: Redeem → the order should show PAID, then Mark fulfilled.
5. Leftover balance: there is no standalone "export token" button yet. Keep the amounts small; unspent ecash stays in that browser profile.

Notes: browser wallet state is local to that browser profile; clearing site data loses unspent ecash. Back up large balances elsewhere.
