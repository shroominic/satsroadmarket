# DECISIONS

## D1 — Companion app, not a Shopstr fork (2026-11-06)
Shopstr (checked out in `.research/shopstr`) is Next.js 16 + Postgres + API routes. It cannot deploy as static Cloudflare Pages, and forking it risks destabilising the upstream. We build a small Vite SPA that **speaks Shopstr's protocol**:
- Listings: NIP-99 `kind 30402`, Shopstr tags (`title`, `summary`, `image`, `price`, `location`, `t`, `d`, `published_at`) — so Shopstr listings show up here and ours show up in Shopstr.
- Order/payment messages: Shopstr's rumor tag conventions (`subject`, `order`, `amount`, `a` product ref, `payment`), carried inside a Marmot group instead of a NIP-17 DM.
- Cashu: `@cashu/cashu-ts` (Shopstr pins 4.6.0), V4 `cashuB` tokens.

## D2 — Marmot via `@internet-privacy/marmot-ts` 0.9.0 (MIT, maintained)
Validated: package resolves, ships MLS (`ts-mls`), key packages, welcomes (gift-wrapped), group history stores. We do no crypto ourselves. MDK (Rust) is the reference peer; not needed for the browser demo.

## D3 — Ecash inside the Marmot chat
Buyer swaps proofs at the mint to a token locked/sent as a `cashuB…` string in an application message in the group. Seller receives, verifies state with the mint (`checkProofsStates`), swaps/redeems into own wallet, then marks order paid. "Paid" is only shown after mint redemption succeeds. Duplicate token (same proof Ys) is detected locally and by mint.

## D4 — Hosting
Static `dist/` to Cloudflare Pages (`wrangler pages deploy`). No server. Relays and mint are external; local fallback = `npm run relay` + `npm run mint` (nutshell, FakeWallet).

## D5 — Content filtering
Client-side keyword filter on listing title/summary/tags; publishing form requires a "legal goods only; relay operators are responsible for filtering" acknowledgement. No other disclaimers.

## D6 — Branding
Black background, phosphor green, a single red eye glint, pixel-art camel with rider. Name "SatsRoad Market", tagline "private marketplace". Reference logo supplied by owner (2026-11-06); recreated as `public/camel-logo.svg`.

## Dependency / risk list
| Risk | Impact | Mitigation |
|---|---|---|
| marmot-ts API drift / browser bundling of ts-mls | High | Spike first; Node two-identity test before UI |
| Public relays drop kinds 443/444/445/1059 or rate-limit | High | Local relay fallback; show real publish status per relay |
| Key package for seller missing/stale | Med | Seller publishes on login; buyer sees "seller not reachable" and can retry; invite stays deferred |
| Real mint availability / funds | Med | Local nutshell FakeWallet mint for demo + tests; testnut for public |
| Cashu double-spend/invalid token | Med | Explicit error states, tests |
| IndexedDB state unencrypted at rest | Low | Documented limitation |
| Blossom upload server availability | Med | Image URL fallback; missing-image placeholder |

## Exact demo path
1. Seller profile: login (nsec), "Publish key package", create listing with image (Blossom upload or URL) → relay ACK.
2. Buyer profile (separate browser profile): market shows listing → open → "Start private conversation" → Marmot group created, seller invited (Welcome).
3. Seller accepts invite (deferred join works if seller was offline) → both exchange messages.
4. Buyer "Pay with ecash" → token posted in group → seller "Redeem" → mint result → order shows PAID → seller marks fulfilled.
5. Reload both → order timeline and messages persist.
6. Failure panel: relay down, bad/double-spent token, missing key package, image 404 — each shown honestly with retry.

## Workstreams
A Marmot messaging (`src/lib/marmot.js`, Node two-identity test) · B Ecash (`src/payments/`, local mint, tests) · C App/UX/brand (`src/main.js`, views, CSS, logo, Cloudflare) · D E2E testing + runbook (Playwright two profiles) · E Submission (README, THREAT_MODEL, slides, limitations).

## Six-hour plan
H1 spikes A+B+C-shell in parallel · H2 Marmot two-identity test green; token send/redeem green vs local mint · H3 UI wiring listings→chat→pay · H4 persistence, failure states, filter, Blossom · H5 Playwright two-profile run, screenshots/recording · H6 docs, slides, Cloudflare deploy, fresh-clone runbook.

## Fallback
If Marmot browser integration fails: keep Marmot in a Node/CLI bridge and demo chat from a local companion process, labelled honestly. If ecash against mint fails: local FakeWallet mint only; never fake "paid".
