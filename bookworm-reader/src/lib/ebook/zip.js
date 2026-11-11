// A small ZIP reader built on Blob slices and the browser's own inflate
// (DecompressionStream). It reads the table of contents at the end of the
// archive, then pulls out single entries on demand, so even a 300 MB comic is
// never loaded into memory whole.

import { BookError } from './errors.js';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const MAX_ENTRY_BYTES = 400 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8');

async function inflate(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new BookError('This browser is too old to open this kind of book. Update it and try again.', 'unsupported');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function openZip(blob) {
  const size = blob.size;
  if (size < 22) throw new BookError('This file is not a valid ZIP-based book.');
  const tailLength = Math.min(size, 65557);
  const tail = new DataView(await blob.slice(size - tailLength).arrayBuffer());
  let eocd = -1;
  for (let i = tailLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new BookError('This file is not a valid ZIP-based book, or it is damaged.');
  const count = tail.getUint16(eocd + 10, true);
  const directorySize = tail.getUint32(eocd + 12, true);
  const directoryOffset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw new BookError('This archive uses the ZIP64 format, which Bookworm cannot read yet.', 'unsupported');
  }
  const directory = new DataView(await blob.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer());
  const bytes = new Uint8Array(directory.buffer);

  const entries = new Map();
  const lowerNames = new Map();
  let at = 0;
  for (let n = 0; n < count && at + 46 <= directory.byteLength; n++) {
    if (directory.getUint32(at, true) !== CENTRAL) break;
    const flags = directory.getUint16(at + 8, true);
    const method = directory.getUint16(at + 10, true);
    const compressed = directory.getUint32(at + 20, true);
    const uncompressed = directory.getUint32(at + 24, true);
    const nameLength = directory.getUint16(at + 28, true);
    const extraLength = directory.getUint16(at + 30, true);
    const commentLength = directory.getUint16(at + 32, true);
    const offset = directory.getUint32(at + 42, true);
    const name = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue; // folder
    entries.set(name, { name, method, compressed, size: uncompressed, offset, encrypted: Boolean(flags & 1) });
    lowerNames.set(name.toLowerCase(), name);
  }

  const find = (name) => entries.get(name) ?? entries.get(lowerNames.get(String(name).toLowerCase()));

  async function read(name) {
    const entry = find(name);
    if (!entry) throw new BookError(`The book is missing a file it refers to (${name}).`);
    if (entry.encrypted) throw new BookError('This book is encrypted and cannot be opened.', 'drm');
    if (entry.size > MAX_ENTRY_BYTES) throw new BookError('A file inside this book is too large to open in the browser.', 'unsupported');
    const header = new DataView(await blob.slice(entry.offset, entry.offset + 30).arrayBuffer());
    const dataStart = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    const raw = new Uint8Array(await blob.slice(dataStart, dataStart + entry.compressed).arrayBuffer());
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflate(raw);
    throw new BookError('This book uses a compression method Bookworm does not support.', 'unsupported');
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => Boolean(find(name)),
    sizeOf: (name) => find(name)?.size ?? 0,
    read,
    async text(name) {
      return utf8.decode(await read(name));
    },
    async blob(name, type = '') {
      return new Blob([await read(name)], { type });
    },
  };
}
