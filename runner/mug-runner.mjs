#!/usr/bin/env node
// ── mug-runner: fetching from a home connection (docs/CONTRACTS.md C8) ────────
//
// Some shops refuse requests from datacenter addresses, the Worker's included.
// This runner does the same work from the owner's workstation: it takes the
// pages and images Convex queued as needsLocal, reads them, and posts the
// results back over Convex's /runner/ HTTP routes. It can also run a whole
// scan of a source.
//
// It is the same reader as the Worker, not a second one: discovery and
// extraction are worker/src/shop.js, fetching is shared/net/polite.js. So the
// runner is bound by the same rules (C10): it always says it is MugBot, it
// reads robots.txt first and obeys it, and a disallowed page is reported as
// ROBOTS_DISALLOWED, never worked around. There is no option to change any of
// that, on purpose. On top of the Worker's rules it waits 1.5 s between
// requests to one host, and it checks every address a shop's name resolves to,
// because unlike a Worker it runs inside a home network.
//
//   node runner/mug-runner.mjs drain [--limit N] [--dry]
//   node runner/mug-runner.mjs scan <sourceSlug> [--max-pages N]
//
// Configuration: MUG_CONVEX_SITE and MUG_RUNNER_TOKEN, from the environment or
// runner/.env. Node 18 or newer, no dependencies.

import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Readable, pipeline } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import { sourceBrand } from '../shared/extract/opengraph.js';
import { sniffImage } from '../shared/images/sniff.js';
import { checkAddress } from '../shared/net/guard.js';
import { politeFetch } from '../shared/net/polite.js';
import { discover, extract, sourceCurrency, validateDiscover } from '../worker/src/shop.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PACE_MS = 1500;
export const STAGE_CHUNK = 50;
export const MAX_SCAN_PAGES = 40;
export const DEFAULT_LIMIT = 25;
const TOKEN_PATTERN = /^mugr_[A-Za-z0-9]{32}$/;

const USAGE = `mug-runner: read shop pages from this machine for Mug's Convex backend

  node runner/mug-runner.mjs drain [--limit N] [--dry]
      Work through the pages and images Convex queued for the runner.
      --limit N   take at most N queue items (default ${DEFAULT_LIMIT})
      --dry       fetch and read everything, post nothing back

  node runner/mug-runner.mjs scan <sourceSlug> [--max-pages N]
      Scan one source end to end, the way the Worker would.
      --max-pages N   read at most N discover pages (default and cap ${MAX_SCAN_PAGES})

Configuration (environment, or runner/.env):
  MUG_CONVEX_SITE    https://<deployment>.convex.site, or http://127.0.0.1:3211 locally
  MUG_RUNNER_TOKEN   mugr_ followed by 32 letters and digits, from the admin page
`;

/** A failure the CLI reports and exits on; `config` ones exit 2, the rest 1. */
export class RunnerError extends Error {
  constructor(message, kind = 'runtime') {
    super(message);
    this.kind = kind;
  }
}

// ── Configuration ────────────────────────────────────────────────────────────

/** KEY=VALUE lines; blank lines, # comments and an `export ` prefix are allowed, quotes are stripped. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

function siteProblem(site) {
  let url;
  try {
    url = new URL(site);
  } catch {
    return 'MUG_CONVEX_SITE is not a URL.';
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol === 'https:' && url.hostname.endsWith('.convex.site')) return null;
  if (url.protocol === 'http:' && loopback) return null;
  return 'MUG_CONVEX_SITE has to be https://<deployment>.convex.site, or http://127.0.0.1:<port> for a local deployment.';
}

/**
 * { ok: true, config: { site, token, env } } or { ok: false, errors }. The
 * environment wins over runner/.env. Error messages never contain the token.
 */
