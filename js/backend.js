// ── Where the page finds its backend ─────────────────────────────────────────
//
// Two halves, vitrina's split (projects/vitrina-site/js/backend.js). The pure
// half reads what the page declares and names every Convex function a browser
// may call, in one place: tests/backend-contract.test.mjs reads convex/*.ts and
// fails when FN and the exports disagree. The impure half loads the Convex
// client by dynamic import, so importing this file fetches nothing.

/** A Convex cloud deployment URL, and nothing else. */
export const CONVEX_URL_RE = /^https:\/\/[a-z0-9-]+\.convex\.cloud$/;

/** A local deployment, accepted only when the page itself is served from this machine. */
export const DEV_URL_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}$/;

export const FN = Object.freeze({
  catalog: Object.freeze({ list: 'catalog:list', get: 'catalog:get', facets: 'catalog:facets', brand: 'catalog:brand' }),
  community: Object.freeze({ overview: 'community:overview' }),
  shelf: Object.freeze({ mine: 'shelf:mine', set: 'shelf:set', update: 'shelf:update' }),
  profiles: Object.freeze({
    claimHandle: 'profiles:claimHandle',
    update: 'profiles:update',
    setPublished: 'profiles:setPublished',
    byHandle: 'profiles:byHandle',
    deleteMyData: 'profiles:deleteMyData',
  }),
  photos: Object.freeze({ uploadUrl: 'photos:uploadUrl', add: 'photos:add', remove: 'photos:remove' }),
  admin: Object.freeze({ whoami: 'admin:whoami', dashboard: 'admin:dashboard' }),
  sources: Object.freeze({ list: 'sources:list', save: 'sources:save', remove: 'sources:remove', probe: 'sources:probe' }),
  runs: Object.freeze({ list: 'runs:list', start: 'runs:start', cancel: 'runs:cancel' }),
  staging: Object.freeze({
    list: 'staging:list',
    approve: 'staging:approve',
    merge: 'staging:merge',
    reject: 'staging:reject',
    bulkApprove: 'staging:bulkApprove',
    retry: 'staging:retry',
  }),
  importer: Object.freeze({ fromUrl: 'importer:fromUrl', fromPaste: 'importer:fromPaste', manual: 'importer:manual' }),
  mugs: Object.freeze({ adminList: 'mugs:adminList', adminGet: 'mugs:adminGet', save: 'mugs:save', pick: 'mugs:pick' }),
  images: Object.freeze({
    uploadUrl: 'images:uploadUrl',
    attachThumb: 'images:attachThumb',
    addOriginal: 'images:addOriginal',
    retry: 'images:retry',
    thumbsQueue: 'images:thumbsQueue',
  }),
  moderation: Object.freeze({ pendingPhotos: 'moderation:pendingPhotos', reviewPhoto: 'moderation:reviewPhoto', suspend: 'moderation:suspend' }),
  runnerTokens: Object.freeze({ list: 'runnerTokens:list', create: 'runnerTokens:create', revoke: 'runnerTokens:revoke' }),
});

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalHost(loc) {
  return !!loc && LOCAL_HOSTS.has(loc.hostname);
}

function meta(doc, name) {
  if (!doc || typeof doc.querySelector !== 'function') return null;
  return doc.querySelector(`meta[name="${name}"]`);
}

/**
 * The deployment this page talks to, or null when none is configured.
 *
 * On localhost only, `?convex=<url>` points the page at a dev deployment and
 * remembers it in storage; `?convex=` with no value forgets it. A malformed
 * meta throws: read as "no backend", a typo would quietly run a signed-in
 * visitor against nothing.
 */
export function convexUrlFor(doc, loc, storage) {
  if (isLocalHost(loc)) {
    const params = new URLSearchParams(loc.search || '');
    if (params.has('convex')) {
      const asked = params.get('convex') || '';
      if (!asked) storage?.removeItem('mug:convex');
      else if (DEV_URL_RE.test(asked) || CONVEX_URL_RE.test(asked)) storage?.setItem('mug:convex', asked);
    }
    const dev = storage?.getItem('mug:convex');
    if (dev && (DEV_URL_RE.test(dev) || CONVEX_URL_RE.test(dev))) return dev;
  }
  const tag = meta(doc, 'neo-convex-url');
  const url = tag ? (tag.getAttribute('content') || '').trim() : '';
  if (!url) return null;
  if (!CONVEX_URL_RE.test(url)) throw new Error(`neo-convex-url must be a Convex cloud URL, not ${JSON.stringify(url.slice(0, 80))}`);
  return url;
}

/** The Clerk key the page declares for the Auth Kit, or null. */
export function clerkKeyFrom(doc) {
  const tag = meta(doc, 'clerk-publishable-key');
  const key = tag ? (tag.getAttribute('content') || '').trim() : '';
  return /^pk_(test|live)_\S+$/.test(key) ? key : null;
}

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function decodePart(part) {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
}

/**
 * Dev sign-in (docs/CONTRACTS.md C9, A4), localhost only: `?devtoken=<jwt>`
 * from `node scripts/dev-auth.mjs token` is kept for the tab; `?devtoken=`
 * forgets it. Only a deployment with MUG_DEV_JWKS accepts it; production refuses it.
 */
export function devTokenFor(loc, storage, now = Date.now()) {
  if (!isLocalHost(loc)) return null;
  const params = new URLSearchParams(loc.search || '');
  if (params.has('devtoken')) {
    const asked = params.get('devtoken') || '';
    if (!asked) storage?.removeItem('mug:dev-token');
    else if (JWT_RE.test(asked)) storage?.setItem('mug:dev-token', asked);
  }
  const token = storage?.getItem('mug:dev-token');
  if (!token || !JWT_RE.test(token)) return null;
  try {
    const claims = decodePart(token.split('.')[1]);
    if (!claims.sub || !claims.exp || claims.exp * 1000 <= now) return null;
    return { token, subject: String(claims.sub), name: claims.name ? String(claims.name) : null };
  } catch {
    return null;
  }
}

/** A ConvexHttpClient for url, from the pinned jsDelivr build; the URL is checked again because it decides where a token goes. */
export async function loadClient(url) {
  if (!CONVEX_URL_RE.test(String(url)) && !DEV_URL_RE.test(String(url))) throw new Error('loadClient needs a Convex deployment URL');
  const { ConvexHttpClient } = await import('https://cdn.jsdelivr.net/npm/convex@1.45.0/browser/+esm');
  return new ConvexHttpClient(url);
}
