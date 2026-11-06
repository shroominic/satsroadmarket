/**
 * Client-side keyword filter (DECISIONS D5). It is a convenience layer on the viewer's own screen,
 * not moderation of the network: events remain on relays. Relay operators are responsible for filtering.
 */
export const DEFAULT_BLOCKED = [
  // hard drugs and precursors
  'cocaine', 'crack cocaine', 'heroin', 'fentanyl', 'methamphetamine', 'crystal meth', 'meth', 'mdma', 'ecstasy', 'lsd',
  'ketamine', 'oxycodone', 'xanax', 'adderall', 'opium', 'psilocybin', 'magic mushrooms', 'ayahuasca', 'dmt', 'pcp', 'amphetamine',
  'marijuana', 'cannabis', 'weed', 'hashish', 'darknet drugs',
  // weapons and violence
  'ghost gun', 'untraceable gun', 'machine gun', 'full auto conversion', 'auto sear', 'explosives', 'bomb making', 'hitman', 'murder for hire', 'assassin for hire',
  // fraud, stolen data, forged documents
  'counterfeit', 'counterfeit money', 'fake money', 'fake id', 'fake passport', 'forged passport', 'forged documents', 'fake diploma',
  'stolen', 'carded', 'cvv', 'fullz', 'credit card dump', 'credit card dumps', 'stolen credit cards', 'ransomware', 'malware', 'botnet', 'ddos for hire', 'hacked accounts',
  // exploitation
  'child porn', 'csam', 'human trafficking', 'sex slave', 'organ for sale', 'ivory', 'rhino horn',
];
/** Phrases that contain a blocked word but are ordinary goods. */
export const ALLOWED_PHRASES = ['weed killer', 'weed whacker', 'weed eater', 'weed barrier', 'weed control', 'weed puller', 'meth lab detector', 'stolen valor'];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
/** Lowercase, strip accents, undo simple obfuscation (c0caine, c.o.c.a.i.n.e), collapse whitespace. */
export function normalizeText(input) {
  return String(input || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[0134578@$!]/g, (ch) => LEET[ch])
    .replace(/\b(?:[a-z][\s.\-_*]){3,}[a-z]\b/g, (m) => m.replace(/[\s.\-_*]/g, ''))
    .replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compile = (words) => words.map((w) => normalizeText(w)).filter(Boolean).map((w) => ({ word: w, re: new RegExp(`(?:^| )${escapeRe(w)}(?:s|es)?(?= |$)`) }));
let cache = { key: '', rules: [] };
function rulesFor(words) { const key = words.join('\u0000'); if (cache.key !== key) cache = { key, rules: compile(words) }; return cache.rules; }

/** Returns the first blocked keyword found in text, or null. */
export function findBlocked(text, words = DEFAULT_BLOCKED) {
  let haystack = ` ${normalizeText(text)} `.trim();
  for (const phrase of ALLOWED_PHRASES) haystack = haystack.split(normalizeText(phrase)).join(' ');
  haystack = haystack.replace(/\s+/g, ' ');
  for (const rule of rulesFor(words)) if (rule.re.test(haystack)) return rule.word;
  return null;
}
/** Checks title, summary/description, tags and location of a parsed listing. */
export function listingBlockReason(listing, words = DEFAULT_BLOCKED) {
  const fields = [listing.title, listing.description, listing.summary, listing.location, ...(listing.tags || [])];
  for (const field of fields) { const hit = findBlocked(field, words); if (hit) return hit; }
  return null;
}
export const filterListings = (listings, words = DEFAULT_BLOCKED) => {
  const shown = []; let hidden = 0;
  for (const listing of listings) (listingBlockReason(listing, words) ? hidden++ : shown.push(listing));
  return { shown, hidden };
};
