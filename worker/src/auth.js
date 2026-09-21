// ── The one shared secret (C3 Auth) ──────────────────────────────────────────
//
// Every POST, PUT and DELETE carries Authorization: Bearer <MUG_PROXY_TOKEN>,
// and only Convex holds the value. Both sides are hashed before comparing, so
// the comparison takes the same time whatever the input's length or how much
// of it matches. A Worker without the secret answers NOT_CONFIGURED: an
// unset secret never means "let everyone in".

import { envelope } from './errors.js';

const encoder = new TextEncoder();

async function digest(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

/** true when the two strings are equal, compared in constant time. */
export async function sameSecret(given, expected) {
  const [a, b] = await Promise.all([digest(String(given)), digest(String(expected))]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** null when the request may proceed, else the failure envelope to answer. */
export async function authorize(request, env) {
  const secret = env && typeof env.MUG_PROXY_TOKEN === 'string' ? env.MUG_PROXY_TOKEN : '';
  if (!secret) {
    return envelope('NOT_CONFIGURED', 'This Worker has no MUG_PROXY_TOKEN, so it accepts no requests.', {
      hint: 'Set it with `npx wrangler secret put MUG_PROXY_TOKEN`, the same value as Convex\'s MUG_PROXY_TOKEN.',
    });
  }
  const header = request.headers.get('authorization') || '';
  const m = /^bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  if (!m || !(await sameSecret(m[1], secret))) {
    return envelope('UNAUTHORIZED', 'Missing or wrong bearer token.', { hint: 'Only Convex calls this Worker.' });
  }
  return null;
}
