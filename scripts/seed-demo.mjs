#!/usr/bin/env node
/**
 * Seed the live market with a demo seller ("Caravan Goods") and demo listings.
 *
 *   node scripts/seed-demo.mjs                 run every step (idempotent, safe to re-run)
 *   node scripts/seed-demo.mjs --init          create key (once), kind 0 profile, Marmot key package, read-back check
 *   node scripts/seed-demo.mjs --images        generate missing product photos with `bl image generate` into docs/seed/
 *   node scripts/seed-demo.mjs --upload        upload photos to a Blossom server, record URLs in docs/seed/images.json
 *   node scripts/seed-demo.mjs --publish       publish kind 30402 listings, then re-query them
 *   node scripts/seed-demo.mjs --verify        only re-query profile, key package and listings
 *   node scripts/seed-demo.mjs --delete        NIP-09 deletion request for every demo listing (kind 5)
 *
 * Options: --listing-relays a,b  --marmot-relays a,b  --force (republish unchanged listings)
 *          --blossom https://...  (try this server first)
 *
 * The secret key lives only in .seller-demo.json (chmod 600, listed in .git/info/exclude). It is never printed.
 * Marmot state (the private key package material) is kept in .seller-demo-marmot/ so re-runs and the later
 * seller login reuse the same key package.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, appendFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { serialize, deserialize } from 'node:v8';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { createMarmot } from '../src/lib/marmot.js';
import { buildListingTemplate } from '../src/marketplace/listings.js';
import {
  newIdentity, identityFromSecret, publishWithAcks, uploadToBlossom, signerFor,
  SHOPSTR_RELAYS, BROADCAST_RELAYS, MARMOT_RELAYS, DEFAULT_BLOSSOM, FALLBACK_BLOSSOM,
} from '../src/lib/nostr.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_FILE = join(ROOT, '.seller-demo.json');
const MARMOT_DIR = join(ROOT, '.seller-demo-marmot');
const SEED_DIR = join(ROOT, 'docs', 'seed');
const IMAGES_JSON = join(SEED_DIR, 'images.json');
const D_PREFIX = 'caravan-demo-';
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const list = (value) => value?.split(',').map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ catalogue */
const PROFILE = {
  name: 'Caravan Goods',
  display_name: 'Caravan Goods',
  about: 'Demo storefront for SatsRoad Market: small-batch goods with a caravan-road flavour. Listings are tagged "demo" and exist to show how browsing, private Marmot chat and ecash payment work. Not a real shop.',
};
const STYLE = 'Professional e-commerce product photograph, centered subject, soft diffused studio lighting, seamless warm cream neutral backdrop, subtle soft shadow, square composition, photorealistic, no text, no logos, no people.';
export const PRODUCTS = [
  { slug: 'leather-saddlebag', title: 'Hand-stitched leather saddlebag', price: 165000, category: 'bags', ship: 9000, qty: 4, location: 'Marrakesh, Morocco',
    summary: 'Vegetable-tanned leather saddlebag with saddle-stitched seams and solid brass buckles. Fits a tablet, a water bottle and a day of road. Includes an adjustable crossbody strap.',
    prompt: 'a hand-stitched tan vegetable-tanned leather saddlebag with brass buckles and a crossbody strap' },
  { slug: 'coffee-beans', title: 'Small-batch roasted coffee beans, 500 g', price: 18000, category: 'food', ship: 4000, qty: 40, location: 'Addis Ababa, Ethiopia',
    summary: 'Medium-roast Yirgacheffe beans, roasted in small lots and packed in a resealable kraft bag. Notes of jasmine, lemon and honey. Whole bean, 500 g.',
    prompt: 'a kraft paper coffee bag with a blank label, next to a small wooden scoop of roasted coffee beans' },
  { slug: 'merino-scarf', title: 'Merino wool scarf, desert sand', price: 60000, category: 'clothing', ship: 5000, qty: 12, location: 'Queenstown, New Zealand',
    summary: 'Soft 100% merino wool scarf in a sand and ochre herringbone weave. 180 x 30 cm, light enough for travel and warm for cold desert nights.',
    prompt: 'a neatly folded merino wool scarf in sand and ochre herringbone weave with fringed ends' },
  { slug: 'steel-seed-plate', title: 'Stainless steel seed backup plate', price: 35000, category: 'hardware', ship: 4500, qty: 25, location: 'Zurich, Switzerland',
    summary: 'Fire- and corrosion-resistant 304 stainless steel plate with a grid of slots and loose letter tiles for stamping a recovery phrase by hand. Blank, ships without any keys or words. Keep your backup offline and private.',
    prompt: 'a rectangular brushed stainless steel plate with a grid of small empty square slots and a few loose blank metal tiles beside it' },
  { slug: 'ceramic-mug-set', title: 'Hand-thrown ceramic mug set (2)', price: 48000, category: 'home', ship: 7000, qty: 8, location: 'Lisbon, Portugal',
    summary: 'Two wheel-thrown stoneware mugs with a speckled sand glaze, each about 350 ml. Dishwasher and microwave safe. Every piece differs slightly.',
    prompt: 'two hand-thrown stoneware mugs with a speckled sand glaze, slightly irregular, side by side' },
  { slug: 'medjool-dates', title: 'Medjool dates gift box, 1 kg', price: 32000, category: 'food', ship: 6000, qty: 30, location: 'Jericho, Palestine',
    summary: 'Large, soft Medjool dates packed in a wooden gift box with a paper liner. 1 kg net, no added sugar. A traditional road-food for long journeys.',
    prompt: 'an open wooden gift box filled with plump medjool dates on parchment paper' },
  { slug: 'bound-notebook', title: 'Hand-bound travel notebook', price: 22000, category: 'stationery', ship: 3000, qty: 20, location: 'Fez, Morocco',
    summary: 'A5 notebook with 160 pages of cream paper, sewn signatures and a leather cover with a wrap strap. Lies flat. Made to be carried and filled.',
    prompt: 'a hand-bound A5 notebook with brown leather cover and a leather wrap strap, closed, slightly angled' },
  { slug: 'spice-sampler', title: 'Caravan spice sampler, 6 jars', price: 26000, category: 'food', ship: 4000, qty: 25, location: 'Muscat, Oman',
    summary: 'Six small jars: cumin, coriander, sumac, cardamom, turmeric and smoked paprika. Whole or freshly ground as marked on each jar. 30 g each.',
    prompt: 'six small glass spice jars with cork lids filled with colorful spices, arranged in two rows of three (exactly six jars), blank labels' },
  { slug: 'brass-compass', title: 'Brass pocket compass', price: 45000, category: 'outdoors', ship: 3500, qty: 15, location: 'Istanbul, Turkey',
    summary: 'Solid brass pocket compass with a hinged lid and a liquid-damped needle. 55 mm across, engraved bezel with cardinal marks. Ships in a cloth pouch.',
    prompt: 'an open antique-style solid brass pocket compass with a hinged lid, white dial, engraved bezel' },
  { slug: 'cotton-keffiyeh', title: 'Cotton keffiyeh scarf', price: 28000, category: 'clothing', ship: 4000, qty: 18, location: 'Hebron, Palestine',
    summary: 'Woven cotton keffiyeh in a classic black and white houndstooth pattern with twisted tassels. 110 x 110 cm. Useful as a sun, dust and wind wrap.',
    prompt: 'a neatly folded woven cotton keffiyeh scarf in black and white houndstooth pattern with twisted tassels' },
];
const AVATAR_PROMPT = 'Flat vector style emblem of a camel caravan silhouette crossing sand dunes at dusk, warm sand and deep green palette, simple circular badge composition, centered, no text, no letters';

