// Uploads are cleaned before they are stored: hidden data is cut out of
// images, and PDFs with active content are refused. These tests build small
// files by hand so each rule is checked on its own.

import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { describe, it } from 'node:test';
import {
  checkPdf,
  cleanGif,
  cleanJpeg,
  cleanPng,
  cleanWebp,
  exifOrientation,
} from '../src/files/clean.js';

const text = (s: string) => Buffer.from(s, 'latin1');
const has = (bytes: Buffer, needle: string) => bytes.includes(Buffer.from(needle, 'latin1'));

// ---- JPEG
const seg = (marker: number, body: Buffer) => {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xff00 | marker, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
};
/** EXIF (big-endian) with rotation 6 and a GPS-looking pointer plus text. */
const exif = (rotation: number) => {
  const tiff = Buffer.concat([
    Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]),
    Buffer.from([0x00, 0x02]),
    Buffer.from([0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, rotation, 0x00, 0x00]),
    Buffer.from([0x88, 0x25, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x40]),
    Buffer.from([0, 0, 0, 0]),
    text('GPS-SECRET-LAT-17.38'),
  ]);
  return seg(0xe1, Buffer.concat([text('Exif\0\0'), tiff]));
};
const jpeg = (rotation = 6) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, text('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    exif(rotation),
    seg(0xe1, text('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>XMP-SECRET')),
    seg(0xfe, text('COMMENT-SECRET')),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]), // data with a stuffed FF and a restart marker
    Buffer.from([0xff, 0xd9]),
    text('TRAILING-SECRET'),
  ]);

describe('JPEG', () => {
  it('removes camera, GPS, XMP, comments and trailing data, keeps the picture', () => {
    const out = cleanJpeg(jpeg());
    for (const secret of ['GPS-SECRET', 'XMP-SECRET', 'COMMENT-SECRET', 'TRAILING-SECRET']) {
      assert.equal(has(out, secret), false, secret);
    }
    assert.ok(out.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
    assert.ok(out.subarray(out.length - 2).equals(Buffer.from([0xff, 0xd9])));
    // Compressed data, including the stuffed byte and restart marker, is untouched.
    assert.ok(out.includes(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])));
    assert.ok(has(out, 'JFIF'));
    assert.ok(out.length < jpeg().length);
  });

  it('keeps only the rotation so phone photos still show upright', () => {
    const out = cleanJpeg(jpeg(6));
    const at = out.indexOf(text('Exif\0\0'));
    assert.ok(at > 0);
    assert.equal(exifOrientation(out.subarray(at + 6)), 6);
    // Nothing else of the EXIF block is left.
    assert.equal(has(out, 'GPS'), false);
    // No rotation block when the photo is already upright.
    assert.equal(has(cleanJpeg(jpeg(1)), 'Exif'), false);
  });

  it('refuses a damaged file', () => {
    assert.throws(() => cleanJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00])));
    assert.throws(() => cleanJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))); // no image data
  });
});

// ---- PNG
const chunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4)]); // checksum left empty: the picture is not decoded
};
const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.alloc(13)),
    chunk('tEXt', text('Author\0SECRET-AUTHOR')),
    chunk('eXIf', text('PNG-EXIF-SECRET')),
    chunk('iCCP', text('keepme')),
    chunk('IDAT', text('pixels')),
    chunk('IEND', Buffer.alloc(0)),
    text('TRAILING-SECRET'),
  ]);

describe('PNG', () => {
  it('removes text, EXIF, time and trailing data, keeps the picture and colour profile', () => {
    const out = cleanPng(png());
    for (const secret of ['SECRET-AUTHOR', 'PNG-EXIF-SECRET', 'TRAILING-SECRET']) {
      assert.equal(has(out, secret), false);
    }
    assert.ok(has(out, 'pixels') && has(out, 'keepme') && has(out, 'IEND'));
  });
  it('refuses a file that never ends', () => {
    assert.throws(() => cleanPng(png().subarray(0, 60)));
  });
});

// ---- GIF
const gif = () =>
  Buffer.concat([
    text('GIF89a'),
    Buffer.from([1, 0, 1, 0, 0, 0, 0]),
    Buffer.from([0x21, 0xfe, 0x0e]), text('GIF-SECRET-CMT'), Buffer.from([0]),
    Buffer.from([0x21, 0xff, 0x0b]), text('XMP DataXMP'), Buffer.from([3]), text('abc'), Buffer.from([0]),
    Buffer.from([0x21, 0xff, 0x0b]), text('NETSCAPE2.0'), Buffer.from([3, 1, 0, 0, 0]),
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([2, 2, 0x44, 0x01, 0]),
    Buffer.from([0x3b]),
    text('TRAILING-SECRET'),
  ]);
