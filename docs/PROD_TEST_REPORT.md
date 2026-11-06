# Production test report

Date: 2026-11-06. Site: https://satsroadmarket.com (GitHub Pages, branch `gh-pages`, deployed with `scripts/deploy-gh-pages.sh`).
Honest scope note: after the owner removed all demo/test features from the production bundle, **fake-money flows can no longer run on the live site**. They run against an E2E build (`npm run build:e2e`, served with `npm run preview:e2e` on 127.0.0.1:4173) that uses the same code but enables testnut. Everything else in that build still talks to the **real public relays, real Blossom and real testnut mint**. Live-site checks (read-only, no fake money, nothing published) are listed separately. No real Lightning invoice was ever paid by any test; the Minibits mint was only asked for an invoice that was then cancelled unpaid.

Scripts: `scripts/prod-e2e.mjs` (happy-path journey), `scripts/prod-e2e-failures.mjs` (scenarios 1-10, `ONLY=…`, `LIVE=1`), `scripts/prod-cache-measure.mjs`, `scripts/measure-rerender.mjs`, `scripts/prod-ui-check.mjs`. Every run that publishes deletes its own events at the end (`scripts/e2e-cleanup.mjs`, NIP-09 plus empty replacement) and titles start with `[test]`.
Screenshots: `docs/screens/prod-*.png` (journey/failure screens come from the E2E build, the `prod-header-*`, `prod-pagination`, `prod-cache-first-paint`, `prod-market-*`, `prod-filter-chip-*`, `prod-mint-*` screens from the live site).

## A. Happy-path journey (E2E build, public relays + Blossom + testnut, two isolated browser contexts)
| Step | Result |
|---|---|
| Seller uploads a real image to blossom.primal.net from the browser (CORS ok), URL fetchable | PASS |
| Seller publishes a listing; per-relay ACKs shown | PASS (damus, nos.lol, primal, mom, snort ACK; purplepag.es rejects kind 30402; nostr.band unreachable) |
| Buyer sees the listing with the image through public relays | PASS (4-8 s) |
| Buyer starts private conversation, seller accepts invite | PASS |
| Messages both ways | PASS (2-6 s each way) |
| Buyer funds from testnut, creates token, pays in chat | PASS |
| Seller redeems at the mint, order PAID only after redemption; buyer sees receipt | PASS |
| Seller marks fulfilled, buyer sees FULFILLED | PASS |
| Reload both: messages and timeline persist | PASS |
The journey passed in each of the 4 full runs; public-relay timing varies (journey 45-75 s).

## B. Failure paths (E2E build)
| Scenario | Result |
|---|---|
| Reused token in a second order: seller UI rejects "Duplicate token", order not PAID | PASS |
| Mint-level double spend (seller's local duplicate marker deleted): mint answers "Already spent" | PASS (after fixing my test's marker clearing) |
| Wrong mint (seller accepts only Minibits, buyer pays a testnut token): "Mint not accepted", not PAID | PASS (the first attempt used `nofees.testnut.cashu.space`, which does not exist: DNS failure, so the test was changed) |
| Seller offline when invited, joins later from a restored profile, messages flow | PASS |
| One relay blocked (nos.lol): UI marks it offline, publish shows per-relay REJECTED for it, chat and messages still work over the rest | PASS |
| Missing image: 404 URL and no image show placeholders | PASS |
| Blossom failure: unreachable server gives readable error plus fallback buttons; non-image file rejected | PASS |
| Seller without key package: explicit NIP-17 DM fallback (editable text, nothing sent until Send, "NOT end-to-end private in the Marmot sense" warning), "Waiting for seller…" with Retry, seller sees DM in inbox, seller publishes key package, buyer's Retry starts the Marmot group, messages flow | PASS when run alone (3 times). FAILED once inside the long full run: cause was a real bug (background updates re-drew the listing detail and wiped the fallback panel). Fixed (detail view is kept while data is unchanged); the fixed build passed the scenario alone, but I did not re-run the whole suite afterwards |
| Offline at start, then recovery: UI shows DISCONNECTED with a friendly line and per-relay reasons (no raw JSON), recovers to READY, key package publishes, 1 websocket per relay | PASS (relays refused by a routed WebSocket stub, not by real airplane mode) |
| USD-priced listing: card shows "$1.00 USD ≈ 1,322 sats"; order priced in sats at order time (1,322), rate line and "(1 USD at 75619.69 USD/BTC)" shown to the buyer and seller | PASS (observed in screenshots and card text) |
| USD order: fund, token, send, seller redeem with the 2% tolerance | PASS in the final full run (order tags observed: `amount:1328`, `price:1:USD`, `rate`). Earlier failures were testnut/network slowness (curl to testnut took 9-30 s at that time) plus my test funding exactly the order amount with no fee headroom: mint timeout raised to 30 s, test funding now adds 10% + 10 sats |