/* ------------------------------------------------------------------ helpers */
const log = (...a) => console.log(...a);
function exclude() {
  const f = join(ROOT, '.git', 'info', 'exclude');
  const current = existsSync(f) ? readFileSync(f, 'utf8') : '';
  const add = ['.seller-demo.json', '.seller-demo-marmot/'].filter((l) => !current.split('\n').includes(l));
  if (add.length) appendFileSync(f, `${current.endsWith('\n') || !current ? '' : '\n'}${add.join('\n')}\n`);
}
function loadSeller() {
  if (!existsSync(KEY_FILE)) {
    const id = newIdentity();
    writeFileSync(KEY_FILE, JSON.stringify({ nsec: id.nsec, npub: id.npub, pubkey: id.pubkey, created: new Date().toISOString() }, null, 2), { mode: 0o600 });
    log(`created new seller identity: ${id.npub} (secret stored in .seller-demo.json)`);
  }
  chmodSync(KEY_FILE, 0o600); exclude();
  return identityFromSecret(JSON.parse(readFileSync(KEY_FILE, 'utf8')).nsec);
}
/** File-backed key-value store with the same shape as localforage; v8 serialization keeps Uint8Array/Map/BigInt intact. */
function fileStoreFactory(pubkey, name) {
  mkdirSync(MARMOT_DIR, { recursive: true });
  const file = join(MARMOT_DIR, `${pubkey.slice(0, 16)}-${name}.bin`);
  let map = existsSync(file) ? deserialize(readFileSync(file)) : new Map();
  const save = () => writeFileSync(file, serialize(map), { mode: 0o600 });
  return {
    async getItem(k) { return map.has(k) ? map.get(k) : null; },
    async setItem(k, v) { map.set(k, v); save(); return v; },
    async removeItem(k) { map.delete(k); save(); },
    async clear() { map = new Map(); save(); },
    async keys() { return [...map.keys()]; },
  };
}
function relays() {
  let listing = list(opt('listing-relays')) || [...SHOPSTR_RELAYS, ...BROADCAST_RELAYS];
  const marmot = list(opt('marmot-relays')) || [...MARMOT_RELAYS];
  return { listing, marmot, all: [...new Set([...listing, ...marmot])] };
}
const summarizeAcks = (acks) => acks.map((a) => `${a.ok ? 'ACK ' : 'FAIL'} ${a.relay}${a.ok ? '' : ` (${a.message.slice(0, 80)})`}`).join('\n    ');
const normRelay = (u) => u.replace(/\/$/, '');