describe('GIF', () => {
  it('removes comments, other extensions and trailing data, keeps animation settings', () => {
    const out = cleanGif(gif());
    assert.equal(has(out, 'GIF-SECRET'), false);
    assert.equal(has(out, 'XMP Data'), false);
    assert.equal(has(out, 'TRAILING-SECRET'), false);
    assert.ok(has(out, 'NETSCAPE2.0'));
    assert.equal(out[out.length - 1], 0x3b);
  });
});

// ---- WebP
const riff = (chunks: Buffer[]) => {
  const body = Buffer.concat([text('WEBP'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};
const wchunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
describe('WebP', () => {
  it('removes EXIF and XMP, clears their flags and fixes the size', () => {
    const input = riff([
      wchunk('VP8X', Buffer.from([0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
      wchunk('VP8 ', text('pixl')),
      wchunk('EXIF', text('WEBP-EXIF-SECRET')),
      wchunk('XMP ', text('WEBP-XMP-SECRET')),
    ]);
    const out = cleanWebp(input);
    assert.equal(has(out, 'SECRET'), false);
    assert.ok(has(out, 'pixl'));
    assert.equal(out[20]! & 0x0c, 0);
    assert.equal(out.readUInt32LE(4) + 8, out.length);
  });
});

// ---- PDF
const pdf = (body: string) => text(`%PDF-1.4\n${body}\n%%EOF`);
describe('PDF', () => {
  it('lets an ordinary PDF through, links included', () => {
    assert.doesNotThrow(() =>
      checkPdf(pdf('1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n3 0 obj\n<</S/URI/URI(https://example.com)>>\nendobj')),
    );
  });
  it('refuses JavaScript, launch actions and embedded files', () => {
    for (const bad of [
      '<</S/JavaScript/JS(app.alert(1))>>',
      '<</S/Launch/F(cmd.exe)>>',
      '<</Type/EmbeddedFile>>',
      '<</S/SubmitForm/F(http://x)>>',
      '<</Type/RichMedia>>',
    ]) {
      assert.throws(() => checkPdf(pdf(`1 0 obj\n${bad}\nendobj`)), /not allowed/, bad);
    }
  });
  it('sees through name obfuscation', () => {
    assert.throws(() => checkPdf(pdf('1 0 obj\n<</S/J#61vaScr#69pt>>\nendobj')), /not allowed/);
  });
  it('looks inside compressed streams', () => {
    const inner = deflateSync(text('<</S/JavaScript/JS(evil)>>'));
    const doc = Buffer.concat([
      text('%PDF-1.5\n5 0 obj\n<</Type/ObjStm/Filter/FlateDecode>>\nstream\n'),
      inner,
      text('\nendstream\nendobj\n%%EOF'),
    ]);
    assert.throws(() => checkPdf(doc), /not allowed/);
    const calm = Buffer.concat([
      text('%PDF-1.5\n5 0 obj\n<</Type/ObjStm/Filter/FlateDecode>>\nstream\n'),
      deflateSync(text('<</Type/Page>>')),
      text('\nendstream\nendobj\n%%EOF'),
    ]);
    assert.doesNotThrow(() => checkPdf(calm));
  });
  it('refuses what it cannot inspect: encrypted files and unreadable object streams', () => {
    assert.throws(() => checkPdf(pdf('trailer\n<</Encrypt 9 0 R>>')), /Encrypted/);
    const hidden = Buffer.concat([
      text('%PDF-1.5\n5 0 obj\n<</Type/ObjStm/Filter/LZWDecode>>\nstream\n'),
      Buffer.from([1, 2, 3, 4, 5]),
      text('\nendstream\nendobj\n%%EOF'),
    ]);
    assert.throws(() => checkPdf(hidden), /cannot be checked/);
  });
  it('lets compressed pictures and fonts through', () => {
    const doc = Buffer.concat([
      text('%PDF-1.4\n7 0 obj\n<</Type/XObject/Subtype/Image/Filter/DCTDecode>>\nstream\n'),
      Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22]),
      text('\nendstream\nendobj\n%%EOF'),
    ]);
    assert.doesNotThrow(() => checkPdf(doc));
  });
});
