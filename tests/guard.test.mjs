// The C10.3 SSRF guard: schemes, ports, credentials, internal names, and IP
// literals in every special range, including the IPv6 spellings of IPv4.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAddress, checkUrl, ipv4Blocked, ipv6Blocked, parseIPv4, parseIPv6 } from '../shared/net/guard.js';

const refused = (url, env) => {
  const r = checkUrl(url, { env });
  assert.equal(r.ok, false, `${url} should be refused`);
  assert.equal(r.code, 'URL_NOT_ALLOWED');
  return r.message;
};
const allowed = (url, env) => {
  const r = checkUrl(url, { env });
  assert.equal(r.ok, true, `${url} should be allowed: ${r.message}`);
  return r.url;
};

test('public http and https URLs pass, fragment dropped', () => {
  assert.equal(allowed('https://shop.example/products/x#reviews').href, 'https://shop.example/products/x');
  allowed('http://shop.example/');
  allowed('https://shop.example:443/', undefined);
  allowed('https://8.8.8.8/');
  allowed('https://[2001:4860:4860::8888]/');
  allowed('https://[::ffff:8.8.8.8]/', undefined);
});

test('schemes, credentials, ports and junk', () => {
  refused('ftp://shop.example/file');
  refused('file:///etc/passwd');
  refused('javascript:alert(1)');
  refused('not a url');
  assert.match(refused('https://user:secret@shop.example/'), /user name or password/);
  assert.match(refused('https://shop.example:8443/'), /default ports/);
  refused('http://shop.example:443/', undefined);
  refused(`https://shop.example/${'a'.repeat(2100)}`);
});

test('private, loopback, link-local, CGNAT and other special IPv4 literals', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '192.0.2.10', '198.18.0.1', '224.0.0.1', '255.255.255.255']) {
    refused(`http://${host}/`);
  }
  allowed('http://172.32.0.1/');
  allowed('http://100.128.0.1/');
  assert.match(refused('http://169.254.169.254/latest/meta-data/'), /link-local/);
  assert.match(refused('http://100.64.0.1/'), /CGNAT/);
});

test('IPv4 in the spellings the URL parser normalises', () => {
  refused('http://2130706433/'); // 127.0.0.1 as one number
  refused('http://0x7f.1/');
  refused('http://0177.0.0.1/');
  refused('http://127.1/');
  refused('http://0/');
});

test('IPv6 literals: loopback, mapped, NAT64, 6to4, unique-local, link-local, multicast', () => {
  for (const host of ['[::1]', '[::]', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[::ffff:7f00:1]', '[64:ff9b::a00:1]', '[2002:c0a8:101::1]', '[fc00::1]', '[fd00:ec2::254]', '[fe80::1]', '[ff02::1]', '[2001:db8::1]', '[2001::1]', '[::127.0.0.1]']) {
    refused(`http://${host}/`);
  }
  assert.match(refused('http://[::ffff:192.168.0.1]/'), /IPv4-mapped private/);
});

test('internal names: localhost, .local, .internal, metadata*, single labels', () => {
  for (const url of ['http://localhost/', 'http://LOCALHOST./', 'http://api.localhost/', 'http://printer.local/', 'http://metadata.google.internal/', 'http://metadata/', 'http://metadata.example.com/', 'http://svc.internal/', 'http://nas.home.arpa/', 'http://router.lan/', 'http://intranet/', 'http://nas/']) {
    refused(url);
  }
  assert.match(refused('http://nas/'), /single-label/);
});

test('the development switch allows 127.0.0.1 and localhost on any port, and nothing else', () => {
  const dev = { MUG_DEV_ALLOW_LOOPBACK: '1' };
  allowed('http://127.0.0.1:8899/products.json', dev);
  allowed('http://localhost:8787/health', dev);
  refused('http://127.0.0.1:8899/', {});
  refused('http://127.0.0.1:8899/', { MUG_DEV_ALLOW_LOOPBACK: 'true' });
  refused('http://127.0.0.2/', dev);
  refused('http://[::1]:8899/', dev);
  refused('http://10.0.0.1/', dev);
  refused('http://shop.example:8443/', dev);
});

test('parsers', () => {
  assert.deepEqual(parseIPv4('192.168.1.1'), [192, 168, 1, 1]);
  assert.equal(parseIPv4('256.1.1.1'), null);
  assert.equal(parseIPv4('1.2.3'), null);
  assert.deepEqual(parseIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(parseIPv6('[::ffff:1.2.3.4]'), [0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
  assert.deepEqual(parseIPv6('fe80::1%25en0'), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(parseIPv6('1::2::3'), null);
  assert.equal(parseIPv6('12345::'), null);
  assert.equal(parseIPv6('1:2:3:4:5:6:7:8:9'), null);
  assert.equal(ipv4Blocked([8, 8, 8, 8]), null);
  assert.equal(ipv4Blocked([10, 0, 0, 1]), 'private');
  assert.equal(ipv6Blocked(parseIPv6('2606:4700::1111')), null);
});

test('resolved addresses (the runner checks what a public name points at)', () => {
  assert.equal(checkAddress('93.184.215.14', { hostname: 'shop.example' }).ok, true);
  assert.match(checkAddress('10.0.0.5', { hostname: 'shop.example' }).message, /shop\.example resolves to 10\.0\.0\.5/);
  assert.equal(checkAddress('::1', { hostname: 'shop.example' }).ok, false);
  assert.equal(checkAddress('::ffff:192.168.0.10', { hostname: 'shop.example' }).ok, false);
  const dev = { MUG_DEV_ALLOW_LOOPBACK: '1' };
  assert.equal(checkAddress('127.0.0.1', { hostname: 'localhost', env: dev }).ok, true);
  assert.equal(checkAddress('::1', { hostname: 'localhost', env: dev }).ok, true);
  assert.equal(checkAddress('127.0.0.1', { hostname: 'shop.example', env: dev }).ok, false, 'a public name never gets the loopback switch');
  assert.equal(checkAddress('10.0.0.1', { hostname: 'localhost', env: dev }).ok, false);
  assert.equal(checkAddress('not-an-ip', { hostname: 'x' }).ok, false);
});