export function loadConfig({ env = process.env, envFile = path.join(HERE, '.env'), readFile = fs.readFileSync } = {}) {
  let fileEnv = {};
  try {
    fileEnv = parseEnvFile(readFile(envFile, 'utf8'));
  } catch {
    fileEnv = {};
  }
  const merged = { ...fileEnv, ...Object.fromEntries(Object.entries(env || {}).filter(([, v]) => v !== undefined && v !== '')) };
  const errors = [];
  const site = String(merged.MUG_CONVEX_SITE || '').trim().replace(/\/+$/, '');
  const token = String(merged.MUG_RUNNER_TOKEN || '').trim();
  if (!site) errors.push('MUG_CONVEX_SITE is not set.');
  else {
    const problem = siteProblem(site);
    if (problem) errors.push(problem);
  }
  if (!token) errors.push('MUG_RUNNER_TOKEN is not set.');
  else if (!TOKEN_PATTERN.test(token)) errors.push('MUG_RUNNER_TOKEN is not a runner token (mugr_ followed by 32 letters and digits).');
  if (errors.length) return { ok: false, errors };
  return { ok: true, config: { site, token, env: { MUG_DEV_ALLOW_LOOPBACK: merged.MUG_DEV_ALLOW_LOOPBACK } } };
}

// ── Convex ───────────────────────────────────────────────────────────────────

