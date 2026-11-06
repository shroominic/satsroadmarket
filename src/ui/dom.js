/** Tiny DOM helpers. All text goes through textContent / text nodes: nothing from relays is ever parsed as HTML. */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value == null) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && key !== 'list' && key !== 'form') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) el.append(child.nodeType ? child : document.createTextNode(String(child)));
  return el;
}
/** replaceChildren that never renders null/false/undefined as the text "null". */
export const setKids = (el, ...kids) => { el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return el; };
export const clear = (el) => { el.replaceChildren(); return el; };
export function ago(ts, now = Date.now() / 1000) {
  const s = Math.max(0, Math.round(now - ts));
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`; return `${Math.floor(s / 86400)} d ago`;
}
export const sats = (n) => `${Number(n).toLocaleString('en-US')} sats`;
/** A visible, honest status line. kind: info | ok | warn | error */
export function notice(kind, text, ...actions) { return h('div', { class: `notice notice-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, h('span', { class: 'notice-text' }, text), ...actions); }
export function button(label, onClick, { cls = '', title = '', disabled = false } = {}) {
  return h('button', { type: 'button', class: `btn ${cls}`.trim(), title, disabled, onClick }, label);
}
/** Runs async work with the button disabled; returns the result or rethrows after resetting. */
export async function busy(btn, label, work) {
  const original = btn.textContent; btn.disabled = true; if (label) btn.textContent = label;
  try { return await work(); } finally { btn.disabled = false; btn.textContent = original; }
}
export async function copyText(text) { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } }

/** Run `build` only when `sig` differs from the last call for this element. Returns true when it rebuilt. Stops background updates from tearing down unchanged DOM. */
export function keep(el, sig, build) { if (el.__sig === sig) return false; el.__sig = sig; build(); return true; }
/** Keyed child reconciliation: make `parent`'s children exactly `nodes` (in order) touching the DOM only where something moved, was added or removed. */
export function reconcile(parent, nodes) {
  const want = new Set(nodes);
  for (let k = parent.firstChild; k;) { const next = k.nextSibling; if (!want.has(k)) parent.removeChild(k); k = next; } // drop stale nodes first
  let ref = parent.firstChild;
  for (const node of nodes) { if (ref === node) ref = ref.nextSibling; else parent.insertBefore(node, ref); }
}