/* ------------------------------------------------------------------ steps */
async function init(seller, pool, R) {
  log('\n== init: profile + Marmot key package ==');
  const profile = { ...PROFILE };
  const images = existsSync(IMAGES_JSON) ? JSON.parse(readFileSync(IMAGES_JSON, 'utf8')) : {};
  if (images.avatar?.url) profile.picture = images.avatar.url;
  const event = finalizeEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(profile) }, seller.sk);
  const acks = await publishWithAcks(pool, R.all, event, 10000);
  log(`kind 0 profile (${profile.picture ? 'with picture' : 'NO picture yet, run --images --upload then --init again'}):\n    ${summarizeAcks(acks)}`);

  const marmot = await createMarmot({ privateKey: seller.sk, relays: R.marmot, storeFactory: fileStoreFactory });
  try {
    const out = await marmot.publishKeyPackage();
    const fmt = (r) => Object.values(r || {}).map((x) => `${x.ok ? 'ACK ' : 'FAIL'} ${x.from}${x.ok ? '' : ` (${String(x.message).slice(0, 80)})`}`).join('\n    ');
    log(`kind 30443 key package ${out.keyPackage.id?.slice(0, 12)}:\n    ${fmt(out.keyPackage.results)}`);
    log(`kind 10050 inbox relay list:\n    ${fmt(out.relayLists.inbox)}`);
    log(`kind 10002 relay list:\n    ${fmt(out.relayLists.nip65)}`);
    if (!out.ok) throw new Error('No relay acknowledged the key package.');
  } finally { marmot.stop(); }
  await sleep(1500);
  await verifyMarmot(seller, R);
}

