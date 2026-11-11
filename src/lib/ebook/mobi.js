// MOBI and PRC (Mobipocket, the classic Kindle format), the MOBI 6 flavour: a Palm
// database of PalmDOC-compressed HTML plus image records.
//
// Not supported, with a clear message: DRM, KF8-only files (AZW3), and the rare
// HUFF/CDIC compression. Chapters are the parts between <mbp:pagebreak/> tags; very
// long parts are cut at paragraph ends so each page of the reader stays quick.

import { BookError } from './errors.js';
import { prepareChapter } from './html.js';
import { buildOutline } from './util.js';

const TARGET_SECTION = 70_000;
const MAX_SECTION = 140_000;
const CHAPTER_PATH = 'mobi/text.html';
const IMAGE_PREFIX = 'mobi/mobi-image/';
const PAGEBREAK = /<mbp:pagebreak\b[^>]*>/gi;

const ascii = (bytes, at, length) => String.fromCharCode(...bytes.subarray(at, at + length));

/** Bytes to a string with one character per byte, so offsets in the book's own markup stay valid. */
function binaryString(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

function palmDecompress(input) {
  const out = new Uint8Array(Math.max(4096 * 2, input.length * 8));
  let buffer = out;
  let length = 0;
  const ensure = (extra) => {
    if (length + extra <= buffer.length) return;
    const bigger = new Uint8Array(Math.max(buffer.length * 2, length + extra));
    bigger.set(buffer.subarray(0, length));
    buffer = bigger;
  };
  let i = 0;
  while (i < input.length) {
    const c = input[i++];
    if (c === 0 || (c >= 0x09 && c <= 0x7f)) {
      ensure(1);
      buffer[length++] = c;
    } else if (c <= 0x08) {
      ensure(c);
      for (let n = 0; n < c && i < input.length; n++) buffer[length++] = input[i++];
    } else if (c >= 0xc0) {
      ensure(2);
      buffer[length++] = 0x20;
      buffer[length++] = c ^ 0x80;
    } else {
      const pair = (c << 8) | (input[i++] ?? 0);
      const distance = (pair >> 3) & 0x7ff;
      const count = (pair & 7) + 3;
      if (!distance || distance > length) continue; // damaged back-reference: skip it
      ensure(count);
      for (let n = 0; n < count; n++) {
        buffer[length] = buffer[length - distance];
        length++;
      }
    }
  }
  return buffer.slice(0, length);
}

/** How many bytes at the end of a text record are bookkeeping, not text. */
function trailingSize(data, flags) {
  let trimmed = 0;
  const varintAt = (end) => {
    let value = 0;
    let shift = 0;
    for (let at = end - 1; at >= 0; at--) {
      const byte = data[at];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (byte & 0x80 || shift >= 28) break;
    }
    return value;
  };
  for (let rest = flags >> 1; rest; rest >>= 1) {
    if (rest & 1) trimmed += varintAt(data.length - trimmed);
  }
  if (flags & 1) trimmed += (data[data.length - trimmed - 1] & 3) + 1;
  return Math.min(trimmed, data.length);
}

function imageType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return '';
}