## C. Live-site checks (satsroadmarket.com, read-only)
| Check | Result |
|---|---|
| Fresh visitor: default mint Minibits, no banner, no TEST label, no Fund-test button | PASS |
| Minibits "Add funds": quote created, bolt11 text and QR shown, cancelled unpaid | PASS |
| Header: compact status row, popover with per-relay status, desktop and 390 px | PASS (screenshots `prod-header-*.png`) |
| Market: fiat listings show own currency plus sats (e.g. "€40.00 EUR ≈ 59,100 sats"), no "null", infinite scroll appends (24 → 49 cards), restores scroll after opening a listing and back, classic pages switch persists | PASS |
| "Has image" chip default ON, hides image-less (73 of 123 hidden), ✕ shows them, + restores, persists after reload | PASS |
| Cache: second visit with relays unreachable and throttled HTTP paints 24 cards from cache in 188 ms (cold first card 8.1 s) | PASS |
| Background paging: 24 cards / 50 listings after 3 s, 214 listings after 15 s, 345 events cached | PASS |
| Idle re-render, 60 s on the market page, before the flicker fix: 2,626 nodes removed and re-added, 312 `<img>` replaced, 2 of 12 sampled frames changed. After: 32 nodes, 0 images, 0 frames changed | PASS (fixed) |
| `dist/` grep: no 127.0.0.1, testnut, "TEST MINT", "Fund test" strings; `localhost` only inside the marmot-ts library's own URL validation; `demo` only in `/demo/slides` | PASS |

## D. Unit/regression tests (`npm test`)
Added: relay-probe independent tests for DM wrap/unwrap, image filter chip, loader (merge/dedupe/cursors/deletions/expiry/backoff/cache-before-network), subscription backoff, money (parse/convert/format/compact/rates/tolerance), keyed DOM reconcile, pager "null" regression, NSFW keyword editing/persistence/reset. Total 61 passing at the last full run, **except** `test/cashu.mint.test.mjs`: 4-5 of its 8 tests failed at the end with `429 Too Many Requests` from the local nutshell mint at 127.0.0.1:3338 (rate limiting of the local mint after many requests); they passed earlier in the session. I did not investigate further.

## E. Known issues and things not done
- Marmot badge, "Marmot vendors" chip, standard NIP-17 conversations ("Message without Marmot", confirmation, order/payment tags, reload persistence, upgrade button) are implemented. The upgrade-to-Marmot button is covered by code only, not by an E2E run.
- Header: popover is mouse/keyboard operable but I did not run a screen-reader pass.
- Public relay timing is flaky: first listing card takes about 8 s cold; `relay.damus.io` rate-limits/bans my test IP (503 / banned) and `purplepag.es` rejects 30402/30443/kind 5; `relay.nostr.band` and `relay.plebeian.market` were unreachable.
- Orphaned public test events whose throw-away keys were not kept (early probe versions and the first journeys): 12 distinct events (down from 34 after a final cleanup pass with the kept keys; all remaining ones belong to throw-away keys that were never kept) remained on public relays at the last query. They are hidden by the app (d-tag `probe-…`, title `probe` or `[test]…`) but still exist; see `docs/screens`-independent list produced by `node scripts/list-test-leftovers.mjs`. Events from runs whose keys were kept were deleted with NIP-09 where relays allow it (purplepag.es and damus did not accept deletes).
- The wrong-mint test depends on the seller changing the accepted mint; no second public fake mint was found.

## F. Final full run (after all changes; network recovered)
Journey (E2E build): 16/16 PASS. Failure scenarios 1-5, 8, 10 (E2E build): all PASS. Scenario 11 (standard NIP-17 conversation, dev server with local relay and local mint): 4/4 PASS. Live read-only scenarios 6, 7, 9 and 12: all PASS (scenario 12 first failed on a flawed assertion: background paging legitimately appended cards, so the check now only requires already-shown cards to keep their positions). `npm test`: 70/70 pass (its `pretest` starts the local mint with rate limiting disabled; the earlier 429 failures came from nutshell's default rate limit hit by the test burst, and later from the mint container not running).
During one mid-session run the whole network was degraded (curl to google took 7 s, testnut 9-30 s) and a full journey run failed almost everywhere; I discarded that run and re-ran when latency was back to about 1 s.