async function verifyMarmot(seller, R) {
  const pool = new SimplePool();
  try {
    const found = {};
    for (const relay of R.marmot) {
      const evs = await pool.querySync([relay], { kinds: [0, 10002, 10050, 30443], authors: [seller.pubkey] }, { maxWait: 6000 }).catch(() => []);
      found[relay] = [...new Set(evs.map((e) => e.kind))].sort((a, b) => a - b);
    }
    log('read-back (kinds per marmot relay):');
    for (const [r, k] of Object.entries(found)) log(`    ${r}: ${k.join(',') || 'nothing'}`);
    const kp = Object.values(found).some((k) => k.includes(30443));
    const lists = Object.values(found).some((k) => k.includes(10050) && k.includes(10002));
    log(`key package fetchable: ${kp ? 'YES' : 'NO'}; relay lists fetchable: ${lists ? 'YES' : 'NO'}`);
    if (!kp) process.exitCode = 1;
    return kp;
  } finally { pool.destroy(); }
}

function genImages() {
  log('\n== images: bl image generate ==');
  mkdirSync(SEED_DIR, { recursive: true });
  const jobs = [...PRODUCTS.map((p) => ({ slug: p.slug, prompt: `${STYLE} Subject: ${p.prompt}.` })), { slug: 'avatar', prompt: AVATAR_PROMPT }];
  for (const job of jobs) {
    const jpg = join(SEED_DIR, `${job.slug}.jpg`);
    if (existsSync(jpg) && !flag('force')) { log(`  have ${job.slug}.jpg`); continue; }
    const png = join(SEED_DIR, `${job.slug}.png`);
    if (!existsSync(png)) {
      log(`  generating ${job.slug}`);
      execFileSync('bl', ['image', 'generate', '--prompt', job.prompt, '--size', '1024*1024', '--watermark', 'false', '--out-dir', SEED_DIR, '--out-prefix', job.slug], { stdio: ['ignore', 'ignore', 'inherit'] });
      if (!existsSync(png)) { // the CLI may add a suffix
        const found = readdirSync(SEED_DIR).find((f) => f.startsWith(job.slug) && f.endsWith('.png'));
        if (found) execFileSync('mv', [join(SEED_DIR, found), png]);
      }
    }
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', png, '--out', jpg], { stdio: 'ignore' });
    unlinkSync(png);
  }
}

async function checkImage(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const type = res.headers.get('content-type') || '';
    const buf = res.ok ? await res.arrayBuffer() : null;
    return { ok: res.status === 200 && type.startsWith('image/') && buf.byteLength > 1000, status: res.status, type, bytes: buf?.byteLength };
  } catch (e) { return { ok: false, status: 0, type: '', error: e.message }; }
}

async function upload(seller) {
  log('\n== upload: Blossom ==');
  const known = existsSync(IMAGES_JSON) ? JSON.parse(readFileSync(IMAGES_JSON, 'utf8')) : {};
  const servers = [opt('blossom'), 'https://blossom.primal.net', 'https://cdn.satellite.earth', 'https://blossom.nostr.build', DEFAULT_BLOSSOM, ...FALLBACK_BLOSSOM].filter(Boolean);
  const signer = signerFor(seller);
  let preferred = [...new Set(servers)];
  for (const slug of [...PRODUCTS.map((p) => p.slug), 'avatar']) {
    const file = join(SEED_DIR, `${slug}.jpg`);
    if (!existsSync(file)) throw new Error(`Missing ${file}. Run --images first.`);
    if (known[slug]?.url && !flag('force')) {
      const chk = await checkImage(known[slug].url);
      if (chk.ok) { log(`  ok    ${slug}: ${known[slug].url}`); continue; }
      log(`  stale ${slug}: re-uploading (${chk.status})`);
    }
    const bytes = readFileSync(file);
    let done = false;
    for (const server of preferred) {
      try {
        const out = await uploadToBlossom({ server, file: new File([bytes], `${slug}.jpg`, { type: 'image/jpeg' }), signer });
        const chk = await checkImage(out.url);
        if (!chk.ok) throw new Error(`uploaded URL does not load: HTTP ${chk.status} ${chk.type}`);
        known[slug] = { url: out.url, sha256: out.sha256, server, type: chk.type, bytes: chk.bytes };
        writeFileSync(IMAGES_JSON, JSON.stringify(known, null, 2));
        log(`  up    ${slug}: ${out.url} [${server}]`);
        preferred = [server, ...preferred.filter((s) => s !== server)]; // stick with a server that works
        done = true; break;
      } catch (e) { log(`  fail  ${slug} on ${server}: ${String(e.message).slice(0, 160)}`); }
    }
    if (!done) throw new Error(`No Blossom server accepted ${slug}.jpg`);
  }
}

