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

import { parseKeywordInput, loadKeywords, saveKeywords, resetKeywords, nsfwEnabled, setNsfwEnabled, DEFAULT_BLOCKED } from '../src/lib/filter.js';
const memStore = () => { const m = new Map(); return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), del: (k) => m.delete(k), getJSON: (k, f) => (m.has(k) ? JSON.parse(m.get(k)) : f), setJSON: (k, v) => m.set(k, JSON.stringify(v)) }; };
test('NSFW keywords: input parsing trims, lowercases, dedupes, splits on commas/newlines', () => {
  assert.deepEqual(parseKeywordInput(' Foo, bar ,FOO\nbaz,, '), ['foo', 'bar', 'baz']); assert.deepEqual(parseKeywordInput(''), []); assert.deepEqual(parseKeywordInput('x'.repeat(41)), []);
});
test('NSFW keywords: starts as a copy of defaults, edits persist separately, reset restores defaults', () => {
  const st = memStore(); assert.deepEqual(loadKeywords(st), DEFAULT_BLOCKED); assert.notEqual(loadKeywords(st), DEFAULT_BLOCKED);
  saveKeywords(st, ['alpha', 'beta']); assert.deepEqual(loadKeywords(st), ['alpha', 'beta']);
  assert.ok(findBlocked('selling alpha today', loadKeywords(st))); assert.equal(findBlocked('cocaine here', loadKeywords(st)), null, 'user removed defaults stay removed');
  assert.deepEqual(resetKeywords(st), DEFAULT_BLOCKED); assert.deepEqual(loadKeywords(st), DEFAULT_BLOCKED);
  assert.equal(nsfwEnabled(st), true); setNsfwEnabled(st, false); assert.equal(nsfwEnabled(st), false);
  const bad = { getJSON() { throw new Error('blocked'); }, get() { throw new Error('blocked'); } }; assert.deepEqual(loadKeywords(bad), DEFAULT_BLOCKED); assert.equal(nsfwEnabled(bad), true);
});
test('NSFW keywords: whole-word matching limits false positives for short words', () => {
  assert.equal(findBlocked('Methodology of cooking', ['meth']), null); assert.equal(findBlocked('lsdesign studio', ['lsd']), null);
  assert.ok(findBlocked('pure meth for sale', ['meth'])); assert.equal(findBlocked('weed whacker', ['cannabis']), null);
});
