import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { findBlocked, filterListings, listingBlockReason, normalizeText } from '../src/lib/filter.js';

test('blocks common illegal-goods keywords, including plurals and phrases', () => {
  assert.equal(findBlocked('Pure Cocaine 1g'), 'cocaine');
  assert.equal(findBlocked('Fentanyl pills'), 'fentanyl');
  assert.equal(findBlocked('selling stolen credit cards'), 'stolen');
  assert.equal(findBlocked('Fake ID, any state'), 'fake id');
  assert.equal(findBlocked('premium MDMA'), 'mdma');
});
test('catches simple obfuscation', () => {
  assert.equal(findBlocked('c0caine'), 'cocaine');
  assert.equal(findBlocked('h.e.r.o.i.n'), 'heroin');
  assert.equal(findBlocked('f u l l z for sale'), 'fullz');
  assert.ok(normalizeText('Café') === 'cafe');
});
test('does not block ordinary goods or substrings', () => {
  for (const text of ['Hand-knitted wool socks', 'Weed killer, 5 litre', 'Methodist hymnal', 'Pharmacy gift basket', 'Ledger hardware wallet', 'Tumbleweed art print', 'Dispatch case', 'Class ring']) {
    assert.equal(findBlocked(text), null, text);
  }
});
test('listing filter checks title, description, tags and hides matches', () => {
  const ok = { title: 'Tea', description: 'Green tea', tags: ['tea'] };
  const badTitle = { title: 'Heroin', description: 'x', tags: [] };
  const badDesc = { title: 'Gift', description: 'ships with counterfeit money', tags: [] };
  const badTag = { title: 'Gift', description: 'nice', tags: ['ransomware'] };
  const { shown, hidden } = filterListings([ok, badTitle, badDesc, badTag]);
  assert.deepEqual(shown, [ok]);
  assert.equal(hidden, 3);
  assert.equal(listingBlockReason(badTag), 'ransomware');
});
test('custom keyword lists are honoured', () => {
  assert.equal(findBlocked('limited edition widget', ['widget']), 'widget');
  assert.equal(findBlocked('cocaine', ['widget']), null);
});
