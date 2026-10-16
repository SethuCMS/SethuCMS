/**
 * Cleaning uploads before they are stored.
 *
 * Images: hidden data is cut out without touching the picture itself (the
 * pixels are not decoded or re-compressed, so quality is unchanged). That
 * removes camera and GPS data, author and software tags, comments, thumbnails
 * and anything appended after the end of the image. The one thing kept from a
 * photo's camera data is its rotation, so phone photos still show upright.
 *
 * PDFs: refused when they contain anything that can run or launch something
 * (JavaScript, launch actions, embedded files, forms that submit data, rich
 * media). This is a filter, not a guarantee: a PDF that cannot be read well
 * enough to check is refused rather than allowed.
 *
 * Anything malformed is refused. Never guess about a file we cannot parse.
 */
import { inflateSync } from 'node:zlib';
import { errors } from '@sethucms/core';

const bad = (what: string): never => {
  throw errors.validation(`The file is damaged or not valid (${what})`);
};

// ---------------------------------------------------------------- JPEG

/** The rotation (1 to 8) from a JPEG's EXIF block, or null. */
export function exifOrientation(payload: Buffer): number | null {
  // payload starts after "Exif\0\0": a TIFF header.
  if (payload.length < 8) return null;
  const little = payload[0] === 0x49 && payload[1] === 0x49;
  if (!little && !(payload[0] === 0x4d && payload[1] === 0x4d)) return null;
  const u16 = (at: number): number | null =>
    at + 2 <= payload.length ? (little ? payload.readUInt16LE(at) : payload.readUInt16BE(at)) : null;
  const u32 = (at: number): number | null =>
    at + 4 <= payload.length ? (little ? payload.readUInt32LE(at) : payload.readUInt32BE(at)) : null;
  const ifd = u32(4);
  if (ifd === null) return null;
  const count = u16(ifd);
  if (count === null || count > 512) return null;
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
      const value = u16(entry + 8);
      return value !== null && value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** A minimal EXIF segment that says only "rotation = n". */
function orientationSegment(n: number): Buffer {
  const body = Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]), // little-endian TIFF header
    Buffer.from([0x01, 0x00]), // one entry
    Buffer.from([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, n, 0x00, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // no next block
  ]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

export function cleanJpeg(bytes: Buffer): Buffer {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) bad('jpeg start');
  const out: Buffer[] = [bytes.subarray(0, 2)];
  let rotation: number | null = null;
  let pos = 2;
  let sawScan = false;
  // Where the rotation block goes: right after the start marker, or after the
  // JFIF header when there is one.
  let insertAt = 1;
  const finish = (): Buffer => {
    if (rotation !== null && rotation !== 1) {
      out.splice(insertAt, 0, orientationSegment(rotation));
    }
    return Buffer.concat(out);
  };
  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) bad('jpeg marker');
    while (bytes[pos] === 0xff) pos++; // fill bytes
    const marker = bytes[pos++];
    if (marker === undefined) bad('jpeg end');
    if (marker === 0xd9) {
      // End of image: anything after it is dropped.
      out.push(Buffer.from([0xff, 0xd9]));
      if (!sawScan) bad('jpeg without image data');
      return finish();
    }
    if (marker === 0x01 || (marker! >= 0xd0 && marker! <= 0xd7)) {
      out.push(Buffer.from([0xff, marker!]));
      continue;
    }
    if (pos + 2 > bytes.length) bad('jpeg length');
    const length = bytes.readUInt16BE(pos);
    if (length < 2 || pos + length > bytes.length) bad('jpeg length');
    const segment = bytes.subarray(pos + 2, pos + length);
    const whole = bytes.subarray(pos - 2, pos + length);
    pos += length;

    if (marker === 0xe1 && segment.subarray(0, 6).toString('latin1') === 'Exif\0\0') {
      rotation = exifOrientation(segment.subarray(6));
      continue;
    }
    const keep =
      marker === 0xe0 || // JFIF
      (marker === 0xe2 && segment.subarray(0, 12).toString('latin1') === 'ICC_PROFILE\0') ||
      marker === 0xee || // Adobe (colour transform)
      !(marker! >= 0xe1 && marker! <= 0xef) && marker !== 0xfe; // not APPn / comment
    if (marker === 0xda) {
      // Start of scan, then the compressed image data.
      out.push(Buffer.from(whole));
      sawScan = true;
      // Copy compressed data up to the next real marker.
      let end = pos;
      while (end < bytes.length) {
        if (bytes[end] === 0xff) {
          const next = bytes[end + 1];
          if (next === undefined) bad('jpeg data');
          if (next !== 0x00 && !(next! >= 0xd0 && next! <= 0xd7) && next !== 0xff) break;
          if (next === 0xff) {
            end += 1;
            continue;
          }
          end += 2;
          continue;
        }
        end++;
      }
      out.push(bytes.subarray(pos, end));
      pos = end;
      continue;
    }
    if (keep) {
      out.push(Buffer.from(whole));
      if (marker === 0xe0 && !sawScan && insertAt === 1) insertAt = out.length;
    }
  }
  return bad('jpeg without end');
}

