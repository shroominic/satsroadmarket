import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildListingTemplate, latestListings, publishListing, safeImageURL } from '../src/marketplace/listings.js';

const input = { title: 'Tea', description: 'Green tea', price: '42', image: 'https://example.com/tea.jpg', legal: true };
test('NIP-99 template is Shopstr compatible and requires legal confirmation', () => {
  const event = buildListingTemplate(input, 123);
  assert.equal(event.kind, 30402);
  assert.equal(event.content, input.description);
  assert.deepEqual(event.tags.find(([key]) => key === 'price'), ['price', '42', 'SAT']);
  assert(event.tags.some(([key, value]) => key === 't' && value === 'shopstr'));
  assert.throws(() => buildListingTemplate({ ...input, legal: false }), /legal/);
  assert.throws(() => buildListingTemplate({ ...input, image: 'javascript:alert(1)' }), /image URL/);
  assert.equal(buildListingTemplate({ ...input, image: '' }, 1).tags.some(([k]) => k === 'image'), false);
  assert.equal(safeImageURL('broken'), '');
});
test('addressable updates collapse by seller and d; sold listings disappear', () => {
  const template = buildListingTemplate({ ...input, id: 'tea' }, 123);
  const base = { ...template, id: 'a', pubkey: 'a'.repeat(64) };
  const update = { ...base, id: 'b', created_at: 124, tags: template.tags.map((t) => t[0] === 'title' ? ['title', 'New title'] : t) };
  assert.equal(latestListings([update, base])[0].title, 'New title');
  assert.deepEqual(latestListings([{ ...update, tags: [...update.tags.filter(([k]) => k !== 'status'), ['status', 'sold']] }, base]), []);
});
test('publish requires acknowledgement and reports relay failure', async () => {
  const signer = { signEvent: async (event) => ({ ...event, id: 'signed' }) };
  const event = await publishListing({ input, signer, pool: { publish: () => [Promise.reject(new Error('offline')), Promise.resolve('ok')] }, relays: ['one', 'two'] });
  assert.equal(event.id, 'signed');
  await assert.rejects(publishListing({ input, signer, pool: { publish: () => [Promise.reject(new Error('offline'))] }, relays: ['one'] }), /rejected/);
});
test('publish reports each relay answer and tolerates a hanging relay', async () => {
  const signer = { signEvent: async (event) => ({ ...event, id: 'signed' }) };
  let acks;
  await publishListing({ input, signer, relays: ['a', 'b', 'c'], timeoutMs: 20, onAck: (x) => { acks = x; },
    pool: { publish: () => [Promise.resolve('ok'), Promise.reject(new Error('blocked: rate-limited')), new Promise(() => {})] } });
  assert.deepEqual(acks.map((a) => a.ok), [true, false, false]);
  assert.match(acks[1].message, /rate-limited/); assert.match(acks[2].message, /No answer/);
});
