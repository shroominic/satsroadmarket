# SatsRoad Market — submission draft

**Track:** Privacy and Marmot  
**One-line pitch:** Browse publicly, negotiate in a private Marmot group, and send Cashu ecash in the conversation, using portable Nostr identities.

## The problem

Online marketplaces often connect listings, account identity, payment addresses, and private negotiations. Merchants and buyers need a way to discover a public offer without making the rest of their exchange public.

## What we are building

SatsRoad Market is a companion marketplace that uses Shopstr-compatible NIP-99 listings for discovery. The intended private order flow uses Marmot/MLS for persistent buyer–seller conversation and Cashu bearer ecash for payment without an invoice. Listings remain public; encrypted communication does not make their metadata or the parties' network activity invisible.

## Two-minute live demo script

**Before presenting:** Open two separate browser profiles with distinct Nostr identities. Connect both to the selected relay; confirm the seller has published a Marmot key package. Prepare a real Cashu token for the seller's accepted mint. Confirm the listing image URL loads. Run through the sequence once before the presentation.

- **0:00–0:15 — Public discovery.** “SatsRoad Market keeps discovery open. Here is a seller publishing a legal product with a photo, price, and description as a NIP-99 listing.” Publish and wait for a relay acknowledgement.
- **0:15–0:35 — Buyer finds the offer.** Switch to the buyer profile, refresh the market, open the listing, and start a conversation. “The listing is public. The negotiation belongs in a private group.”
- **0:35–1:05 — Marmot group.** Show the seller's invite, accept it, and send a message each way. “Marmot uses MLS group state rather than an ordinary DM. Both people keep their own Nostr identity.” If the invite or a relay is delayed, show the actual status and retry.
- **1:05–1:30 — Ecash.** Send a prepared Cashu token inside the group. Have the seller redeem it at the mint and show the actual result. “This payment does not need an invoice or a payment address.” Do not call the order paid until redemption succeeds.
- **1:30–1:50 — Return to the order.** Close and reopen the app, reconnect the same identities, and open the conversation. Show the messages and order context that actually persisted.
- **1:50–2:00 — Close.** “Public discovery, private negotiation, and invoice-free ecash: portable commerce on Nostr.”

## Verification status

**Unverified end-to-end:** This is a demo script, not evidence that the complete flow has passed. Verify each step on the current build before presenting. Do not claim successful invite delivery, private message persistence, mint redemption, payment deduplication, or reopen recovery until observed in both profiles.

**Verified in isolated marketplace work:** A signed kind 30402 event was accepted and retrieved using `nostr-tools` and a minimal local WebSocket relay. Listing-template tests cover the Shopstr tag, legal confirmation, image URL validation, update selection, and relay publish failure. This does not prove a public relay or the full purchase journey.

**Fallback:** If live relay, Marmot, or mint steps fail, show the real error and the verified portions of the app. A recording may be used only if it captures a previously successful run; label it as a recording. Do not simulate a payment or claim an unconfirmed message was delivered.
