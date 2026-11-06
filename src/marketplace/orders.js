/**
 * Order timeline derived ONLY from decrypted Marmot rumors (plus an optional local redeem record),
 * so it survives reload: the Marmot history store is the source of truth.
 * Tag conventions follow Shopstr's order DMs: subject, order, type, amount, payment, status, item.
 */
export const SUBJECT = { info: 'order-info', payment: 'order-payment', receipt: 'order-receipt', shipping: 'shipping-info' };
const tag = (rumor, name) => rumor.tags?.find((t) => t[0] === name);
const tagValue = (rumor, name) => tag(rumor, name)?.[1] || '';

export function orderRumor({ kind = 14, subject, orderId, listingRef, amount, status, type, payment, content = '', extra = [] }) {
  const tags = [['subject', subject], ['order', orderId]];
  if (type) tags.push(['type', String(type)]);
  if (amount) tags.push(['amount', String(amount)]);
  if (status) tags.push(['status', status]);
  if (payment) tags.push(['payment', ...payment]);
  if (listingRef) tags.push(['item', listingRef, '1']);
  return { kind, content, tags: [...tags, ...extra] };
}
export const requestRumor = ({ orderId, listingRef, amount, title }) => orderRumor({ subject: SUBJECT.info, orderId, listingRef, amount, type: 1, status: 'pending', content: `Order request: ${title || 'listing'} for ${amount} sats.` });
export const receiptRumor = ({ orderId, listingRef, amount }) => orderRumor({ subject: SUBJECT.receipt, orderId, listingRef, amount, type: 4, status: 'confirmed', content: `Payment redeemed at the mint: ${amount} sats.` });
export const shippedRumor = ({ orderId, listingRef, note }) => orderRumor({ subject: SUBJECT.shipping, orderId, listingRef, type: 3, status: 'shipped', content: note || 'Order fulfilled.' });

/** Fallback payment parsing from tags: ['payment','ecash',token]. The Cashu module may override. */
export function parsePaymentTags(rumor) {
  if (tagValue(rumor, 'subject') !== SUBJECT.payment) return null;
  const pay = tag(rumor, 'payment');
  if (!pay || !['ecash', 'cashu'].includes(pay[1]) || !pay[2]) return null;
  return { token: pay[2], amount: Number(tagValue(rumor, 'amount')) || null, orderId: tagValue(rumor, 'order') };
}

/**
 * @param rumors decrypted rumors in the group
 * @param opts { parsePayment, redeemRecord: {state:'failed'|'ok', error?, at?}|null, sellerPubkey? }
 */
export function deriveOrder(rumors, { parsePayment = parsePaymentTags, redeemRecord = null, sellerPubkey = '' } = {}) {
  const sorted = [...new Map(rumors.map((r) => [r.id || `${r.pubkey}${r.created_at}${r.content}`, r])).values()].sort((a, b) => a.created_at - b.created_at);
  const info = sorted.find((r) => tagValue(r, 'subject') === SUBJECT.info);
  const itemTag = (info && tag(info, 'item')) || sorted.map((r) => tag(r, 'item')).find(Boolean);
  const listingRef = itemTag?.[1] || '';
  const seller = sellerPubkey || (/^30402:([0-9a-f]{64}):/.exec(listingRef)?.[1] ?? '');
  const buyer = info?.pubkey || '';
  const amount = Number(info && tagValue(info, 'amount')) || null;
  const orderId = (info && tagValue(info, 'order')) || '';
  const seenTokens = new Set();
  const payments = [];
  for (const r of sorted) {
    if (seller && r.pubkey === seller) continue; // only the buyer's rumors can carry payment
    let parsed = null; try { parsed = parsePayment(r); } catch { /* unreadable */ }
    if (!parsed?.token) continue;
    const duplicate = seenTokens.has(parsed.token); seenTokens.add(parsed.token);
    payments.push({ rumor: r, ...parsed, duplicate, at: r.created_at });
  }
  const bySeller = (subject, status) => sorted.find((r) => r.pubkey === seller && tagValue(r, 'subject') === subject && (!status || tagValue(r, 'status') === status));
  const receipt = seller ? bySeller(SUBJECT.receipt, 'confirmed') : null;
  const shipped = seller ? bySeller(SUBJECT.shipping, 'shipped') : null;
  const firstPay = payments.find((p) => !p.duplicate);
  const redeemFailed = redeemRecord?.state === 'failed' && !receipt;
  const steps = [
    { key: 'conversation', label: 'Private conversation opened', done: sorted.length > 0, at: sorted[0]?.created_at },
    { key: 'requested', label: 'Order requested', done: !!info, at: info?.created_at, detail: amount ? `${amount} sats` : '' },
    { key: 'ecash', label: 'Ecash sent by buyer', done: !!firstPay, at: firstPay?.at, detail: firstPay?.amount ? `${firstPay.amount} sats (unverified until redeemed)` : '' },
    { key: 'paid', label: 'Payment redeemed by seller', done: !!receipt, at: receipt?.created_at, error: redeemFailed ? redeemRecord.error || 'Redemption failed' : '' },
    { key: 'fulfilled', label: 'Order fulfilled', done: !!shipped, at: shipped?.created_at },
  ];
  const status = shipped ? 'fulfilled' : receipt ? 'paid' : redeemFailed ? 'payment problem' : firstPay ? 'payment sent, not yet redeemed' : info ? 'awaiting payment' : sorted.length ? 'chatting' : 'empty';
  return { orderId, listingRef, seller, buyer, amount, payments, steps, status, paid: !!receipt, fulfilled: !!shipped, redeemFailed };
}