/** The /runner/ routes, with the token as a bearer. Answers the parsed JSON; throws RunnerError on transport faults. */
export function convexClient({ site, token, fetchImpl = (u, i) => globalThis.fetch(u, i) }) {
  async function call(method, route, body) {
    let res;
    try {
      res = await fetchImpl(`${site}${route}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new RunnerError(`Could not reach Convex at ${site}: ${String((err && err.message) || err).slice(0, 200)}`);
    }
    if (res.status === 401 || res.status === 403) throw new RunnerError(`Convex refused the runner token on ${route} (HTTP ${res.status}). Make a new one in the admin page.`, 'config');
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!data || typeof data !== 'object') throw new RunnerError(`Convex answered HTTP ${res.status} without JSON on ${route}.`);
    return data;
  }
  return {
    get: (route) => call('GET', route),
    post: (route, body) => call('POST', route, body),
  };
}

// ── Upstream fetching ────────────────────────────────────────────────────────

/**
 * A dns.lookup that refuses private, loopback and other special addresses, so
 * a public name pointing into the home network (a shop's own record, or a
 * name like 10.0.0.1.nip.io) is refused at connect time, not after.
 */
export function guardedLookup(env, resolver = dns.lookup) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) };
    resolver(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: opts.family || 4 }];
      if (!list.length) return callback(Object.assign(new Error(`${hostname} did not resolve.`), { code: 'ENOTFOUND' }));
      for (const entry of list) {
        const verdict = checkAddress(entry.address, { env, hostname });
        if (!verdict.ok) return callback(Object.assign(new Error(verdict.message), { code: 'EMUGBLOCKED', mugCode: 'URL_NOT_ALLOWED' }));
      }
      if (opts.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

/**
 * fetch() on node:http and node:https, with the guarded lookup. Redirects are
 * never followed here (politeFetch follows them by hand), bodies stream, and
 * gzip, deflate and brotli are inflated.
 */
export function nodeFetch({ env, lookup = guardedLookup(env) } = {}) {
  return (url, init = {}) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) {
      reject(new Error(`Cannot fetch ${u.protocol} URLs.`));
      return;
    }
    const headers = { ...(init.headers || {}), 'accept-encoding': 'gzip, deflate, br' };
    const req = mod.request(u, { method: init.method || 'GET', headers, lookup, signal: init.signal }, (res) => {
      const status = res.statusCode || 0;
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase().trim();
      const inflate = encoding === 'gzip' || encoding === 'x-gzip' ? zlib.createGunzip()
        : encoding === 'br' ? zlib.createBrotliDecompress()
          : encoding === 'deflate' ? zlib.createInflate() : null;
      const out = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        try {
          if (Array.isArray(value)) for (const v of value) out.append(name, v);
          else if (value !== undefined) out.set(name, String(value));
        } catch {
          // A header value fetch() would reject is dropped, not fatal.
        }
      }
      let stream = res;
      if (inflate) {
        stream = pipeline(res, inflate, () => {});
        out.delete('content-encoding');
        out.delete('content-length');
      }
      const empty = (init.method || 'GET') === 'HEAD' || status === 204 || status === 304;
      if (empty) res.resume();
      try {
        resolve(new Response(empty ? null : Readable.toWeb(stream), { status: status >= 200 && status <= 599 ? status : 502, headers: out }));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
    req.end();
  });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wraps a fetch so requests to one host start at least `gapMs` apart (C10.5). */
export function paced(fetchImpl, { gapMs = PACE_MS, sleep = defaultSleep, now = Date.now } = {}) {
  const last = new Map();
  return async (url, init) => {
    const host = new URL(url).host;
    const previous = last.get(host);
    if (previous !== undefined) {
      const wait = previous + gapMs - now();
      if (wait > 0) await sleep(wait);
    }
    last.set(host, now());
    return fetchImpl(url, init);
  };
}

// ── drain ────────────────────────────────────────────────────────────────────

function context(deps) {
  return { fetchImpl: deps.upstream, robotsCache: deps.robotsCache, env: deps.env || {}, via: 'runner', now: deps.now };
}

function count(summary, code) {
  summary.codes[code] = (summary.codes[code] || 0) + 1;
}

/**
 * Posts a failed item to /runner/ingest as { id, error }. C8 defines this for
 * pages; for images it is this runner's reading, and a Convex that does not
 * take image ids answers not-ok, which is said rather than hidden: the item
 * then simply stays in Convex's queue.
 */
async function reportFailure(deps, item, failure, dry) {
  if (dry) return;
  // Images carry their URL too (A9): positions shift as a mug's other images land.
  const answer = await deps.convex.post('/runner/ingest', {
    id: item.id,
    ...(item.kind === 'image' ? { url: item.url } : {}),
    error: { code: failure.code, message: String(failure.message || '').slice(0, 300), ...(failure.retryable === true ? { retryable: true } : {}) },
  });
  if (!answer.ok) deps.log(`        Convex did not record the failure (${answer.code}: ${answer.message}); the item stays in its queue.`);
}

async function drainPage(item, tag, deps, dry, summary) {
  const r = await extract({ url: item.url }, context(deps));
  if (!r.ok) {
    deps.log(`${tag} page  ${item.url}\n        ${r.code}: ${r.message}`);
    summary.pages.failed++;
    count(summary, r.code);
    await reportFailure(deps, item, r, dry);
    return;
  }
  if (dry) {
    deps.log(`${tag} page  ${item.url}\n        read: ${r.listing.name} (${r.listing.source.platform}, not posted)`);
    summary.pages.ok++;
    return;
  }
  const answer = await deps.convex.post('/runner/ingest', { id: item.id, listing: r.listing });
  if (answer.ok) {
    summary.pages.ok++;
    deps.log(`${tag} page  ${item.url}\n        ${r.listing.name}: ${answer.status || 'ingested'}${answer.match && answer.match.kind ? ` (${answer.match.kind})` : ''}`);
  } else {
    summary.pages.failed++;
    count(summary, answer.code || 'CONVEX');
    deps.log(`${tag} page  ${item.url}\n        Convex refused it: ${answer.code}: ${answer.message}`);
  }
}

async function uploadBytes(deps, bytes, contentType) {
  const up = await deps.convex.post('/runner/upload-url');
  if (!up.ok || typeof up.uploadUrl !== 'string' || !/^https?:\/\//i.test(up.uploadUrl)) {
    return { ok: false, message: `Convex gave no upload URL${up.code ? ` (${up.code}: ${up.message})` : ''}.` };
  }
  let res;
  try {
    res = await deps.convexFetch(up.uploadUrl, { method: 'POST', headers: { 'content-type': contentType }, body: bytes });
  } catch (err) {
    return { ok: false, message: `The upload failed: ${String((err && err.message) || err).slice(0, 200)}` };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || !data || typeof data.storageId !== 'string') return { ok: false, message: `The upload answered HTTP ${res.status} without a storageId.` };
  return { ok: true, storageId: data.storageId };
}

async function drainImage(item, tag, deps, dry, summary) {
  const got = await politeFetch(item.url, { fetchImpl: deps.upstream, robotsCache: deps.robotsCache, env: deps.env || {}, kind: 'image' });
  const sniffed = got.ok ? sniffImage(got.body) : null;
  const failure = !got.ok ? got : !sniffed ? { code: 'NOT_AN_IMAGE', message: `${item.url} is not a jpg, png, gif, webp or avif image.` } : null;
  if (failure) {
    deps.log(`${tag} image ${item.url}\n        ${failure.code}: ${failure.message}`);
    summary.images.failed++;
    count(summary, failure.code);
    await reportFailure(deps, item, failure, dry);
    return;
  }
  const size = `${got.bytes} bytes, ${sniffed.ext}${sniffed.w ? `, ${sniffed.w}x${sniffed.h}` : ''}`;
  if (dry) {
    deps.log(`${tag} image ${item.url}\n        read: ${size} (not uploaded)`);
    summary.images.ok++;
    return;
  }
  const stored = await uploadBytes(deps, got.body, sniffed.contentType);
  if (!stored.ok) {
    deps.log(`${tag} image ${item.url}\n        ${stored.message} Left in the queue for the next drain.`);
    summary.images.failed++;
    count(summary, 'UPLOAD');
    return;
  }
  const answer = await deps.convex.post('/runner/image', { mugId: item.mugId, index: item.index, url: item.url, storageId: stored.storageId });
  if (answer.ok) {
    summary.images.ok++;
    deps.log(`${tag} image ${item.url}\n        stored: ${size}`);
  } else {
    summary.images.failed++;
    count(summary, answer.code || 'CONVEX');
    deps.log(`${tag} image ${item.url}\n        Convex refused it: ${answer.code}: ${answer.message}`);
  }
}

/**
 * C8 drain: GET /runner/queue, then each page is extracted and posted to
 * /runner/ingest, and each image is fetched, uploaded to Convex storage and
 * attached with /runner/image. Failures are posted to /runner/ingest as
 * { id, error }. `dry` does everything except the POSTs.
 */
export async function drain({ limit = DEFAULT_LIMIT, dry = false } = {}, deps) {
  const queue = await deps.convex.get(`/runner/queue?limit=${limit}`);
  if (!queue.ok) throw new RunnerError(`Convex would not hand out the queue: ${queue.code}: ${queue.message}`);
  const items = Array.isArray(queue.items) ? queue.items : [];
  const summary = { items: items.length, pages: { ok: 0, failed: 0 }, images: { ok: 0, failed: 0 }, skipped: 0, codes: {} };
  deps.log(`queue: ${items.length} item(s)${dry ? ', dry run: nothing is posted' : ''}`);
  for (const [i, item] of items.entries()) {
    const tag = `[${i + 1}/${items.length}]`;
    if (!item || typeof item.url !== 'string') {
      summary.skipped++;
      deps.log(`${tag} skipped: the item has no URL`);
    } else if (item.kind === 'page') await drainPage(item, tag, deps, dry, summary);
    else if (item.kind === 'image') await drainImage(item, tag, deps, dry, summary);
    else {
      summary.skipped++;
      deps.log(`${tag} skipped: unknown kind ${JSON.stringify(item.kind)}`);
    }
  }
  return summary;
}

// ── scan ─────────────────────────────────────────────────────────────────────

/**
 * C8 scan: POST /runner/scan, discover the source's entry URLs exactly as the
 * Worker would (same shop.js), extract jsonld URLs one by one, POST
 * /runner/stage in chunks of at most 50, then POST /runner/finish (with an
 * error string when an entry could not be read at all).
 */
export async function scan(sourceSlug, { maxPages = MAX_SCAN_PAGES } = {}, deps) {
  const started = await deps.convex.post('/runner/scan', { sourceSlug });
  if (!started.ok) throw new RunnerError(`Convex would not start a scan of ${sourceSlug}: ${started.code}: ${started.message}`);
  const { runId, source } = started;
  if (!runId || !source || typeof source !== 'object') throw new RunnerError('Convex answered /runner/scan without a runId and source.');
  const brand = sourceBrand(source.brand);
  const currency = sourceCurrency(source.currency);
  const ctx = context(deps);
  const summary = { runId, pages: 0, listings: 0, urls: 0, extracted: 0, failed: 0, staged: 0, unchanged: 0, skipped: 0, codes: {} };
  const errors = [];
  const pending = [];
  deps.log(`scan ${sourceSlug}: run ${runId}, adapter ${source.adapter}${brand ? `, brand ${brand}` : ''}`);

  const flush = async (all) => {
    while (pending.length >= STAGE_CHUNK || (all && pending.length)) {
      const chunk = pending.splice(0, STAGE_CHUNK);
      const answer = await deps.convex.post('/runner/stage', { runId, listings: chunk });
      if (!answer.ok) throw new RunnerError(`Convex refused a batch of ${chunk.length}: ${answer.code}: ${answer.message}`);
      summary.staged += answer.staged || 0;
      summary.unchanged += answer.unchanged || 0;
      summary.skipped += answer.skipped || 0;
      deps.log(`  staged ${chunk.length}: ${answer.staged || 0} new or changed, ${answer.unchanged || 0} unchanged, ${answer.skipped || 0} skipped`);
    }
  };

  let failure;
  try {
    if (source.adapter === 'manual') throw new RunnerError('A manual source has nothing to scan.');
    const entries = Array.isArray(source.entryUrls) && source.entryUrls.length ? source.entryUrls : [source.baseUrl];
    let pagesLeft = Math.max(1, Math.min(MAX_SCAN_PAGES, Number(maxPages) || MAX_SCAN_PAGES));
    for (const entry of entries) {
      let url = entry;
      for (let page = 1; pagesLeft > 0; page++) {
        const args = validateDiscover({ adapter: source.adapter, url, page, include: source.include, exclude: source.exclude, brand, currency });
        if (!args.ok) {
          errors.push(`${entry}: ${args.message}`);
          break;
        }
        pagesLeft--;
        summary.pages++;
        const found = await discover(args, ctx);
        if (!found.ok) {
          count(summary, found.code);
          deps.log(`  page ${page} of ${entry}: ${found.code}: ${found.message}`);
          if (page === 1) errors.push(`${found.code} on ${entry}: ${found.message}`);
          break;
        }
        const listings = found.listings || [];
        const urls = found.urls || [];
        deps.log(`  page ${page} of ${entry}: ${listings.length ? `${listings.length} listing(s)` : `${urls.length} URL(s)`}, ${found.skipped || 0} skipped`);
        summary.listings += listings.length;
        summary.urls += urls.length;
        pending.push(...listings);
        await flush(false);
        for (const productUrl of urls) {
          const got = await extract({ url: productUrl, brand, currency }, ctx);
          if (got.ok) {
            summary.extracted++;
            pending.push(got.listing);
            await flush(false);
          } else {
            summary.failed++;
            count(summary, got.code);
            deps.log(`    ${productUrl}: ${got.code}: ${got.message}`);
          }
        }
        if (!found.next) break;
        url = typeof found.next.url === 'string' ? found.next.url : entry;
      }
    }
    await flush(true);
  } catch (err) {
    failure = err;
    errors.push(String((err && err.message) || err));
  }
  const error = errors.length ? errors.join(' | ').slice(0, 500) : undefined;
  await deps.convex.post('/runner/finish', error ? { runId, error } : { runId });
  summary.error = error;
  if (failure && failure.kind === 'config') throw failure;
  return summary;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { command: argv[0], positional: [], limit: DEFAULT_LIMIT, dry: false, maxPages: MAX_SCAN_PAGES, errors: [] };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const number = (name) => {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) out.errors.push(`${name} takes a whole number of 1 or more.`);
      return n;
    };
    if (arg === '--dry') out.dry = true;
    else if (arg === '--limit') out.limit = number('--limit');
    else if (arg === '--max-pages') out.maxPages = number('--max-pages');
    else if (arg === '--help' || arg === '-h') out.command = 'help';
    else if (arg.startsWith('--')) out.errors.push(`Unknown option ${arg}.`);
    else out.positional.push(arg);
  }
  return out;
}

function printSummary(log, command, s) {
  if (command === 'drain') {
    log(`\ndone: ${s.items} item(s); pages ${s.pages.ok} ok, ${s.pages.failed} failed; images ${s.images.ok} ok, ${s.images.failed} failed${s.skipped ? `; ${s.skipped} skipped` : ''}`);
  } else {
    log(`\ndone: run ${s.runId}; ${s.pages} discover page(s), ${s.listings} listing(s) and ${s.urls} URL(s) found, ${s.extracted} extracted, ${s.failed} failed; Convex staged ${s.staged}, ${s.unchanged} unchanged, ${s.skipped} skipped`);
    if (s.error) log(`error sent to Convex: ${s.error}`);
  }
  const codes = Object.entries(s.codes);
  if (codes.length) log(`failures by code: ${codes.map(([c, n]) => `${c} ${n}`).join(', ')}`);
}

/** The CLI. Answers the exit code: 0 done, 1 a runtime failure, 2 a usage or configuration error. */
export async function main(argv, { env = process.env, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), envFile, upstream, convexFetch, robotsCache } = {}) {
  const major = Number(String(process.versions.node).split('.')[0]);
  if (major < 18) {
    err('mug-runner needs Node 18 or newer.');
    return 2;
  }
  const args = parseArgs(argv);
  if (!args.command || args.command === 'help') {
    out(USAGE);
    return args.command ? 0 : 2;
  }
  if (!['drain', 'scan'].includes(args.command)) {
    err(`Unknown command ${JSON.stringify(args.command)}.\n\n${USAGE}`);
    return 2;
  }
  if (args.command === 'scan' && args.positional.length !== 1) args.errors.push('scan takes exactly one source slug.');
  if (args.command === 'drain' && args.positional.length) args.errors.push('drain takes no positional arguments.');
  if (args.errors.length) {
    err(`${args.errors.join('\n')}\n\n${USAGE}`);
    return 2;
  }
  const loaded = loadConfig({ env, ...(envFile ? { envFile } : {}) });
  if (!loaded.ok) {
    err(`mug-runner is not configured:\n  ${loaded.errors.join('\n  ')}\nSet them in the environment or in runner/.env (see runner/.env.example).`);
    return 2;
  }
  const { site, token } = loaded.config;
  const redact = (s) => String(s).split(token).join('mugr_[redacted]');
  const log = (s) => out(redact(s));
  const fetchConvex = convexFetch || ((u, i) => globalThis.fetch(u, i));
  const deps = {
    convex: convexClient({ site, token, fetchImpl: fetchConvex }),
    convexFetch: fetchConvex,
    upstream: upstream || paced(nodeFetch({ env: loaded.config.env })),
    robotsCache: robotsCache || new Map(),
    env: loaded.config.env,
    log,
  };
  log(`mug-runner ${args.command}: Convex at ${site}, token set${loaded.config.env.MUG_DEV_ALLOW_LOOPBACK === '1' ? ', loopback allowed (development)' : ''}`);
  try {
    const summary = args.command === 'drain'
      ? await drain({ limit: args.limit, dry: args.dry }, deps)
      : await scan(args.positional[0], { maxPages: args.maxPages }, deps);
    printSummary(log, args.command, summary);
    return 0;
  } catch (e) {
    err(redact(e && e.message ? e.message : e));
    return e instanceof RunnerError && e.kind === 'config' ? 2 : 1;
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) process.exitCode = await main(process.argv.slice(2));
