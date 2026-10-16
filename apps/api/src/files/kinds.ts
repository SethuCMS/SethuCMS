/**
 * Which files may be stored, and a check that the bytes really are what the
 * caller says they are. The type a file is later served with comes from here,
 * never from the caller alone: a file that claims to be an image but is not one
 * is refused, so it cannot be used to slip a web page onto this address.
 */
import { errors } from '@sethucms/core';
import { cleanFile } from './clean.js';

/** Allowed types, with the extension each one is given when downloaded. */
export const FILE_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
};

/** Largest upload. Serverless hosts cap a request at about 4.5 MB. */
export const MAX_FILE_BYTES = 4_000_000;

const ascii = (bytes: Buffer, from: number, to: number): string =>
  bytes.subarray(from, to).toString('latin1');

/** The allowed type named in a Content-Type header, or null. */
export function allowedType(header: string | undefined): string | null {
  const type = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const named = type === 'image/jpg' ? 'image/jpeg' : type;
  return Object.hasOwn(FILE_TYPES, named) ? named : null;
}

/** The type the bytes themselves show (by their first bytes), or null. */
export function sniffType(bytes: Buffer): string | null {
  if (
    bytes.length > 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (/^GIF8[79]a/.test(ascii(bytes, 0, 6))) {
    return 'image/gif';
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  // The PDF header may follow up to 1 KiB of other bytes.
  if (ascii(bytes, 0, 1024).includes('%PDF-')) {
    return 'application/pdf';
  }
  const head = bytes.subarray(0, 4096).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    return 'image/svg+xml';
  }
  return null;
}

// Anything in an SVG that can run code or pull in other content.
const ACTIVE_SVG =
  /<\s*script|<\s*foreignObject|<\s*iframe|<\s*embed|<\s*object|<!ENTITY|\son[a-z]+\s*=|javascript:|data:\s*text\/html/i;

/**
 * Refuse a file whose bytes do not match its declared type, then clean it:
 * hidden data is cut out of images and PDFs with active content are refused
 * (see clean.ts). Returns the bytes that should be stored.
 * @throws A validation error.
 */
export function checkFile(declared: string, bytes: Buffer): Buffer {
  if (sniffType(bytes) !== declared) {
    throw errors.validation('The file is not a valid file of the type it claims to be');
  }
  if (declared === 'image/svg+xml') {
    if (ACTIVE_SVG.test(bytes.toString('utf8'))) {
      throw errors.validation('This SVG contains scripts or embedded content, which is not allowed');
    }
    return bytes;
  }
  return cleanFile(declared, bytes);
}

/** A file name safe to put in a header: no path, no control characters. */
export function cleanName(header: string | undefined): string {
  let name = header ?? '';
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep the raw text
  }
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').trim();
  return name.slice(0, 200) || 'file';
}

/** Content-Disposition for serving a file inline or as a download. */
export function disposition(name: string, download: boolean): string {
  const fallback = name.replace(/[^A-Za-z0-9._ -]/g, '_') || 'file';
  return `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
