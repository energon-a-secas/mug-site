// ── robots.txt, as RFC 9309 reads it ─────────────────────────────────────────
//
// C10.2: robots.txt is read before the first fetch on a host and obeyed for
// the mugbot group, else "*". This file is the parser and the matcher; the
// fetching and the one-hour cache live in polite.js. Pure functions, no I/O.
//
// What the RFC settles, and this follows:
//   - A group is one or more user-agent lines and the rules after them. Every
//     group naming our product token is merged; only when none does are the
//     "*" groups used; with neither, nothing is disallowed.
//   - The longest matching rule wins, counted in octets of the pattern, and on
//     a tie Allow wins. "*" matches any run of characters and a final "$"
//     anchors the end. Both sides are compared percent-encoded, with escaped
//     unreserved characters decoded, so "/%62az" and "/baz" are one path.
//   - A 4xx robots.txt means no rules apply; a 5xx, a timeout or a network
//     failure means everything is disallowed for now. /robots.txt itself is
//     always allowed. Only the first 500 KiB are parsed.
//
// Matching is done by splitting a pattern on "*" and finding the pieces left
// to right, never with a regex built from the file, so a hostile robots.txt
// cannot make the matcher backtrack.

import { ROBOTS_TOKEN } from '../contract.js';

export const ROBOTS_MAX_BYTES = 500 * 1024;

const USER_AGENT_KEYS = new Set(['user-agent', 'useragent', 'user agent']);
const ALLOW_KEYS = new Set(['allow']);
const DISALLOW_KEYS = new Set(['disallow', 'dissallow', 'dissalow', 'disalow', 'diasllow', 'disallaw']);

const HEX = '0123456789ABCDEF';
const UTF8 = new TextEncoder();

function isUnreserved(code) {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
    || code === 0x2d || code === 0x2e || code === 0x5f || code === 0x7e;
}

function isHex(ch) {
  return ch !== undefined && /^[0-9a-fA-F]$/.test(ch);
}

/**
 * RFC 9309 2.2.2's comparison form: non-ASCII, controls and spaces
 * percent-encoded as UTF-8, existing escapes uppercased, escaped unreserved
 * characters decoded. Applied to patterns and to the URL alike.
 */
export function normalizePath(text) {
  const s = String(text ?? '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '%' && isHex(s[i + 1]) && isHex(s[i + 2])) {
      const value = parseInt(s.slice(i + 1, i + 3), 16);
      out += isUnreserved(value) ? String.fromCharCode(value) : `%${s.slice(i + 1, i + 3).toUpperCase()}`;
      i += 2;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code > 0x20 && code < 0x7f) {
      out += ch;
      continue;
    }
    // A surrogate pair is one code point: encode both halves together.
    const point = s.codePointAt(i);
    const chars = String.fromCodePoint(point);
    if (chars.length === 2) i += 1;
    for (const byte of UTF8.encode(chars)) out += `%${HEX[byte >> 4]}${HEX[byte & 15]}`;
  }
  return out;
}

function compile(pattern) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  return { parts: body.split('*'), anchored };
}

/** true when the compiled pattern matches the normalised path (a prefix match unless anchored). */
function matches({ parts, anchored }, target) {
  if (!target.startsWith(parts[0])) return false;
  let pos = parts[0].length;
  if (parts.length === 1) return anchored ? pos === target.length : true;
  for (let i = 1; i < parts.length - 1; i++) {
    const piece = parts[i];
    if (!piece) continue;
    const at = target.indexOf(piece, pos);
    if (at === -1) return false;
    pos = at + piece.length;
  }
  const last = parts[parts.length - 1];
  if (!anchored) return last === '' || target.indexOf(last, pos) !== -1;
  return target.length - last.length >= pos && target.endsWith(last);
}

/** The product token a user-agent line names: "*", or its leading [A-Za-z_-] run, lowercased. */
export function agentToken(value) {
  const v = String(value ?? '').trim();
  if (v.split(/\s+/)[0] === '*') return '*';
  const m = /^[A-Za-z_-]+/.exec(v);
  return m ? m[0].toLowerCase() : '';
}

/**
 * The file as groups: [{ agents: [...], rules: [{ allow, pattern, line, length }] }],
 * plus the Sitemap lines it lists.
 */
