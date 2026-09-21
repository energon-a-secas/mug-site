// ── Shared utilities ─────────────────────────────────────────
// Small, pure helpers used across the pages.

/** Escape for HTML text and attribute values, quotes included: record data is never trusted. */
export function escHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** An href that can only be http(s), or '#'. A javascript: URL from a record never reaches an attribute. */
export function safeHref(url) {
  try {
    const parsed = new URL(String(url), location.origin);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : '#';
  } catch {
    return '#';
  }
}

/** The bare key of a query string, vitrina's /u/?handle convention: `/mug/?pikachu-3d-mug&theme=matrix` gives "pikachu-3d-mug". */
export function bareParam(search) {
  const skip = new Set(['theme', 'header', 'convex', 'devtoken']);
  for (const part of String(search || '').replace(/^\?/, '').split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq >= 0) continue;
    const key = decodeURIComponent(part.replace(/\+/g, ' ')).trim();
    if (key && !skip.has(key)) return key;
  }
  return '';
}

const OZ = 29.5735;

export function formatCapacity(ml, units = 'ml') {
  if (!ml) return '';
  if (units === 'oz') return `${Math.round(ml / OZ)} oz`;
  return ml >= 1000 ? `${(ml / 1000).toFixed(ml % 1000 ? 2 : 1).replace(/\.?0+$/, '')} L` : `${ml} ml`;
}

export function formatPrice(price) {
  if (!price || !price.amount) return '';
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: price.currency }).format(price.amount);
  } catch {
    return `${price.amount} ${price.currency}`;
  }
}

export function plural(n, one, many = `${one}s`) {
  return `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
}

export function timeAgo(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} days ago`;
  return new Date(ms).toLocaleDateString('en', { year: 'numeric', month: 'short' });
}

let toastTimer = null;
export function showToast(message, kind = 'info') {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.dataset.kind = kind;
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), kind === 'error' ? 5000 : 2600);
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}
