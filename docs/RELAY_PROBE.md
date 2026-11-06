# Relay probe

Tool: `node scripts/probe-relays.mjs wss://relay…` (uses the real `src/lib/marmot.js` with ephemeral keys, `fake-indexeddb`, one fresh seller+buyer per relay, about 14 events per relay). Run on 2026-11-06 from one residential IP. Test: seller publishes key package (30443) + inbox list (10050) + NIP-65 list (10002); events are read back; buyer starts a group (commit 445, welcome gift wrap 1059); seller receives and accepts the welcome; messages 445 both ways; a NIP-99 listing 30402 is published and read back; a raw legacy kind 443 is published (444 is never published, it lives inside the 1059 wrap).

"run" = `run1` first pass (14 relays), `run2` second pass (this includes the Shopstr relays that were added later and a re-run of some). Two passes where available show flakiness.

| Relay | run | kp 30443/10050/10002 | read-back | 445+1059 publish | 1059 recv | 445 b->s | 445 s->b | 30402 | 443 | Marmot-OK | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| relay.damus.io | run1 | yes | NO | yes | NO | n/a | n/a | NO | NO | no | kinds ; no invite within 20s; All promises were rejected; All promises were rejected |
| relay.damus.io | run2 | NO | NO | NO | n/a | n/a | n/a | NO | NO | no | banned: too many rate-limit violations, try again later;connection failure: connection failed;rate-limited: yo |
| relay.primal.net | run1 | yes | yes | yes | yes | NO | yes | yes | yes | no | Not acknowledged by any relay (Failed to publish application message: publish timed out). It is kept locally;  |
| relay.primal.net | run2 | yes | yes | yes | yes | yes | yes | yes | yes | **yes** |  |
| relay.nostr.band | run1 | NO | NO | NO | n/a | n/a | n/a | NO | NO | no | connection failure: connection timed out;connection failure: connection timed out;connection failure: connecti |
| offchain.pub | run1 | yes | yes | NO | n/a | n/a | n/a | yes | yes | no | [false] |
| nostr.mom | run1 | yes | yes | yes | yes | yes | yes | yes | yes | **yes** |  |
| nostr.mom | run2 | yes | yes | yes | yes | yes | yes | yes | yes | **yes** |  |
| relay.snort.social | run1 | yes | yes | yes | yes | yes | yes | yes | yes | **yes** |  |
| relay.snort.social | run2 | yes | yes | yes | yes | yes | yes | yes | yes | **yes** |  |
| nostr.wine | run1 | NO | NO | NO | n/a | n/a | n/a | NO | NO | no | restricted: sign up at https://nostr.wine to write events to this relay;restricted: sign up at https://nostr.w |
| relay.nostr.bg | run1 | NO | NO | NO | n/a | n/a | n/a | NO | NO | no | connection failure: connection failed;connection failure: connection failed;connection failure: connection fai |
| purplepag.es | run1 | NO | NO | NO | n/a | n/a | n/a | NO | NO | no | blocked: kind 30443 is not allowed; kinds 10002,10050; Seller has no published Marmot key package. They must o |
| nostr-pub.wellorder.net | run1 | yes | yes | NO | n/a | n/a | n/a | yes | yes | no | [false] |
| relay.mostr.pub | run1 | NO | NO | NO | n/a | n/a | n/a | NO | NO | no | connection failure: connection failed;connection failure: connection failed;connection failure: connection fai |
| relay.0xchat.com | run1 | NO | NO | NO | n/a | n/a | n/a | NO | NO | no | connection failure: connection failed;connection failure: connection failed;connection failure: connection fai |
| nostr.oxtr.dev | run1 | yes | yes | yes | yes | yes | yes | yes | yes | **yes** |  |
| nostr.oxtr.dev | run2 | yes | yes | yes | yes | yes | yes | yes | yes | **yes** |  |
| relay.nostr.net | run1 | yes | yes | NO | n/a | n/a | n/a | yes | yes | no | Seller has no published Marmot key package. They must open the app (publish a key package) before you can star |
| freelay.sovbit.host | run2 | yes | yes | yes | yes | yes | yes | yes | yes | **yes** |  |
| nos.lol | run2 | yes | yes | yes | yes | yes | yes | yes | yes | **yes** |  |
| nostr-01.yakihonide.com | run2 | NO | NO | NO | n/a | n/a | n/a | NO | NO | no | connection failure: connection failed;connection failure: connection failed;connection failure: connection fai |
| nostr.bitcoiner.social | run2 | yes | yes | NO | n/a | n/a | n/a | yes | yes | no | [false] |
| nostr21.com | run2 | NO | NO | NO | n/a | n/a | n/a | NO | NO | no | connection failure: connection timed out;connection failure: connection timed out;connection failure: connecti |
| relay.coinos.io | run2 | yes | yes | yes | yes | yes | yes | NO | yes | **yes** | All promises were rejected |
| relay.current.fyi | run2 | NO | NO | NO | n/a | n/a | n/a | NO | NO | no | connection failure: connection failed;connection failure: connection failed;connection failure: connection fai |
| relay.ditto.pub | run2 | yes | yes | yes | yes | yes | yes | yes | yes | **yes** |  |
| relay.gulugulu.moe | run2 | yes | yes | yes | yes | yes | yes | yes | yes | **yes** |  |
| relay.lexingtonbitcoin.org | run2 | NO | NO | NO | n/a | n/a | n/a | NO | NO | no | blocked: we are rebuilding the trust network, please try again later;blocked: we are rebuilding the trust netw |
| relay.nostrplebs.com | run2 | NO | NO | NO | n/a | n/a | n/a | NO | NO | no | blocked: you do not have a Nostr Plebs NIP-05.;blocked: you do not have a Nostr Plebs NIP-05.;blocked: you do  |
| relay.noswhere.com | run2 | yes | NO | NO | n/a | n/a | n/a | NO | yes | no | kinds ; Seller has no published Marmot key package. They must open the app (publish a key package) before you  |
| relay.orangepill.dev | run2 | NO | NO | NO | n/a | n/a | n/a | NO | NO | no | relay connection failed;relay connection failed;relay connection failed; kinds ; Seller has no published Marmo |
| relay.plebeian.market | run2 | NO | NO | NO | n/a | n/a | n/a | NO | NO | no | connection failure: connection failed;connection failure: connection failed;connection failure: connection fai |
| sendit.nosflare.com | run2 | yes | NO | NO | n/a | n/a | n/a | NO | yes | no | kinds ; Seller has no published Marmot key package. They must open the app (publish a key package) before you  |