export async function openMobi(blob, fileName = '') {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const invalid = (why) => new BookError(why ?? 'This file is not a valid MOBI book, or it is damaged.');

  if (bytes.length < 90 || (ascii(bytes, 60, 8) !== 'BOOKMOBI' && ascii(bytes, 60, 8) !== 'TEXtREAd')) throw invalid();
  if (ascii(bytes, 60, 8) === 'TEXtREAd') throw invalid('This is a plain Palm document, which Bookworm does not read. Convert it to EPUB with Calibre.');

  const count = view.getUint16(76);
  if (!count || 78 + count * 8 > bytes.length) throw invalid();
  const offsets = [];
  for (let i = 0; i < count; i++) offsets.push(view.getUint32(78 + i * 8));
  offsets.push(bytes.length);
  for (let i = 0; i < offsets.length - 1; i++) if (offsets[i] > offsets[i + 1] || offsets[i] > bytes.length) throw invalid();
  const record = (i) => bytes.subarray(offsets[i], offsets[i + 1]);

  const head = record(0);
  const h = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length < 132 || ascii(head, 16, 4) !== 'MOBI') throw invalid('This file has no MOBI header, so Bookworm cannot read it.');

  const compression = h.getUint16(0);
  const textRecords = h.getUint16(8);
  const encryption = h.getUint16(12);
  const headerLength = h.getUint32(20);
  const encodingCode = h.getUint32(28);
  const version = h.getUint32(36);
  const fullNameAt = h.getUint32(84);
  const fullNameLength = h.getUint32(88);
  const firstImage = h.getUint32(108);
  const exthFlags = h.getUint32(128);
  const extraFlags = headerLength >= 0xe4 && head.length >= 0xf4 ? h.getUint32(0xf0) & 0xffff : 0;

  if (encryption !== 0) throw new BookError('This book is protected by DRM (copy protection), so Bookworm cannot open it.', 'drm');
  if (version >= 8) {
    throw new BookError('This Kindle book uses the newer KF8 format (AZW3), which is not supported yet. Convert it to EPUB with the free Calibre app and add that instead.', 'unsupported');
  }
  if (compression !== 1 && compression !== 2) {
    throw new BookError('This MOBI uses an old compression method that Bookworm cannot read. Convert it to EPUB with the free Calibre app and add that instead.', 'unsupported');
  }

  const encoding = encodingCode === 65001 ? 'utf-8' : 'windows-1252';
  const decode = (slice) => new TextDecoder(encoding).decode(slice);
  const decodeBinary = (text) => decode(Uint8Array.from(text, (c) => c.charCodeAt(0)));

  // ---- metadata -----------------------------------------------------------
  const metadata = { title: '', author: '', language: '' };
  if (fullNameAt && fullNameLength && fullNameAt + fullNameLength <= head.length) metadata.title = decode(head.subarray(fullNameAt, fullNameAt + fullNameLength)).trim();
  let coverOffset = -1;
  const exthAt = 16 + headerLength;
  if (exthFlags & 0x40 && exthAt + 12 <= head.length && ascii(head, exthAt, 4) === 'EXTH') {
    const total = h.getUint32(exthAt + 8);
    const authors = [];
    let at = exthAt + 12;
    for (let n = 0; n < total && at + 8 <= head.length; n++) {
      const type = h.getUint32(at);
      const size = h.getUint32(at + 4);
      if (size < 8 || at + size > head.length) break;
      const data = head.subarray(at + 8, at + size);
      if (type === 100) authors.push(decode(data).trim());
      else if (type === 503) metadata.title = decode(data).trim() || metadata.title;
      else if (type === 524) metadata.language = decode(data).trim();
      else if (type === 201 && data.length === 4) coverOffset = new DataView(data.buffer, data.byteOffset, 4).getUint32(0);
      at += size;
    }
    metadata.author = authors.filter(Boolean).join(', ');
  }
  if (!metadata.title) metadata.title = fileName.replace(/\.(mobi|prc)$/i, '');

  // ---- text -----------------------------------------------------------------
  const pieces = [];
  let total = 0;
  for (let i = 1; i <= textRecords && i < count; i++) {
    let data = record(i);
    data = data.subarray(0, data.length - trailingSize(data, extraFlags));
    const text = compression === 2 ? palmDecompress(data) : data.slice();
    pieces.push(text);
    total += text.length;
  }
  if (!total) throw invalid('This MOBI book has no text.');
  const textBytes = new Uint8Array(total);
  let writeAt = 0;
  for (const piece of pieces) {
    textBytes.set(piece, writeAt);
    writeAt += piece.length;
  }
  const raw = binaryString(textBytes);

  // ---- sections: the parts between page breaks, long ones cut at paragraph ends ----
  const spans = [];
  let from = 0;
  const cut = (start, end) => {
    let begin = start;
    while (end - begin > MAX_SECTION) {
      const boundary = /<\/(?:p|div|h[1-6]|blockquote)>|<br\s*\/?>/gi;
      boundary.lastIndex = begin + TARGET_SECTION;
      const match = boundary.exec(raw);
      const at = match ? match.index + match[0].length : -1;
      if (at < 0 || at >= end || at - begin > MAX_SECTION * 1.5) break;
      spans.push({ start: begin, end: at });
      begin = at;
    }
    spans.push({ start: begin, end });
  };
  for (const match of raw.matchAll(PAGEBREAK)) {
    cut(from, match.index);
    from = match.index + match[0].length;
  }
  cut(from, raw.length);
  const hasContent = (span) => /<img\b|<hr\b/i.test(raw.slice(span.start, span.end)) || raw.slice(span.start, span.end).replace(/<[^>]*>/g, '').trim().length > 0;
  const sections = spans.filter(hasContent);
  if (!sections.length) throw invalid('This MOBI book has no text.');
  sections.forEach((span, index) => (span.index = index));

  /** Which section holds a byte offset of the original text (an offset inside a page break belongs to the next section). */
  function sectionOf(offset) {
    let low = 0;
    let high = sections.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (sections[mid].start <= offset) low = mid;
      else high = mid - 1;
    }
    const found = sections[low];
    // Past the end of that section means inside a page break: it belongs to the next one.
    return offset >= found.end && found.index + 1 < sections.length ? sections[found.index + 1] : found;
  }

  // Every byte offset a link points to gets an anchor in the section that holds it.
  const targets = new Set();
  for (const match of raw.matchAll(/filepos\s*=\s*["']?0*(\d+)/gi)) targets.add(Number(match[1]));
  const anchorsBySection = new Map();
  for (const offset of targets) {
    if (offset > raw.length) continue;
    const span = sectionOf(offset);
    if (!anchorsBySection.has(span)) anchorsBySection.set(span, []);
    anchorsBySection.get(span).push(offset);
  }

  function sectionMarkup(span) {
    let text = raw.slice(span.start, span.end);
    const anchors = (anchorsBySection.get(span) ?? []).map((offset) => {
      let position = Math.min(Math.max(offset - span.start, 0), text.length);
      const open = text.lastIndexOf('<', position - 1);
      const close = text.lastIndexOf('>', position - 1);
      if (open > close) position = open; // inside a tag: move to just before it
      return { offset, position };
    });
    anchors.sort((a, b) => b.position - a.position);
    for (const { offset, position } of anchors) text = `${text.slice(0, position)}<a id="filepos${offset}"></a>${text.slice(position)}`;
    return text
      .replace(/<a\b([^>]*)>/gi, (whole, attributes) => {
        const target = /filepos\s*=\s*["']?0*(\d+)["']?/i.exec(attributes);
        return target ? `<a${attributes.replace(target[0], '')} href="#filepos${target[1]}">` : whole;
      })
      .replace(/<img\b([^>]*)>/gi, (whole, attributes) => {
        const index = /(?:lo)?recindex\s*=\s*["']?0*(\d+)/i.exec(attributes);
        return index ? `<img src="mobi-image/${index[1]}" alt="">` : whole; // relative to CHAPTER_PATH
      });
  }

  const imageRecord = (n) => {
    const at = firstImage + n - 1;
    if (!firstImage || at <= textRecords || at >= count) return null;
    const data = record(at);
    const type = imageType(data);
    return type ? new Blob([data], { type }) : null;
  };

  // ---- contents: the book's own contents page, or else its headings -----------------
  const items = [];
  const guide = /<reference\b[^>]*type\s*=\s*["']?toc["']?[^>]*filepos\s*=\s*["']?0*(\d+)|<reference\b[^>]*filepos\s*=\s*["']?0*(\d+)[^>]*type\s*=\s*["']?toc/i.exec(raw);
  const tocOffset = guide ? Number(guide[1] ?? guide[2]) : -1;
  if (tocOffset >= 0) {
    const tocSection = sectionOf(tocOffset);
    const markup = raw.slice(Math.max(tocOffset, tocSection.start), tocSection.end);
    for (const match of markup.matchAll(/<a\b[^>]*filepos\s*=\s*["']?0*(\d+)["']?[^>]*>([\s\S]*?)<\/a>/gi)) {
      const title = decodeBinary(match[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
      const offset = Number(match[1]);
      if (title && offset <= raw.length) items.push({ title, target: { index: sectionOf(offset).index, fragment: `filepos${offset}` } });
    }
  }
  if (items.length < 2) {
    items.length = 0;
    sections.forEach((span) => {
      const heading = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/i.exec(raw.slice(span.start, Math.min(span.end, span.start + 4000)));
      const title = heading ? decodeBinary(heading[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
      if (title) items.push({ title, target: { index: span.index, fragment: '' } });
    });
  }
  const outline = items.length >= 2 ? buildOutline(items, () => null) : { tree: [], flat: [] };

  // ---- the book object ---------------------------------------------------------------
  async function load(index) {
    const urls = [];
    const prepared = await prepareChapter(decodeBinary(sectionMarkup(sections[index])), {
      path: CHAPTER_PATH,
      mime: 'text/html',
      readStylesheet: async () => '',
      async imageUrl(path) {
        if (!path.startsWith(IMAGE_PREFIX)) return null;
        const blobValue = imageRecord(Number(path.slice(IMAGE_PREFIX.length)));
        if (!blobValue) return null;
        const url = URL.createObjectURL(blobValue);
        urls.push(url);
        return url;
      },
    });
    return { ...prepared, revoke: () => urls.forEach((url) => URL.revokeObjectURL(url)) };
  }

  return {
    format: 'mobi',
    fixed: false,
    metadata,
    sections: sections.map((span) => ({ index: span.index, size: Math.max(1, span.end - span.start) })),
    outline,
    load,
    resolveLink(fromIndex, path, fragment) {
      const match = /^filepos(\d+)$/.exec(fragment ?? '');
      if (path || !match) return null;
      return { index: sectionOf(Number(match[1])).index, fragment };
    },
    async cover() {
      if (coverOffset < 0) return null;
      return imageRecord(coverOffset + 1);
    },
    destroy() {},
  };
}
