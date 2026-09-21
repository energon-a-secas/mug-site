// robots.txt as RFC 9309 reads it: groups, longest match, Allow on ties,
// wildcards, "$", percent-encoding, and what a 4xx or a 5xx means.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentToken, isAllowed, normalizePath, parseRobots, robotsPolicy, robotsVerdict, selectRules,
} from '../shared/net/robots.js';

const at = (path) => `https://shop.example${path}`;

test('group selection: the mugbot group, else *, else nothing', () => {
  const both = 'User-agent: *\nDisallow: /\n\nUser-agent: MugBot\nDisallow: /private/\n';
  assert.equal(isAllowed(both, at('/products/x')).allowed, true, 'our own group replaces *');
  assert.equal(isAllowed(both, at('/private/a')).allowed, false);

  const starOnly = 'User-agent: *\nDisallow: /cart\n';
  assert.equal(isAllowed(starOnly, at('/cart')).allowed, false);
  assert.equal(isAllowed(starOnly, at('/products/x')).allowed, true);

  const otherBots = 'User-agent: Googlebot\nDisallow: /\n';
  assert.deepEqual(isAllowed(otherBots, at('/anything')), { allowed: true, rule: null }, 'no group for us and no *: nothing applies');

  assert.equal(selectRules(parseRobots(both)).group, 'mugbot');
  assert.equal(selectRules(parseRobots(starOnly)).group, '*');
  assert.equal(selectRules(parseRobots(otherBots)).group, null);
});

test('group selection: product token matching', () => {
  assert.equal(agentToken('MugBot/1.0 (+https://mug.neorgon.com/bot/)'), 'mugbot');
  assert.equal(agentToken('  mugbot  '), 'mugbot');
  assert.equal(agentToken('*'), '*');
  assert.equal(agentToken('mugbot-extended'), 'mugbot-extended', 'a longer token is a different bot');
  const file = 'User-agent: mugbot-extended\nDisallow: /\n\nUser-agent: *\nAllow: /\n';
  assert.equal(isAllowed(file, at('/x')).allowed, true);
  assert.equal(isAllowed('User-agent: MUGBOT\nDisallow: /x\n', at('/x')).allowed, false, 'case-insensitive');
});

test('groups: every group naming us is merged, and consecutive user-agent lines share rules', () => {
  const file = [
    'User-agent: MugBot', 'Disallow: /a', '',
    'User-agent: OtherBot', 'User-agent: MugBot', 'Disallow: /b', '',
    'User-agent: *', 'Disallow: /c',
  ].join('\n');
  assert.equal(isAllowed(file, at('/a')).allowed, false);
  assert.equal(isAllowed(file, at('/b')).allowed, false);
  assert.equal(isAllowed(file, at('/c')).allowed, true, '* no longer applies to us');
  const parsed = parseRobots(file);
  assert.equal(parsed.groups.length, 3);
  assert.deepEqual(parsed.groups[1].agents, ['OtherBot', 'MugBot']);
});

test('parsing: comments, a BOM, CRLF, rules before any group, empty Disallow, sitemaps', () => {
  const bom = String.fromCharCode(0xfeff);
  const file = `${bom}Disallow: /ignored\r\n# a comment\r\nUser-agent: * # everyone\r\nDisallow: /cart # no carts\r\nDisallow:\r\nSitemap: https://shop.example/sitemap.xml\r\n`;
  const parsed = parseRobots(file);
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.groups[0].rules.length, 1, 'the empty Disallow disallows nothing');
  assert.deepEqual(parsed.sitemaps, ['https://shop.example/sitemap.xml']);
  assert.equal(isAllowed(file, at('/ignored')).allowed, true, 'a rule before any user-agent line binds nobody');
  assert.equal(isAllowed(file, at('/cart')).allowed, false);
  assert.equal(isAllowed('User-agent: *\nDisallow:\n', at('/anything')).allowed, true);
});

test('longest match wins, counted in octets of the pattern', () => {
  const file = 'User-agent: *\nDisallow: /\nAllow: /p\n';
  assert.equal(isAllowed(file, at('/page')).allowed, true, 'Allow /p is longer than Disallow /');
  assert.equal(isAllowed(file, at('/x')).allowed, false);
  const html = 'User-agent: *\nAllow: /page\nDisallow: /*.html\n';
  assert.deepEqual(isAllowed(html, at('/page.html')), { allowed: false, rule: 'Disallow: /*.html' }, '/*.html has more octets than /page');
  assert.equal(isAllowed(html, at('/page')).allowed, true);
  const root = 'User-agent: *\nAllow: /$\nDisallow: /\n';
  assert.equal(isAllowed(root, at('/')).allowed, true);
  assert.equal(isAllowed(root, at('/page.htm')).allowed, false);
});

test('Allow wins a tie', () => {
  const file = 'User-agent: *\nDisallow: /folder\nAllow: /folder\n';
  assert.deepEqual(isAllowed(file, at('/folder/page')), { allowed: true, rule: 'Allow: /folder' });
  const reversed = 'User-agent: *\nAllow: /folder\nDisallow: /folder\n';
  assert.equal(isAllowed(reversed, at('/folder/page')).allowed, true, 'order in the file does not matter');
});

