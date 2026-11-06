import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { deriveOrder, requestRumor, receiptRumor, shippedRumor, orderRumor, SUBJECT } from '../src/marketplace/orders.js';

const seller = 's'.repeat(64).replace(/s/g, 'a'); const buyer = 'b'.repeat(64);
const listing = `30402:${seller}:tea`;
let n = 0;
const at = (rumor, pubkey, t) => ({ ...rumor, pubkey, id: `r${++n}`, created_at: t });
const pay = (token, t, who = buyer) => at(orderRumor({ subject: SUBJECT.payment, orderId: 'o1', amount: 42, type: 2, payment: ['cashu', token] }), who, t);

test('timeline is derived from persisted messages only', () => {
  const rumors = [at(requestRumor({ orderId: 'o1', listingRef: listing, amount: 42, title: 'Tea' }), buyer, 10)];
  let o = deriveOrder(rumors);
  assert.equal(o.status, 'awaiting payment'); assert.equal(o.seller, seller); assert.equal(o.steps[1].done, true); assert.equal(o.steps[3].done, false);
  rumors.push(pay('cashuBabc', 20));
  o = deriveOrder(rumors);
  assert.equal(o.status, 'payment sent, not yet redeemed'); assert.equal(o.paid, false);
  rumors.push(at(receiptRumor({ orderId: 'o1', listingRef: listing, amount: 42 }), seller, 30));
  o = deriveOrder(rumors); assert.equal(o.status, 'paid');
  rumors.push(at(shippedRumor({ orderId: 'o1', listingRef: listing }), seller, 40));
  o = deriveOrder(rumors); assert.equal(o.status, 'fulfilled'); assert.ok(o.steps.every((s) => s.done));
});
test('a buyer cannot mark an order paid or fulfilled', () => {
  const rumors = [at(requestRumor({ orderId: 'o1', listingRef: listing, amount: 42 }), buyer, 10), at(receiptRumor({ orderId: 'o1', listingRef: listing, amount: 42 }), buyer, 11), at(shippedRumor({ orderId: 'o1', listingRef: listing }), buyer, 12)];
  const o = deriveOrder(rumors); assert.equal(o.paid, false); assert.equal(o.fulfilled, false);
});
test('duplicate tokens are flagged and failed redemption is shown, not hidden', () => {
  const rumors = [at(requestRumor({ orderId: 'o1', listingRef: listing, amount: 42 }), buyer, 10), pay('cashuBabc', 20), pay('cashuBabc', 21)];
  const o = deriveOrder(rumors, { redeemRecord: { state: 'failed', error: 'Token already spent' } });
  assert.deepEqual(o.payments.map((p) => p.duplicate), [false, true]);
  assert.equal(o.status, 'payment problem'); assert.match(o.steps[3].error, /already spent/);
});
test('the same message delivered twice is counted once', () => {
  const r = at(requestRumor({ orderId: 'o1', listingRef: listing, amount: 42 }), buyer, 10);
  assert.equal(deriveOrder([r, { ...r }]).steps[0].done, true);
});
