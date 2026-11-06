import test from 'node:test';
import assert from 'node:assert/strict';
import { keep, reconcile } from '../src/ui/dom.js';

/** Minimal DOM-like parent: tracks insertions/removals so we can assert untouched nodes stay untouched. */
function fakeParent() {
  const kids = []; const ops = [];
  const p = {
    get firstChild() { return kids[0] || null; }, kids, ops,
    insertBefore(node, ref) { const i = kids.indexOf(node); if (i >= 0) kids.splice(i, 1); const j = ref ? kids.indexOf(ref) : kids.length; kids.splice(j, 0, node); node.parentNode = p; ops.push(['insert', node.name]); },
    removeChild(node) { kids.splice(kids.indexOf(node), 1); ops.push(['remove', node.name]); },
  };
  return p;
}
const mk = (name) => { const n = { name, get nextSibling() { const k = n.parentNode?.kids; return k ? k[k.indexOf(n) + 1] || null : null; } }; return n; };

test('reconcile: rendering the same list twice keeps the same node identities and performs no DOM operations', () => {
  const p = fakeParent(); const [a, b, c] = ['a', 'b', 'c'].map(mk);
  reconcile(p, [a, b, c]); const first = [...p.kids]; p.ops.length = 0;
  reconcile(p, [a, b, c]);
  assert.deepEqual(p.kids, first); p.kids.forEach((n, i) => assert.equal(n, first[i])); assert.equal(p.ops.length, 0, 'no insert/remove for unchanged data');
});
test('reconcile: appending a card only inserts the new one; removing only removes that one', () => {
  const p = fakeParent(); const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(mk);
  reconcile(p, [a, b, c]); p.ops.length = 0;
  reconcile(p, [a, b, c, d]); assert.deepEqual(p.ops, [['insert', 'd']]); p.ops.length = 0;
  reconcile(p, [a, c, d]); assert.deepEqual(p.ops, [['remove', 'b']]);
  assert.deepEqual(p.kids.map((n) => n.name), ['a', 'c', 'd']);
});
test('keep: builds once per signature, never on identical re-renders', () => {
  const el = {}; let builds = 0;
  assert.equal(keep(el, 'x', () => builds++), true); assert.equal(keep(el, 'x', () => builds++), false); assert.equal(keep(el, 'y', () => builds++), true); assert.equal(builds, 2);
});
