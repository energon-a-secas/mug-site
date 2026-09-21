// ── The SSRF guard (docs/CONTRACTS.md C10.3) ─────────────────────────────────
//
// Every URL the Worker or the runner is about to fetch passes through here
// first, and so does every redirect hop, because a shop's page is input we do
// not write. It is a string check: http or https, default ports, no
// credentials, no internal names, and no IP literal in a private, loopback,
// link-local, CGNAT or otherwise special-purpose range (all of RFC 6890, a
// superset of the ranges C10.3 names).
//
// A string check cannot see where a public name resolves. The Worker does not
// need to (Cloudflare's edge cannot reach anyone's private network), but the
// runner runs on a home network, so it also checks every resolved address with
// checkAddress() before it connects.
//
// One relaxation exists, for local development only: with
// MUG_DEV_ALLOW_LOOPBACK=1 in the environment, 127.0.0.1 and localhost (and
// only those) are allowed, on any port, so a fixture shop can be scanned under
// `wrangler dev`. Nothing else relaxes the guard.

import { LIMITS } from '../contract.js';

export const GUARD_CODE = 'URL_NOT_ALLOWED';

/** true when this environment carries the local-development loopback switch. */
export function devLoopback(env) {
  return !!env && env.MUG_DEV_ALLOW_LOOPBACK === '1';
}

function deny(message) {
  return { ok: false, code: GUARD_CODE, message };
}

/** Four octets from a dotted-decimal address, or null. */
export function parseIPv4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((n) => n <= 255) ? octets : null;
}