export function parseRobots(text) {
  let src = String(text ?? '');
  if (src.length > ROBOTS_MAX_BYTES) src = src.slice(0, ROBOTS_MAX_BYTES);
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const groups = [];
  const sitemaps = [];
  let current = null;
  for (let raw of src.split(/\r\n|\r|\n/)) {
    const hash = raw.indexOf('#');
    if (hash !== -1) raw = raw.slice(0, hash);
    const colon = raw.indexOf(':');
    if (colon === -1) continue;
    const key = raw.slice(0, colon).trim().toLowerCase().replace(/\s+/g, ' ');
    const value = raw.slice(colon + 1).trim();
    if (USER_AGENT_KEYS.has(key)) {
      if (!current || current.hasRules) {
        current = { agents: [], rules: [], hasRules: false };
        groups.push(current);
      }
      current.agents.push(value);
      continue;
    }
    const allow = ALLOW_KEYS.has(key);
    if (allow || DISALLOW_KEYS.has(key)) {
      if (!current) continue; // a rule before any user-agent line belongs to no group
      current.hasRules = true;
      if (!value) continue; // "Disallow:" with no path disallows nothing
      const path = value.startsWith('/') || value.startsWith('*') ? value : `/${value}`;
      const pattern = normalizePath(path);
      current.rules.push({ allow, pattern, line: `${allow ? 'Allow' : 'Disallow'}: ${value}`, length: pattern.length, compiled: compile(pattern) });
      continue;
    }
    if (key === 'sitemap' && value) sitemaps.push(value);
  }
  return { groups: groups.map(({ agents, rules }) => ({ agents, rules })), sitemaps };
}

/** The rules that bind `token`: its own groups merged, else the "*" groups, else none. */
export function selectRules(parsed, token = ROBOTS_TOKEN) {
  const groups = (parsed && parsed.groups) || [];
  const want = String(token).toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => agentToken(a) === want));
  if (own.length) return { group: want, rules: own.flatMap((g) => g.rules) };
  const star = groups.filter((g) => g.agents.some((a) => agentToken(a) === '*'));
  if (star.length) return { group: '*', rules: star.flatMap((g) => g.rules) };
  return { group: null, rules: [] };
}

/** The path the rules are matched against: path and query, in comparison form. */
export function robotsTarget(url) {
  const u = url instanceof URL ? url : new URL(String(url));
  return normalizePath(`${u.pathname || '/'}${u.search}`);
}

/** Longest match wins, Allow wins a tie, no match allows. `rule` is the deciding line or null. */
export function matchRules(rules, target) {
  let best = null;
  for (const r of rules) {
    if (!matches(r.compiled, target)) continue;
    if (!best || r.length > best.length || (r.length === best.length && r.allow && !best.allow)) best = r;
  }
  return best ? { allowed: best.allow, rule: best.line } : { allowed: true, rule: null };
}

/**
 * A policy from what fetching robots.txt produced:
 *   { status: 200, text }       rules from the file
 *   { status: 404 }             4xx: allow everything
 *   { status: 503 }             5xx: disallow everything for now
 *   { error: "timeout" | "network" | "refused" | "redirects", detail } no usable answer
 */
export function robotsPolicy({ status, text, error, detail, token = ROBOTS_TOKEN } = {}) {
  if (error === 'redirects') {
    return { kind: 'allow-all', status: null, reason: 'robots.txt redirected more than five times, so it counts as unavailable' };
  }
  if (error) {
    const why = error === 'timeout' ? 'timed out' : error === 'refused' ? `redirected to a refused address (${detail || 'guard'})` : `could not be read (${detail || 'network error'})`;
    return { kind: 'disallow-all', status: null, reason: `robots.txt ${why}, so everything is disallowed for now` };
  }
  if (status >= 200 && status < 300) {
    const { group, rules } = selectRules(parseRobots(text), token);
    return { kind: 'rules', status, group, rules };
  }
  if (status >= 400 && status < 500) return { kind: 'allow-all', status, reason: `robots.txt answered ${status}, so no rules apply` };
  return { kind: 'disallow-all', status: status || null, reason: `robots.txt answered ${status}, so everything is disallowed for now` };
}

/** { allowed, rule } for one URL under a policy from robotsPolicy(). */
export function robotsVerdict(policy, url) {
  const u = url instanceof URL ? url : new URL(String(url));
  if (u.pathname === '/robots.txt') return { allowed: true, rule: null };
  if (!policy || policy.kind === 'allow-all') return { allowed: true, rule: policy ? policy.reason : null };
  if (policy.kind === 'disallow-all') return { allowed: false, rule: policy.reason };
  return matchRules(policy.rules, robotsTarget(u));
}

/** Convenience for tests and one-off checks: the verdict for `url` under the file `text`. */
export function isAllowed(text, url, token = ROBOTS_TOKEN) {
  return robotsVerdict(robotsPolicy({ status: 200, text, token }), url);
}