test('wildcards and the end anchor', () => {
  const fish = 'User-agent: *\nDisallow: /fish*.php\n';
  assert.equal(isAllowed(fish, at('/fish.php')).allowed, false);
  assert.equal(isAllowed(fish, at('/fishheads/catfish.php?parameters')).allowed, false);
  assert.equal(isAllowed(fish, at('/Fish.PHP')).allowed, true, 'paths are case-sensitive');

  const php = 'User-agent: *\nDisallow: /*.php$\n';
  assert.equal(isAllowed(php, at('/filename.php')).allowed, false);
  assert.equal(isAllowed(php, at('/folder/filename.php')).allowed, false);
  assert.equal(isAllowed(php, at('/filename.php?parameters')).allowed, true, '$ anchors the end of path and query');
  assert.equal(isAllowed(php, at('/filename.php/')).allowed, true);

  const star = 'User-agent: *\nDisallow: *\n';
  assert.equal(isAllowed(star, at('/anything')).allowed, false, 'a pattern may start with *');
  const multi = 'User-agent: *\nDisallow: /a*b*c$\n';
  assert.equal(isAllowed(multi, at('/abcbc')).allowed, false);
  assert.equal(isAllowed(multi, at('/acb')).allowed, true);
  const anyEnd = 'User-agent: *\nDisallow: /a*$\n';
  assert.equal(isAllowed(anyEnd, at('/abc')).allowed, false);
});

test('query strings are part of the matched path (Shopify-style sort rules)', () => {
  const file = [
    'User-agent: *',
    'Disallow: /collections/*sort_by*',
    'Disallow: /collections/*%2b*',
    'Disallow: /*?*oseid=*',
  ].join('\n');
  assert.equal(isAllowed(file, at('/collections/mugs?sort_by=price')).allowed, false);
  assert.equal(isAllowed(file, at('/collections/mugs')).allowed, true);
  assert.equal(isAllowed(file, at('/collections/mugs%2Bcups')).allowed, false, 'escapes compare case-insensitively');
  assert.equal(isAllowed(file, at('/products/x?oseid=1')).allowed, false);
});

test('percent-encoding: unreserved escapes decode, non-ASCII encodes, on both sides', () => {
  assert.equal(normalizePath('/foo/bar/%62%61%7A'), '/foo/bar/baz');
  assert.equal(normalizePath('/a%2fb'), '/a%2Fb', 'a reserved escape stays escaped, uppercased');
  const kana = String.fromCharCode(0x30c4);
  assert.equal(normalizePath(`/foo/bar/${kana}`), '/foo/bar/%E3%83%84');
  const file = `User-agent: *\nDisallow: /foo/bar/${kana}\nDisallow: /%62az\n`;
  assert.equal(isAllowed(file, at('/foo/bar/%E3%83%84')).allowed, false);
  assert.equal(isAllowed(file, at('/baz')).allowed, false);
  assert.equal(isAllowed(file, at('/qux')).allowed, true);
});

test('a hostile pattern cannot make the matcher crawl', () => {
  const pattern = `/${'a*'.repeat(2000)}b`;
  const file = `User-agent: *\nDisallow: ${pattern}\n`;
  const started = performance.now();
  const verdict = isAllowed(file, at(`/${'a'.repeat(5000)}`));
  assert.equal(verdict.allowed, true);
  assert.ok(performance.now() - started < 200, 'linear, not backtracking');
});

test('fetch outcomes: 4xx allows, 5xx and timeouts disallow for now, /robots.txt is always allowed', () => {
  const missing = robotsPolicy({ status: 404 });
  assert.equal(robotsVerdict(missing, at('/anything')).allowed, true);
  assert.match(robotsVerdict(missing, at('/anything')).rule, /404/);
  assert.equal(robotsVerdict(robotsPolicy({ status: 403 }), at('/x')).allowed, true, 'a refused robots.txt is "unavailable": allowed');
  assert.equal(robotsVerdict(robotsPolicy({ status: 429 }), at('/x')).allowed, true, '429 is a 4xx under RFC 9309');
  const down = robotsPolicy({ status: 503 });
  assert.equal(robotsVerdict(down, at('/x')).allowed, false);
  assert.match(robotsVerdict(down, at('/x')).rule, /503.*for now/);
  assert.equal(robotsVerdict(robotsPolicy({ error: 'timeout' }), at('/x')).allowed, false);
  assert.equal(robotsVerdict(robotsPolicy({ error: 'network', detail: 'ECONNRESET' }), at('/x')).allowed, false);
  assert.equal(robotsVerdict(robotsPolicy({ error: 'redirects' }), at('/x')).allowed, true, 'too many redirects counts as unavailable');
  assert.equal(robotsVerdict(down, at('/robots.txt')).allowed, true);
  const everything = robotsPolicy({ status: 200, text: 'User-agent: *\nDisallow: /\n' });
  assert.equal(robotsVerdict(everything, at('/robots.txt')).allowed, true);
});
