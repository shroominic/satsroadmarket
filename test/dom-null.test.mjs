import test from 'node:test';
import assert from 'node:assert/strict';
import { setKids } from '../src/ui/dom.js';

test('regression: pager children containing null (no "loading more" row) never render the text "null"', () => {
  let received; const el = { replaceChildren: (...k) => { received = k; } };
  const next = { nodeType: 1 };
  setKids(el, next, null, undefined, false, [null, next]);
  assert.deepEqual(received, [next, next]);
  assert.ok(!received.includes(null));
});
