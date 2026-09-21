// ── What an image is, from its first bytes ───────────────────────────────────
//
// C4.2: an R2 key's extension comes from the bytes, never from the URL or the
// Content-Type a shop sent, and width and height are read from the file
// header, never decoded (a free-plan Worker has no CPU for decoding). Five
// types are accepted: jpg, png, gif, webp and avif. Anything else, SVG
// included, is not an image as far as Mug is concerned. Plain ES module, no
// dependencies: the Worker, the runner and the admin page share it.

export const IMAGE_TYPES = Object.freeze({
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
});

function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(0);
}

function ascii(b, at, length) {
  if (at < 0 || at + length > b.length) return '';
  let out = '';
  for (let i = at; i < at + length; i++) out += String.fromCharCode(b[i]);
  return out;
}

function u16be(b, at) {
  return at + 2 <= b.length ? (b[at] << 8) | b[at + 1] : undefined;
}

function u16le(b, at) {
  return at + 2 <= b.length ? b[at] | (b[at + 1] << 8) : undefined;
}

function u24le(b, at) {
  return at + 3 <= b.length ? b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) : undefined;
}

function u32be(b, at) {
  return at + 4 <= b.length ? ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3] : undefined;
}

function sized(w, h) {
  return Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 ? { w, h } : {};
}

function png(b) {
  if (!(b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)) return null;
  return ascii(b, 12, 4) === 'IHDR' ? sized(u32be(b, 16), u32be(b, 20)) : {};
}

function gif(b) {
  const sig = ascii(b, 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  return sized(u16le(b, 6), u16le(b, 8));
}

// SOFn markers carry the frame size; C4, C8 and CC are other tables.
function isStartOfFrame(marker) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpeg(b) {
  if (!(b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return {};
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // markers without a length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return {}; // end of image, or scan data before any frame header
    const length = u16be(b, i + 2);
    if (length === undefined || length < 2) return {};
    if (isStartOfFrame(marker)) return sized(u16be(b, i + 7), u16be(b, i + 5));
    i += 2 + length;
  }
  return {};
}

function webp(b) {
  if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ') {
    if (!(b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)) return {};
    const w = u16le(b, 26);
    const h = u16le(b, 28);
    return w === undefined || h === undefined ? {} : sized(w & 0x3fff, h & 0x3fff);
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f || b.length < 25) return {};
    const w = 1 + (((b[22] & 0x3f) << 8) | b[21]);
    const h = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6));
    return sized(w, h);
  }
  if (chunk === 'VP8X') {
    const w = u24le(b, 24);
    const h = u24le(b, 27);
    return w === undefined || h === undefined ? {} : sized(w + 1, h + 1);
  }
  return {};
}

// ISO BMFF boxes: [start, end, type, headerSize] for each child of a range.
function boxes(b, start, end) {
  const out = [];
  let at = start;
  while (at + 8 <= end) {
    let size = u32be(b, at);
    const type = ascii(b, at + 4, 4);
    let header = 8;
    if (size === 1) {
      const high = u32be(b, at + 8);
      const low = u32be(b, at + 12);
      if (high === undefined || low === undefined || high !== 0) break;
      size = low;
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    out.push({ start: at, end: at + size, type, header });
    at += size;
  }
  return out;
}

function avif(b) {
  if (ascii(b, 4, 4) !== 'ftyp') return null;
  const ftypSize = u32be(b, 0);
  if (!ftypSize || ftypSize < 16 || ftypSize > b.length) return null;
  const brands = [ascii(b, 8, 4)];
  for (let at = 16; at + 4 <= ftypSize; at += 4) brands.push(ascii(b, at, 4));
  if (!brands.includes('avif') && !brands.includes('avis')) return null;
  // meta (a full box: 4 bytes of version and flags) > iprp > ipco > ispe.
  // The largest ispe is the primary image; smaller ones are thumbnails.
  let best = {};
  for (const meta of boxes(b, 0, b.length).filter((x) => x.type === 'meta')) {
    for (const iprp of boxes(b, meta.start + meta.header + 4, meta.end).filter((x) => x.type === 'iprp')) {
      for (const ipco of boxes(b, iprp.start + iprp.header, iprp.end).filter((x) => x.type === 'ipco')) {
        for (const ispe of boxes(b, ipco.start + ipco.header, ipco.end).filter((x) => x.type === 'ispe')) {
          const dims = sized(u32be(b, ispe.start + ispe.header + 4), u32be(b, ispe.start + ispe.header + 8));
          if (dims.w && (!best.w || dims.w * dims.h > best.w * best.h)) best = dims;
        }
      }
    }
  }
  return best;
}

const READERS = [['png', png], ['jpg', jpeg], ['gif', gif], ['webp', webp], ['avif', avif]];

/**
 * { ext, contentType, w?, h? } for a jpg, png, gif, webp or avif, or null for
 * anything else. Width and height are omitted when the header does not say.
 */
export function sniffImage(input) {
  const b = bytesOf(input);
  if (b.length < 12) return null;
  for (const [ext, read] of READERS) {
    const found = read(b);
    if (found) return { ext, contentType: IMAGE_TYPES[ext], ...found };
  }
  return null;
}

/** The Content-Type for a C4.2 extension, or null. */
export function contentTypeFor(ext) {
  return IMAGE_TYPES[String(ext || '').toLowerCase()] || null;
}
