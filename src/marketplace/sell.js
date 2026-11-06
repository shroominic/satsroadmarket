import { buildListingTemplate, publishListing } from './listings.js';
import { findBlocked } from '../lib/filter.js';
import { DEFAULT_BLOSSOM, FALLBACK_BLOSSOM, storage, uploadToBlossom } from '../lib/nostr.js';
import { h, notice, button, busy } from '../ui/dom.js';
import { listingImage } from './view.js';
import { CURRENCIES } from '../lib/money.js';

export function mountSell(root, app) {
  if (!app.identity) {
    root.replaceChildren(notice('warn', 'You need an identity to publish. It is a Nostr key that lives in this browser.'), h('p', {}, h('a', { class: 'btn btn-primary', href: '#/identity' }, 'Create or import an identity')));
    return () => {};
  }
  const formStatus = h('div', { class: 'status-slot' });
  const ackList = h('ul', { class: 'acks' });
  const uploadStatus = h('div', { class: 'status-slot' });
  const preview = h('div', { class: 'upload-preview' });
  const f = {
    title: h('input', { name: 'title', required: true, maxLength: 120, autocomplete: 'off' }),
    summary: h('textarea', { name: 'summary', required: true, maxLength: 4000, rows: 5 }),
    price: h('input', { name: 'price', type: 'number', min: 0.01, step: 'any', required: true, inputMode: 'decimal' }),
    image: h('input', { name: 'image', type: 'url', placeholder: 'https://…  (or upload below)', autocomplete: 'off' }),
    currency: (() => { const sel = h('select', { name: 'currency', 'aria-label': 'Price currency' }, ...['SAT', 'USD', 'EUR', 'GBP', 'KRW', 'JPY', 'BTC', ...Object.keys(CURRENCIES).filter((c) => !['SAT', 'SATS', 'USD', 'EUR', 'GBP', 'KRW', 'JPY'].includes(c))].map((c) => h('option', { value: c }, c === 'SAT' ? 'sats' : c))); return sel; })(),
    category: h('input', { name: 'category', maxLength: 60 }),
    location: h('input', { name: 'location', maxLength: 120 }),
    file: h('input', { type: 'file', accept: 'image/*' }),
    blossom: h('input', { type: 'url', value: storage.get('sr.blossom') || DEFAULT_BLOSSOM, 'aria-label': 'Blossom server' }),
    legal: h('input', { type: 'checkbox', name: 'legal', required: true, id: 'legal-ack' }),
  };
  f.blossom.defaultValue = f.blossom.value;
  const field = (label, control, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);

  const uploadBtn = button('Upload to Blossom', async () => {
    uploadStatus.replaceChildren();
    try {
      const file = f.file.files?.[0];
      storage.set('sr.blossom', f.blossom.value.trim());
      uploadStatus.replaceChildren(notice('info', 'Uploading…'));
      const out = await busy(uploadBtn, 'Uploading…', () => uploadToBlossom({ server: f.blossom.value.trim(), file, signer: app.signer }));
      f.image.value = out.url;
      uploadStatus.replaceChildren(notice('ok', `Uploaded. Image URL filled in (sha256 ${out.sha256.slice(0, 12)}…).`));
      preview.replaceChildren(listingImage({ image: out.url, title: 'Uploaded image' }, 'thumb'));
    } catch (error) {
      const alt = [DEFAULT_BLOSSOM, ...FALLBACK_BLOSSOM].filter((u) => u !== f.blossom.value.trim().replace(/\/+$/, ''));
      uploadStatus.replaceChildren(notice('error', `Image upload failed: ${error.message} You can paste an image URL instead, or try another Blossom server.`,
        ...alt.slice(0, 2).map((u) => button(`Use ${u.replace('https://', '')}`, () => { f.blossom.value = u; storage.set('sr.blossom', u); uploadBtn.click(); }, { cls: 'btn-small' }))));
    }
  }, { cls: 'btn-small' });
  f.image.addEventListener('change', () => { preview.replaceChildren(f.image.value ? listingImage({ image: f.image.value, title: 'Preview' }, 'thumb') : ''); });

  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Sign and publish to relays');
  const form = h('form', { class: 'form', onSubmit: async (event) => {
    event.preventDefault(); ackList.replaceChildren(); formStatus.replaceChildren();
    const input = { title: f.title.value, description: f.summary.value, price: f.price.value, currency: f.currency.value, image: f.image.value, category: f.category.value, location: f.location.value, legal: f.legal.checked };
    const blocked = findBlocked(`${input.title} ${input.description} ${input.category}`, app.publishBlocked || app.blocked);
    if (blocked) { formStatus.replaceChildren(notice('error', `Not published: the text matches the NSFW keyword “${blocked}”. Only legal goods may be listed.`)); return; }
    try { buildListingTemplate(input); } catch (error) { formStatus.replaceChildren(notice('error', error.message)); return; }
    const live = app.relayList();
    formStatus.replaceChildren(notice('info', `Signing and sending to ${live.length} relay(s)…`));
    try {
      await busy(submit, 'Publishing…', () => publishListing({ input, signer: app.signer, pool: app.pool, relays: live, onAck: (acks) => {
        ackList.replaceChildren(...acks.map((a) => h('li', { class: a.ok ? 'ack-ok' : 'ack-bad' }, h('b', {}, a.ok ? 'ACK ' : 'REJECTED '), h('span', { class: 'mono' }, a.relay), ' — ', a.message)));
      } }));
      formStatus.replaceChildren(notice('ok', 'Published: at least one relay acknowledged the listing. See the per-relay answers below.', h('a', { class: 'btn btn-small', href: '#/market' }, 'View market')));
      form.reset(); preview.replaceChildren();
      app.refreshListings();
    } catch (error) { formStatus.replaceChildren(notice('error', `Not published: ${error.message}`, button('Retry', () => form.requestSubmit(), { cls: 'btn-small' }))); }
  } },
    field('Title', f.title), field('Summary', f.summary, 'Shown as the listing description (NIP-99 content and summary tag).'),
    h('div', { class: 'row' }, field('Price', h('span', { class: 'row-inline' }, f.price, f.currency)), field('Category (optional)', f.category), field('Location (optional)', f.location)),
    field('Image URL', f.image, 'Optional. Missing or broken images show a placeholder.'),
    h('fieldset', { class: 'upload' }, h('legend', {}, 'Or upload an image (Blossom, BUD-02)'),
      field('Blossom server', f.blossom, 'The file is signed with a kind 24242 authorization event from your key.'),
      h('div', { class: 'row-inline' }, f.file, uploadBtn), uploadStatus, preview),
    h('label', { class: 'ack', for: 'legal-ack' }, f.legal, h('span', {}, ' I confirm this listing is for legal goods only. I understand that relay providers are responsible for filtering listings.')),
    h('div', { class: 'actions' }, submit), formStatus, ackList);
  root.replaceChildren(h('p', { class: 'lead' }, 'Publish a Shopstr-compatible NIP-99 listing (kind 30402). It is public.'), form);
  return () => {};
}