/** Eight 16-bit groups from an IPv6 address (brackets, zone and dotted tail allowed), or null. */
export function parseIPv6(text) {
  let s = String(text ?? '').trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (!s.includes(':')) return null;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const split = (part) => (part === '' ? [] : part.split(':'));
  const head = split(halves[0]);
  const rest = halves.length === 2 ? split(halves[1]) : [];
  if (halves.length === 2 && head.length + rest.length > 7) return null;
  const groups = halves.length === 2 ? [...head, ...new Array(8 - head.length - rest.length).fill('0'), ...rest] : head;
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

// [first address, prefix length, what it is]. Everything here is refused.
const V4_RANGES = [
  ['0.0.0.0', 8, 'this-network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'CGNAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
].map(([base, bits, what]) => ({ base: toInt(parseIPv4(base)), mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0, what }));

function toInt(octets) {
  return (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
}

/** Why an IPv4 address is refused ("private", "loopback", ...), or null when it is public. */
export function ipv4Blocked(octets) {
  const ip = toInt(octets);
  for (const r of V4_RANGES) if (((ip & r.mask) >>> 0) === ((r.base & r.mask) >>> 0)) return r.what;
  return null;
}

function zeros(groups) {
  return groups.every((g) => g === 0);
}

function embedded(hi, lo) {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/** Why an IPv6 address is refused, or null when it is public. Embedded IPv4 is judged as IPv4. */
export function ipv6Blocked(h) {
  if (zeros(h.slice(0, 6))) return 'unspecified, loopback or IPv4-compatible';
  if (zeros(h.slice(0, 5)) && h[5] === 0xffff) {
    const why = ipv4Blocked(embedded(h[6], h[7]));
    return why ? `IPv4-mapped ${why}` : null;
  }
  if (zeros(h.slice(0, 4)) && h[4] === 0xffff && h[5] === 0) {
    const why = ipv4Blocked(embedded(h[6], h[7]));
    return why ? `IPv4-translated ${why}` : null;
  }
  if (h[0] === 0x64 && h[1] === 0xff9b) {
    if (h[2] === 1) return 'local-use NAT64';
    if (zeros(h.slice(2, 6))) {
      const why = ipv4Blocked(embedded(h[6], h[7]));
      return why ? `NAT64 ${why}` : null;
    }
  }
  if (h[0] === 0x100 && zeros(h.slice(1, 4))) return 'discard-only';
  if (h[0] === 0x2001 && h[1] < 0x200) return 'IETF protocol (Teredo and others)';
  if (h[0] === 0x2001 && h[1] === 0xdb8) return 'documentation';
  if (h[0] === 0x2002) {
    const why = ipv4Blocked(embedded(h[1], h[2]));
    return why ? `6to4 ${why}` : null;
  }
  if (h[0] === 0x3fff && h[1] < 0x1000) return 'documentation';
  if ((h[0] & 0xfe00) === 0xfc00) return 'unique-local (private)';
  if ((h[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((h[0] & 0xffc0) === 0xfec0) return 'site-local';
  if ((h[0] & 0xff00) === 0xff00) return 'multicast';
  return null;
}

function isLoopback(v4, v6) {
  if (v4) return v4[0] === 127;
  if (v6) {
    if (zeros(v6.slice(0, 7)) && v6[7] === 1) return true;
    if (zeros(v6.slice(0, 5)) && v6[5] === 0xffff) return (v6[6] >> 8) === 127;
  }
  return false;
}

// Names that only mean something inside a network. C10.3 names localhost,
// .local, .internal and metadata*; the rest are the other suffixes home and
// office networks use, refused on the same grounds.
const INTERNAL_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa', 'localdomain', 'lan', 'intranet', 'corp', 'home'];

function internalName(host) {
  if (host.startsWith('metadata')) return 'a cloud metadata name';
  for (const suffix of INTERNAL_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return `an internal name (.${suffix})`;
  }
  if (!host.includes('.')) return 'a single-label name, which only resolves inside a network';
  return null;
}

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost']);

/**
 * C10.3 for one URL. Returns { ok: true, url } with a parsed URL (fragment
 * dropped), or { ok: false, code: "URL_NOT_ALLOWED", message }.
 */
export function checkUrl(raw, { env } = {}) {
  let url;
  try {
    url = new URL(raw instanceof URL ? raw.href : String(raw ?? '').trim());
  } catch {
    return deny('That is not an absolute URL.');
  }
  url.hash = '';
  if (url.href.length > LIMITS.url) return deny(`The URL is longer than ${LIMITS.url} characters.`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return deny(`Only http and https are fetched, not ${url.protocol}`);
  if (url.username || url.password) return deny('A URL carrying a user name or password is refused.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return deny('The URL has no host.');
  if (devLoopback(env) && LOOPBACK_NAMES.has(host)) return { ok: true, url };
  if (url.port) return deny(`Only default ports are fetched, and this URL asks for :${url.port}.`);
  const v4 = parseIPv4(host);
  if (v4) {
    const why = ipv4Blocked(v4);
    return why ? deny(`${host} is a ${why} address.`) : { ok: true, url };
  }
  if (host.startsWith('[')) {
    const v6 = parseIPv6(host);
    if (!v6) return deny(`${host} is not a valid IPv6 address.`);
    const why = ipv6Blocked(v6);
    return why ? deny(`${host} is a ${why} address.`) : { ok: true, url };
  }
  const why = internalName(host);
  return why ? deny(`${host} is ${why}.`) : { ok: true, url };
}

/**
 * The same ranges, for an address a name resolved to (the runner's DNS
 * check). `hostname` is the name that was looked up: only 127.0.0.1 and
 * localhost may resolve to loopback, and only under the development switch.
 */
export function checkAddress(address, { env, hostname } = {}) {
  const v4 = parseIPv4(address);
  const v6 = v4 ? null : parseIPv6(address);
  if (!v4 && !v6) return deny(`${address} is not an IP address.`);
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  if (devLoopback(env) && LOOPBACK_NAMES.has(host) && isLoopback(v4, v6)) return { ok: true };
  const why = v4 ? ipv4Blocked(v4) : ipv6Blocked(v6);
  return why ? deny(`${hostname || address} resolves to ${address}, a ${why} address.`) : { ok: true };
}
