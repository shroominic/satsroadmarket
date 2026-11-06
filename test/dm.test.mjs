import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { unwrapEvent } from 'nostr-tools/nip59';
import { buildDmWraps, defaultDmText } from '../src/marketplace/dm.js';

test('NIP-17 listing DM: kind 1059 wrap -> seal -> kind 14 rumor with listing ref, readable only by the seller', () => {
  const buyer = generateSecretKey(), seller = generateSecretKey(), other = generateSecretKey();
  const ref = `30402:${getPublicKey(seller)}:camel-1`; const text = defaultDmText('Camel saddle');
  const { toSeller, toSelf } = buildDmWraps({ sk: buyer, recipient: getPublicKey(seller), selfPubkey: getPublicKey(buyer), listingRef: ref, text });
  assert.equal(toSeller.kind, 1059); assert.equal(toSelf.kind, 1059);
  assert.ok(toSeller.tags.some((t) => t[0] === 'p' && t[1] === getPublicKey(seller)));
  const rumor = unwrapEvent(toSeller, seller);
  assert.equal(rumor.kind, 14); assert.equal(rumor.content, text); assert.equal(rumor.pubkey, getPublicKey(buyer));
  assert.equal(rumor.tags.find((t) => t[0] === 'a')[1], ref);
  assert.ok(!toSeller.content.includes('Camel saddle'), 'plaintext not visible to relays');
  assert.throws(() => unwrapEvent(toSeller, other));
  assert.equal(unwrapEvent(toSelf, buyer).content, text);
  assert.match(text, /Please publish a Marmot key package/);
});
