#!/usr/bin/env node
// Dev sign-in for a dev deployment (docs/CONTRACTS.md C9, A4).
//
// The production Clerk key refuses localhost, so signed-in pages cannot be
// exercised locally through the Auth Kit. This makes a key pair that only
// this machine holds, prints its public half as the data: URI a dev
// deployment trusts through MUG_DEV_JWKS, and mints short-lived tokens the
// pages accept on localhost via ?devtoken=.
//
//   node scripts/dev-auth.mjs init                  # once: writes .dev-auth/ (gitignored)
//   node scripts/dev-auth.mjs jwks                  # the value for: npx convex env set MUG_DEV_JWKS '<it>'
//   node scripts/dev-auth.mjs token [--sub dev-admin] [--name "Dev Admin"] [--hours 12]
//
// Production never has MUG_DEV_JWKS set, so production refuses these tokens
// whoever holds the key. Never set it on a production deployment.

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, '.dev-auth');
const PRIVATE = join(DIR, 'private.pem');
const JWKS = join(DIR, 'jwks.json');
export const ISSUER = 'https://dev-auth.mug.invalid';
export const AUDIENCE = 'mug-dev';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function init() {
  if (existsSync(PRIVATE)) {
    console.log(`.dev-auth/ already has a key; delete ${PRIVATE} first to replace it.`);
    return;
  }
  mkdirSync(DIR, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = b64url(randomBytes(9));
  writeFileSync(PRIVATE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  writeFileSync(JWKS, JSON.stringify({ keys: [jwk] }, null, 2));
  console.log('Wrote .dev-auth/private.pem (this machine only) and .dev-auth/jwks.json.');
  console.log('Next: npx convex env set MUG_DEV_JWKS "$(node scripts/dev-auth.mjs jwks)"   (dev deployment only)');
}

function jwksDataUri() {
  if (!existsSync(JWKS)) throw new Error('No key yet: run `node scripts/dev-auth.mjs init` first.');
  return `data:text/plain;charset=utf-8;base64,${Buffer.from(readFileSync(JWKS)).toString('base64')}`;
}

export function mint({ sub, name, hours, now = Date.now() }) {
  const pem = readFileSync(PRIVATE, 'utf8');
  const key = createPrivateKey(pem);
  const { keys } = JSON.parse(readFileSync(JWKS, 'utf8'));
  const header = { alg: 'RS256', typ: 'JWT', kid: keys[0].kid };
  const iat = Math.floor(now / 1000);
  const payload = { iss: ISSUER, aud: AUDIENCE, sub, name, iat, exp: iat + Math.round(hours * 3600) };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = sign('RSA-SHA256', Buffer.from(body), key);
  // Refuse to hand out a token the public half would not verify.
  createPublicKey(key);
  return `${body}.${b64url(signature)}`;
}

const command = process.argv[2];
try {
  if (command === 'init') init();
  else if (command === 'jwks') process.stdout.write(jwksDataUri());
  else if (command === 'token') {
    if (!existsSync(PRIVATE)) throw new Error('No key yet: run `node scripts/dev-auth.mjs init` first.');
    const sub = arg('sub', 'dev-admin');
    const token = mint({ sub, name: arg('name', 'Dev Admin'), hours: Number(arg('hours', '12')) });
    process.stdout.write(token);
    process.stderr.write(`\nOpen a page with ?devtoken=<the token> on localhost. Subject: ${sub}. Add it to ADMIN_SUBJECTS on the dev deployment for admin.\n`);
  } else if (command) {
    console.error(`Unknown command ${command}. Use init, jwks or token.`);
    process.exit(1);
  } else {
    console.log('usage: node scripts/dev-auth.mjs init | jwks | token [--sub id] [--name text] [--hours n]');
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
