// Image type and size from header bytes only, on tiny synthetic headers:
// nothing here is a real picture, just the bytes each format starts with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentTypeFor, sniffImage } from '../shared/images/sniff.js';
import { fixture } from './fixtures/fakes.mjs';

const ascii = (s) => [...s].map((ch) => ch.charCodeAt(0));
const u16be = (n) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n) => [n & 0xff, (n >> 8) & 0xff];
const u24le = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32be = (n) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const bytes = (...parts) => new Uint8Array(parts.flat());

function box(type, ...payload) {
  const body = payload.flat();
  return [...u32be(8 + body.length), ...ascii(type), ...body];
}

test('png: signature and IHDR', () => {
  const png = bytes([0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), ascii('IHDR'), u32be(640), u32be(480), [8, 6, 0, 0, 0]);
  assert.deepEqual(sniffImage(png), { ext: 'png', contentType: 'image/png', w: 640, h: 480 });
  assert.deepEqual(sniffImage(fixture('shop/img/pikachu.png', { binary: true })), { ext: 'png', contentType: 'image/png', w: 6, h: 4 });
});

test('gif: both versions, little-endian size', () => {
  assert.deepEqual(sniffImage(bytes(ascii('GIF89a'), u16le(320), u16le(200), [0, 0, 0])), { ext: 'gif', contentType: 'image/gif', w: 320, h: 200 });
  assert.equal(sniffImage(bytes(ascii('GIF87a'), u16le(1), u16le(1), [0, 0, 0])).ext, 'gif');
});

test('jpeg: walks the segments to the frame header, past APP0 and fill bytes', () => {
  const app0 = [0xff, 0xe0, ...u16be(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xff, 0xc0, ...u16be(17), 8, ...u16be(300), ...u16be(400), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  assert.deepEqual(sniffImage(bytes([0xff, 0xd8], app0, sof0)), { ext: 'jpg', contentType: 'image/jpeg', w: 400, h: 300 });
  const progressive = [0xff, 0xc2, ...u16be(17), 8, ...u16be(1080), ...u16be(1920), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  assert.deepEqual(sniffImage(bytes([0xff, 0xd8], app0, progressive)), { ext: 'jpg', contentType: 'image/jpeg', w: 1920, h: 1080 });
  const dht = [0xff, 0xc4, ...u16be(4), 0, 0];
  assert.deepEqual(sniffImage(bytes([0xff, 0xd8], dht, sof0)).w, 400, 'C4 is a table, not a frame');
  assert.deepEqual(sniffImage(bytes([0xff, 0xd8, 0xff, 0xe0], u16be(16), new Array(14).fill(0))), { ext: 'jpg', contentType: 'image/jpeg' }, 'a jpeg with no frame header yet has no size');
});

test('webp: lossy, lossless and extended', () => {
  const riff = (chunk, payload) => bytes(ascii('RIFF'), u32be(0), ascii('WEBP'), ascii(chunk), u32be(payload.length), payload);
  const vp8 = riff('VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...u16le(800), ...u16le(600), 0, 0]);
  assert.deepEqual(sniffImage(vp8), { ext: 'webp', contentType: 'image/webp', w: 800, h: 600 });
  // VP8L: 0x2f, then 14 bits of width-1 and 14 bits of height-1, little-endian bits.
  const w = 480 - 1;
  const h = 360 - 1;
  const bits = w | (h << 14);
  const vp8l = riff('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff, 0]);
  assert.deepEqual(sniffImage(vp8l), { ext: 'webp', contentType: 'image/webp', w: 480, h: 360 });
  const vp8x = riff('VP8X', [0x10, 0, 0, 0, ...u24le(1600 - 1), ...u24le(1200 - 1)]);
  assert.deepEqual(sniffImage(vp8x), { ext: 'webp', contentType: 'image/webp', w: 1600, h: 1200 });
});

test('avif: ftyp brand, and the largest ispe is the primary image', () => {
  const ftyp = box('ftyp', ascii('avif'), u32be(0), ascii('mif1'), ascii('miaf'));
  const ispe = (w, h) => box('ispe', [0, 0, 0, 0], u32be(w), u32be(h));
  const meta = box('meta', [0, 0, 0, 0], box('hdlr', [0, 0, 0, 0], u32be(0), ascii('pict'), new Array(13).fill(0)), box('iprp', box('ipco', ispe(160, 120), ispe(800, 600))));
  assert.deepEqual(sniffImage(bytes(ftyp, meta)), { ext: 'avif', contentType: 'image/avif', w: 800, h: 600 });
  const compatible = box('ftyp', ascii('mif1'), u32be(0), ascii('avif'));
  assert.deepEqual(sniffImage(bytes(compatible, new Array(8).fill(0))), { ext: 'avif', contentType: 'image/avif' }, 'avif as a compatible brand, no size yet');
});

test('not images: SVG, HTML, HEIC, BMP, random and short bytes', () => {
  assert.equal(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')), null);
  assert.equal(sniffImage(new TextEncoder().encode('<!doctype html><html><title>Just a moment...</title>')), null);
  assert.equal(sniffImage(bytes(box('ftyp', ascii('heic'), u32be(0), ascii('mif1'), ascii('heic')))), null, 'HEIC is not in the list');
  assert.equal(sniffImage(bytes(ascii('BM'), new Array(20).fill(0))), null);
  assert.equal(sniffImage(bytes(new Array(64).fill(7))), null);
  assert.equal(sniffImage(bytes([0x89, 0x50])), null);
  assert.equal(sniffImage(undefined), null);
  assert.equal(sniffImage(new ArrayBuffer(4)), null);
});

test('content types by extension', () => {
  assert.equal(contentTypeFor('jpg'), 'image/jpeg');
  assert.equal(contentTypeFor('WEBP'), 'image/webp');
  assert.equal(contentTypeFor('svg'), null);
});