const tagVal = (ev, name) => ev.tags.find((t) => t[0] === name)?.[1];
const comparable = (ev) => JSON.stringify(ev.tags.filter((t) => t[0] !== 'published_at').sort());

function buildEvent(seller, product, image, now, publishedAt) {
  const template = buildListingTemplate({
    id: `${D_PREFIX}${product.slug}`, title: product.title, description: product.summary, price: product.price,
    image, category: product.category, location: product.location, legal: true,
  }, publishedAt || now);
  // Extra Shopstr tags the in-app form does not yet produce: demo marker, quantity, condition, shipping.
  template.tags.push(['t', 'demo'], ['quantity', String(product.qty)], ['condition', 'New'], ['shipping', 'Added Cost', String(product.ship), 'SAT']);
  template.created_at = now;
  return finalizeEvent(template, seller.sk);
}

async function fetchOwn(pool, urls, seller, extra = {}) {
  return pool.querySync(urls, { kinds: [30402], authors: [seller.pubkey], ...extra }, { maxWait: 8000 }).catch(() => []);
}

async function publish(seller, pool, R) {
  log('\n== publish: kind 30402 listings ==');
  const images = JSON.parse(readFileSync(IMAGES_JSON, 'utf8'));
  const existing = new Map();
  for (const ev of await fetchOwn(pool, R.listing, seller)) {
    const d = tagVal(ev, 'd'); const prev = existing.get(d);
    if (d?.startsWith(D_PREFIX) && (!prev || ev.created_at > prev.created_at)) existing.set(d, ev);
  }
  const now = Math.floor(Date.now() / 1000);
  const relayStats = {}; let published = 0, skipped = 0;
  for (const product of PRODUCTS) {
    const d = `${D_PREFIX}${product.slug}`;
    if (!images[product.slug]?.url) throw new Error(`No uploaded image for ${product.slug}`);
    const prev = existing.get(d);
    const draft = buildEvent(seller, product, images[product.slug].url, now, prev ? Number(tagVal(prev, 'published_at')) || prev.created_at : now);
    if (prev && comparable(prev) === comparable(draft) && !flag('force')) { skipped++; log(`  same   ${product.slug} (unchanged, skipped)`); continue; }
    const acks = await publishWithAcks(pool, R.listing, draft, 10000);
    for (const a of acks) { const s = relayStats[a.relay] ||= { ok: 0, fail: 0, last: '' }; a.ok ? s.ok++ : (s.fail++, s.last = a.message); }
    if (!acks.some((a) => a.ok)) throw new Error(`All relays rejected ${product.slug}: ${summarizeAcks(acks)}`);
    await sleep(700); published++; log(`  sent   ${product.slug}: ${acks.filter((a) => a.ok).length}/${acks.length} relays ACK`);
  }
  log(`published ${published}, unchanged ${skipped}`);
  for (const [relay, s] of Object.entries(relayStats)) log(`    ${relay}: ${s.ok} ACK, ${s.fail} failed${s.last ? ` (${s.last.slice(0, 80)})` : ''}`);
  await sleep(2500);
  await verifyListings(seller, pool, R);
}

