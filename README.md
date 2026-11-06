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

## Defaults

| | Default |
|---|---|
| Marmot relays | `nos.lol`, `relay.primal.net`, `relay.ditto.pub`, `nostr.mom`, `relay.snort.social` |
| Listing relays | Shopstr's defaults: `relay.damus.io`, `nos.lol`, `purplepag.es`, `relay.primal.net`, `relay.nostr.band` (plus a write-only broadcast relay) |
| Mint | Minibits, `https://mint.minibits.cash/Bitcoin` (custom https mints allowed) |
| Images | Blossom, `blossom.primal.net` |

Relay results are in [docs/RELAY_PROBE.md](docs/RELAY_PROBE.md). Funding a mint is described in [docs/MINTS.md](docs/MINTS.md).

## Features

- Shopstr-compatible NIP-99 listings with fiat or sat prices, live conversion, paging with infinite scroll and an offline cache.
- Private conversations over Marmot / MLS, with an **M** badge for vendors who publish a key package.
- Optional standard NIP-17 messages for sellers without Marmot, with a clear warning.
- Cashu payment sent inside the conversation. An order is **paid** only after the seller redeems the token at the mint.
- Filters: has image, editable NSFW keywords, Marmot vendors.

## Run it

Requires Node 20+ and Docker (tests and the local mint only).

```bash
npm install
npm run dev          # app with local relay and mint options, http://127.0.0.1:5173
npm run relay        # local relay on ws://127.0.0.1:7777
npm run mint         # local Cashu mint on http://127.0.0.1:3338
npm test             # starts the local mint, runs all tests serially
```

Fake-money end-to-end tests run on a separate build and never on the live site:

```bash
npm run build:e2e && npm run preview:e2e
```

Use two browser profiles for two identities.

Deploy (GitHub Pages without Actions):

```bash
scripts/deploy-gh-pages.sh
```

## Status

Verified in automated tests and end-to-end runs on public relays, Blossom and a public test mint (full results in [docs/PROD_TEST_REPORT.md](docs/PROD_TEST_REPORT.md)):

- Seller image upload and listing, buyer discovery, private conversation, messages both ways, ecash payment, seller redeem, fulfilment, reload.
- Reused token, double spend, wrong mint, seller offline then joins, blocked relay, missing image, fallback message.

Not verified: a payment on a real mainnet mint. Minibits is the default and has only been checked up to creating an invoice. The "upgrade to Marmot" button is untested.

## Limits

- Browser storage (keys, group state, wallet) is not encrypted at rest.
- Relays still see metadata such as timing and event kinds.
- No escrow. The wallet has no seed backup.
- The seller redeems only at the mints on their allow-list.
- Some public relays rate-limit or reject Marmot and listing kinds.

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
