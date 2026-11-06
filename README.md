<p align="center">
  <img src="docs/assets/logo.jpg" alt="SatsRoad Market" width="520">
</p>

<p align="center">
  <b>Browse publicly. Negotiate privately. Pay with ecash.</b><br>
  A privacy-first Nostr marketplace built for BTC++ Seoul (Privacy and Marmot tracks).
</p>

<p align="center">
  <a href="https://satsroadmarket.pages.dev">App</a> ·
  <a href="https://satsroadmarket.pages.dev/demo/slides/">Slides</a> ·
  <a href="DECISIONS.md">Decisions</a> ·
  <a href="docs/ECASH.md">Ecash</a>
</p>

---

## What it is

SatsRoad Market keeps discovery open and everything after it private.

| Step | Protocol | Library |
|---|---|---|
| Public listing | NIP-99 `kind 30402`, Shopstr tags | `nostr-tools` |
| Private negotiation | Marmot / MLS group chat, not NIP-17 DMs | `@internet-privacy/marmot-ts` |
| Payment and fulfilment | Cashu ecash token sent inside the group | `@cashu/cashu-ts` |
| Images | Blossom upload | BUD-02 |

Buyers and sellers keep portable Nostr identities. No accounts, no invoices, no payment addresses. Listings stay compatible with [Shopstr](https://github.com/shopstr-eng/shopstr), and this is a companion app rather than a fork.

Sellers confirm they list legal goods only, and relay operators are responsible for filtering. The client also hides listings matching a small set of keywords.

## Run it

Requires Node 20+ and Docker (for the local mint only).

```bash
npm install
npm run relay     # local relay on ws://127.0.0.1:7777
npm run mint      # local Cashu mint on http://127.0.0.1:3338 (nutshell, fake Lightning)
npm run dev       # app on http://127.0.0.1:5173
npm test
```

Use two browser profiles for two identities. Open the app, generate or import an `nsec` in each, and follow the in-app steps: seller publishes a key package and a listing, buyer opens it and starts a private conversation, seller accepts the invite, buyer pays with ecash, seller redeems.

Build and deploy:

```bash
npm run build
npx wrangler pages deploy dist --project-name satsroadmarket
```

## Status

Verified by automated tests (local relay and local mint):

- Marmot: two identities, invite and deferred join, two-way messages, restart persistence, relay-down retry.
- Cashu: happy path, invalid token, double spend, duplicate delivery, wrong mint, wrong amount, mint down.

Reported working in a browser with two identities against the local relay and mint: listing, invite, chat, payment, redeem, reload.

Not yet verified: public relays, public mints, Blossom upload, and the late-joining seller through the UI. See [docs/](docs) for test reports as they land.

## Limits

- Browser storage (keys, group state, wallet) is not encrypted at rest.
- Relays still see metadata such as timing and event kinds.
- No escrow. The wallet has no seed backup.
- The seller redeems at a single configured mint.

## Layout

```
src/lib/        Marmot client, Nostr helpers, keyword filter
src/payments/   Cashu payment and redeem
src/marketplace/ listings, orders
src/ui/         identity, chat, adapters
public/demo/slides/   presentation
scripts/        local relay and mint
```

Marmot handles encryption and Cashu handles money. No cryptography in this repo is hand-written.
