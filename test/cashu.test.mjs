import test from 'node:test';
import assert from 'node:assert/strict';
import { getEncodedToken } from '@cashu/cashu-ts';
import { createCashuPaymentMessage, inspectCashuToken, overlapsPriorPayment } from '../src/payments/cashu.js';

// Synthetic proofs are for parsing tests only. They are not spendable ecash.
const proof = (secret, amount = 1) => ({ id: '009a1f293253e41e', amount, secret, C: '02' + '11'.repeat(32) });
const token = (proofs, unit = 'sat') => getEncodedToken({ mint: 'https://mint.example', unit, proofs });
const listing = `30402:${'a'.repeat(64)}:demo`;

test('a parsed token is explicitly unverified, and can be put in a private payload', async () => {
  const input = token([proof('one', 2)]);
  const info = await inspectCashuToken(input);
  assert.equal(info.amount, 2);
  assert.equal(info.status, 'unverified');
  assert.deepEqual(await createCashuPaymentMessage(input, listing), { type: 'cashu', token: input, listing });
});

test('invalid input and unsupported units are rejected', async () => {
  await assert.rejects(inspectCashuToken('not a token'), /not a readable/);
  await assert.rejects(inspectCashuToken(token([proof('one')], 'usd')), /Only sat/);
  await assert.rejects(createCashuPaymentMessage(token([proof('one')]), ''), /listing/);
});

test('duplicate and overlapping proofs are identified across different tokens', async () => {
  const first = await inspectCashuToken(token([proof('one'), proof('two')]));
  const reordered = await inspectCashuToken(token([proof('two'), proof('three')]));
  const unrelated = await inspectCashuToken(token([proof('four')]));
  assert.equal(overlapsPriorPayment(reordered, first.proofIds), true);
  assert.equal(overlapsPriorPayment(unrelated, first.proofIds), false);
  await assert.rejects(inspectCashuToken(token([proof('one'), proof('one')])), /repeats a proof/);
});