async function verifyListings(seller, pool, R) {
  log('\n== verify: listings per relay ==');
  const readRelays = R.listing.filter((r) => !BROADCAST_RELAYS.map(normRelay).includes(normRelay(r)));
  let best = 0;
  for (const relay of readRelays) {
    const evs = (await fetchOwn(pool, [relay], seller, { '#t': ['shopstr'] })).filter((e) => tagVal(e, 'd')?.startsWith(D_PREFIX));
    const ds = new Set(evs.map((e) => tagVal(e, 'd')));
    const withImg = evs.filter((e) => tagVal(e, 'image')).length;
    best = Math.max(best, ds.size);
    log(`    ${relay}: ${ds.size}/${PRODUCTS.length} listings (${withImg} with image)`);
  }
  if (best < PRODUCTS.length) { log(`WARNING: no single relay returned all ${PRODUCTS.length} listings`); process.exitCode = 1; }
}

async function remove(seller, pool, R) {
  log('\n== delete: NIP-09 ==');
  const now = Math.floor(Date.now() / 1000);
  const aTags = PRODUCTS.map((p) => ['a', `30402:${seller.pubkey}:${D_PREFIX}${p.slug}`]);
  const found = (await fetchOwn(pool, R.listing, seller)).filter((e) => tagVal(e, 'd')?.startsWith(D_PREFIX));
  const eTags = [...new Map(found.map((e) => [e.id, ['e', e.id]])).values()];
  const ev = finalizeEvent({ kind: 5, created_at: now, tags: [...aTags, ...eTags, ['k', '30402']], content: 'Demo listings removed' }, seller.sk);
  const acks = await publishWithAcks(pool, R.all, ev, 10000);
  log(`kind 5 deletion request (${aTags.length} addresses, ${eTags.length} event ids):\n    ${summarizeAcks(acks)}`);
  log('Relays that honour NIP-09 stop serving the listings; the app also hides listings deleted this way only if the relay does.');
}

/** Read-only: list pending Marmot invites for the seller (does not accept, so the key package is not rotated). */
async function invites(seller, R) {
  log('\n== invites (read-only) ==');
  const marmot = await createMarmot({ privateKey: seller.sk, relays: R.marmot, storeFactory: fileStoreFactory });
  try {
    await marmot.start(); await sleep(8000);
    const list = await marmot.listInvites();
    log(`pending invites: ${list.length}`);
    for (const i of list) log(`    from ${nip19.npubEncode(i.from).slice(0, 16)}... joinable=${i.joinable} group="${i.group?.name}" listingRef=${i.group?.listingRef}`);
  } finally { marmot.stop(); }
}

/* ------------------------------------------------------------------ main */
const steps = ['init', 'images', 'upload', 'publish', 'verify', 'delete', 'invites'].filter(flag);
const all = steps.length === 0;
const on = (s) => all ? !['delete', 'verify', 'invites'].includes(s) : steps.includes(s);

const seller = loadSeller();
const R = relays();
log(`seller ${seller.npub}`);
log(`listing relays: ${R.listing.join(' ')}`);
log(`marmot relays:  ${R.marmot.join(' ')}`);
const pool = new SimplePool();
try {
  // Images first when running everything, so the profile gets its picture.
  if (on('images')) genImages();
  if (on('upload')) await upload(seller);
  if (on('init')) await init(seller, pool, R);
  if (on('publish')) await publish(seller, pool, R);
  if (flag('verify')) { await verifyMarmot(seller, R); await verifyListings(seller, pool, R); }
  if (flag('invites')) await invites(seller, R);
  if (flag('delete')) await remove(seller, pool, R);
} finally { pool.destroy(); }
process.exit(process.exitCode || 0);
