# Demo seed: "Caravan Goods"

A demo seller with Marmot enabled and 10 legal demo listings on the live market. Everything is driven by `scripts/seed-demo.mjs`. Every listing carries the tag `t=demo`; the shop profile says it is a demo. The goods are not real inventory.

Seller npub: `npub1dw9vj45lktgjma7l5ejr3prmvjqdxnygylq4z7vkg6ysy0chm2es9nruyn`

## Where things live

| What | Where |
|---|---|
| Secret key (nsec) | `.seller-demo.json` in the repo root, mode 600, listed in `.git/info/exclude`. Never committed, never printed. |
| Marmot state (key package private material) | `.seller-demo-marmot/` (also excluded). Keep it with the key file: the published key package only works with this state. |
| Product photos (1024x1024 JPEG) | `docs/seed/*.jpg`, generated with `bl image generate` (model wan2.7-image), one shared style prompt. |
| Uploaded URLs | `docs/seed/images.json` (Blossom URL, sha256, server). |

To act as the seller in the app, import the nsec from `.seller-demo.json` on the Identity page. Do this in a separate browser profile from any buyer. The app will reuse or republish a key package for that identity.

## Re-run

```bash
node scripts/seed-demo.mjs            # images (only missing), upload (only missing/broken), profile + key package, listings
node scripts/seed-demo.mjs --init     # profile (kind 0), kinds 10050/10002/30443, read-back check
node scripts/seed-demo.mjs --images   # generate missing photos (add --force to regenerate)
node scripts/seed-demo.mjs --upload   # Blossom upload; tries primal, satellite.earth, nostr.build; checks each URL returns 200 + image/*
node scripts/seed-demo.mjs --publish  # kind 30402 listings, then re-query each read relay
node scripts/seed-demo.mjs --verify   # re-query profile, key package and listings only
node scripts/seed-demo.mjs --invites  # read-only: list pending Marmot invites for the seller
```

Options: `--listing-relays a,b`, `--marmot-relays a,b`, `--blossom <url>`, `--force`.

Idempotent: the `d` tags are stable (`caravan-demo-<slug>`), `published_at` is kept from the existing event, and a listing is only re-sent when its tags changed (or with `--force`). `--force` is also how you re-broadcast to a relay that missed some events, for example damus after a rate limit.

Relays are read from `src/lib/nostr.js` at run time (`SHOPSTR_RELAYS` + `BROADCAST_RELAYS` for listings, `MARMOT_RELAYS` for the key package), which match `docs/RELAY_PROBE.md`.

Listing tags are built by `buildListingTemplate` from `src/marketplace/listings.js` (d, alt, client, title, summary, price in SAT, t=shopstr, published_at, status, image, category t, location), plus Shopstr tags the in-app form does not produce yet: `t=demo`, `quantity`, `condition=New`, and `["shipping","Added Cost","<sats>","SAT"]`.

## Delete the demo listings (NIP-09)

```bash
node scripts/seed-demo.mjs --delete
```

This publishes one kind 5 event with an `a` tag per listing address and an `e` tag per known event id, to all listing and Marmot relays. Relays that honour NIP-09 stop serving the listings. `purplepag.es` blocks kind 5 and kind 30402, so it neither held nor deletes them. Re-running the script without `--delete` afterwards publishes the listings again (newer `created_at` than the deletion).

## Known limits

- `wss://relay.damus.io` rate-limited the seller IP (earlier probe traffic) and holds only some listings. `wss://relay.nostr.band` timed out. `wss://purplepag.es` blocks kind 30402. Listings are readable from nos.lol and relay.primal.net, and written to the write-only `sendit.nosflare.com`.
- The demo images are AI-generated illustrations, not photographs of real stock.
