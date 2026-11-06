import test from 'node:test';
import assert from 'node:assert/strict';
import { filterByImage, hasValidImage } from '../src/marketplace/listings.js';

const L = [{ image: 'https://a.example/x.png' }, { image: '' }, {}, { image: 'javascript:alert(1)' }, { image: 'not a url' }, { image: 'http://b.example/y.jpg' }];
test('hasValidImage accepts only http(s) URLs', () => { assert.deepEqual(L.map(hasValidImage), [true, false, false, false, false, true]); });
test('Has image ON hides listings without a valid image and counts them', () => {
  const on = filterByImage(L, true); assert.equal(on.shown.length, 2); assert.equal(on.hidden, 4);
  const off = filterByImage(L, false); assert.equal(off.shown.length, 6); assert.equal(off.hidden, 0);
});

import { isJunkListing, parseListing } from '../src/marketplace/listings.js';
test('junk/probe/test listings are recognised', () => {
  assert.ok(isJunkListing('probe-1793935620369', 'x')); assert.ok(isJunkListing('abc', 'probe')); assert.ok(isJunkListing('abc', 'Probe ')); assert.ok(isJunkListing('abc', '[test] camel'));
  assert.ok(!isJunkListing('abc', 'Probe camel saddle')); assert.ok(!isJunkListing('camel-1', 'Camel saddle'));
});
test('emptied replacement events do not parse as listings', () => {
  const base = { kind: 30402, pubkey: 'a'.repeat(64), id: 'b'.repeat(64), created_at: 1, content: '' };
  assert.equal(parseListing({ ...base, tags: [['d', 'x'], ['status', 'deleted']] }), null);
  assert.ok(parseListing({ ...base, tags: [['d', 'x'], ['title', 'Real'], ['price', '5', 'SAT']] }));
});