Marmot-OK = key package/lists publish and read back, welcome and commit publish, welcome received, messages both ways.

## Chosen lists

**MARMOT relays (messaging; all kinds passed, no auth/payment):** `wss://nos.lol`, `wss://relay.primal.net`, `wss://relay.ditto.pub`, `wss://nostr.mom`, `wss://relay.snort.social`. Fallbacks offered in the UI: `wss://nostr.oxtr.dev`, `wss://relay.gulugulu.moe`, `wss://freelay.sovbit.host`.

**LISTING relays (Shopstr's own defaults, so listings interoperate):** `wss://relay.damus.io`, `wss://nos.lol`, `wss://purplepag.es`, `wss://relay.primal.net`, `wss://relay.nostr.band`, plus the write-only broadcast relay `wss://sendit.nosflare.com` (it answers `Denied! This relay does not accept REQs` to reads, so it is only written to).

## Honest findings

- `relay.damus.io`: first pass published the key package but did not return events; later passes were refused with `banned: too many rate-limit violations` / `rate-limited: you are noting too much`. Our probe volume (two passes plus test runs from the same IP) triggered this. Result for damus is INCONCLUSIVE and it is not used for Marmot. It stays in the listing list because Shopstr uses it.
- `purplepag.es`: only accepts profile/relay-list kinds (`blocked: kind 30443 is not allowed`, `kind 5 is not allowed`), so it cannot take key packages, listings or deletions. Read-only use as a Shopstr default.
- `relay.nostr.band`, `relay.plebeian.market`, `relay.0xchat.com`, `relay.nostr.bg`, `relay.mostr.pub`, `nostr21.com`, `relay.current.fyi`, `relay.orangepill.dev`: connection failed/timed out from here.
- `nostr.wine` (restricted: sign up), `relay.nostrplebs.com` (requires NIP-05), `relay.lexingtonbitcoin.org` (trust network): not free or open.
- `offchain.pub`, `nostr.bitcoiner.social`, `nostr-pub.wellorder.net`, `relay.nostr.net`: take key packages but the welcome (1059) publish or read-back failed; not usable for Marmot.
- `relay.primal.net` failed one live 445 message in `run1` (publish timed out) and passed in `run2`: possibly flaky under load.
- `relay.coinos.io` passed all Marmot steps but rejected the 30402 listing, so it is not used for listings.
- `relay.ditto.pub` and `relay.gulugulu.moe` accept 30402 and 30443 etc. but are search-oriented; they pass all kinds.

## Cleanup status

Early probe versions (before this document) published `[kind 30402 title "probe"]` listings with throw-away keys that were not kept, so they could not be deleted. The probe script now keeps its key, deletes its own events (NIP-09 kind 5 with `e` and `a` tags plus an empty replacement) in a `finally` block, and uses the title `[test] probe listing, ignore`. The app hides listings whose `d` tag starts with `probe-`, whose title is `probe`, or starts with `[test]` (production builds only). See docs/PROD_TEST_REPORT.md for the list of orphaned event ids.