// ----------------------------------------------------------------- PNG

const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

export function cleanPng(bytes: Buffer): Buffer {
  const out: Buffer[] = [bytes.subarray(0, 8)];
  let pos = 8;
  while (pos + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(pos);
    const type = bytes.subarray(pos + 4, pos + 8).toString('latin1');
    const total = 12 + length;
    if (length > 0x7fffffff || pos + total > bytes.length) bad('png chunk');
    if (!PNG_DROP.has(type)) out.push(bytes.subarray(pos, pos + total));
    pos += total;
    if (type === 'IEND') return Buffer.concat(out); // trailing data dropped
  }
  return bad('png without end');
}

// ----------------------------------------------------------------- GIF

export function cleanGif(bytes: Buffer): Buffer {
  const out: Buffer[] = [];
  if (bytes.length < 13) bad('gif header');
  const flags = bytes[10]!;
  let pos = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  if (pos > bytes.length) bad('gif palette');
  out.push(bytes.subarray(0, pos));
  /** Copy sub-blocks (length-prefixed) from `from`; returns the end position. */
  const blocksEnd = (from: number): number => {
    let at = from;
    for (;;) {
      const size = bytes[at];
      if (size === undefined) bad('gif block');
      at += 1 + size!;
      if (at > bytes.length) bad('gif block');
      if (size === 0) return at;
    }
  };
  while (pos < bytes.length) {
    const kind = bytes[pos];
    if (kind === 0x3b) {
      out.push(Buffer.from([0x3b]));
      return Buffer.concat(out);
    }
    if (kind === 0x21) {
      const label = bytes[pos + 1];
      const end = blocksEnd(pos + 2);
      if (label === 0xf9) {
        out.push(bytes.subarray(pos, end)); // timing and transparency
      } else if (label === 0xff) {
        const id = bytes.subarray(pos + 3, pos + 14).toString('latin1');
        if (id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0') out.push(bytes.subarray(pos, end));
      } // comments, text and other extensions are dropped
      pos = end;
    } else if (kind === 0x2c) {
      if (pos + 10 > bytes.length) bad('gif image');
      const local = bytes[pos + 9]!;
      let at = pos + 10 + (local & 0x80 ? 3 * (1 << ((local & 7) + 1)) : 0) + 1; // + LZW size byte
      if (at > bytes.length) bad('gif image');
      at = blocksEnd(at);
      out.push(bytes.subarray(pos, at));
      pos = at;
    } else {
      bad('gif block type');
    }
  }
  return bad('gif without end');
}

// ---------------------------------------------------------------- WebP

export function cleanWebp(bytes: Buffer): Buffer {
  if (bytes.length < 12) bad('webp header');
  const limit = Math.min(bytes.readUInt32LE(4) + 8, bytes.length);
  const chunks: Buffer[] = [];
  let pos = 12;
  while (pos + 8 <= limit) {
    const type = bytes.subarray(pos, pos + 4).toString('latin1');
    const size = bytes.readUInt32LE(pos + 4);
    if (pos + 8 + size > limit) bad('webp chunk');
    if (type !== 'EXIF' && type !== 'XMP ') {
      const data = Buffer.from(bytes.subarray(pos + 8, pos + 8 + size));
      if (type === 'VP8X' && data.length >= 1) {
        data[0] = data[0]! & ~(0x08 | 0x04); // clear the EXIF and XMP flags
      }
      const head = Buffer.alloc(8);
      head.write(type, 0, 'latin1');
      head.writeUInt32LE(size, 4);
      chunks.push(head, data);
      if (size & 1) chunks.push(Buffer.alloc(1)); // chunks are padded to an even length
    }
    pos += 8 + size + (size & 1);
  }
  const body = Buffer.concat(chunks);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write('WEBP', 8, 'latin1');
  return Buffer.concat([riff, body]);
}

// ----------------------------------------------------------------- PDF

// Names that can run code, open other files or send data. Matched after
// decoding "#xx" escapes in names, so "/J#61vaScript" does not slip through.
const PDF_ACTIVE = [
  'JavaScript',
  'JS',
  'Launch',
  'EmbeddedFile',
  'EmbeddedFiles',
  'RichMedia',
  'XFA',
  'SubmitForm',
  'ImportData',
  'GoToE',
  'Rendition',
  'Movie',
  'Sound',
];
const ACTIVE_NAME = new RegExp(`/(?:${PDF_ACTIVE.join('|')})(?![A-Za-z0-9])`);

const decodeNames = (text: string): string =>
  text.replace(/#([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));

const INFLATE_EACH = 16 * 1024 * 1024;
const INFLATE_TOTAL = 48 * 1024 * 1024;
const MAX_STREAMS = 4000;

export function checkPdf(bytes: Buffer): void {
  const text = bytes.toString('latin1');
  const refuse = (): never => {
    throw errors.validation(
      'This PDF contains scripts, launch actions or embedded files, which are not allowed',
    );
  };
  if (/\/Encrypt\b/.test(text)) {
    throw errors.validation('Encrypted PDFs cannot be checked, so they are not allowed');
  }
  if (ACTIVE_NAME.test(decodeNames(text))) refuse();

  // Objects inside compressed streams are invisible to the scan above, so open
  // each stream and look inside too.
  let total = 0;
  let streams = 0;
  let from = 0;
  for (;;) {
    const start = text.indexOf('stream', from);
    if (start === -1) break;
    from = start + 6;
    if (text.startsWith('endstream', start - 3)) continue; // the end of one, not the start
    let data = start + 6;
    if (text[data] === '\r') data++;
    if (text[data] === '\n') data++;
    const end = text.indexOf('endstream', data);
    if (end === -1) break;
    from = end + 9;
    if (++streams > MAX_STREAMS) {
      throw errors.validation('This PDF is too complex to check, so it is not allowed');
    }
    const dictionary = text.slice(Math.max(0, start - 400), start);
    const lastDict = dictionary.slice(dictionary.lastIndexOf('obj') + 1);
    const isObjectStream = /\/ObjStm\b/.test(decodeNames(lastDict));
    let inflated: Buffer;
    try {
      inflated = inflateSync(bytes.subarray(data, end), { maxOutputLength: INFLATE_EACH });
    } catch {
      // Not Flate data (images, fonts and so on) is fine, unless it is the
      // kind of stream that holds objects: then we cannot look inside it.
      if (isObjectStream) {
        throw errors.validation('This PDF cannot be checked, so it is not allowed');
      }
      continue;
    }
    total += inflated.length;
    if (total > INFLATE_TOTAL) {
      throw errors.validation('This PDF is too complex to check, so it is not allowed');
    }
    // Only streams that can contain objects or actions are worth reading as text.
    if (isObjectStream || inflated.length < 1_000_000) {
      if (ACTIVE_NAME.test(decodeNames(inflated.toString('latin1')))) refuse();
    }
  }
}

/** Clean an image, or check a PDF. SVG is checked elsewhere. Returns the bytes to store. */
export function cleanFile(type: string, bytes: Buffer): Buffer {
  switch (type) {
    case 'image/jpeg':
      return cleanJpeg(bytes);
    case 'image/png':
      return cleanPng(bytes);
    case 'image/gif':
      return cleanGif(bytes);
    case 'image/webp':
      return cleanWebp(bytes);
    case 'application/pdf':
      checkPdf(bytes);
      return bytes;
    default:
      return bytes;
  }
}
