// The "book" shape shared by the shelf and the reader:
//   { id, source: 'drive' | 'local', fileId, name, title, format, size, modified }
// `format` is 'pdf', 'epub', 'mobi', 'fb2', 'cbz' or 'txt' (see formats.js).
// `id` is globally unique ("drive:<fileId>" or "local:<uuid>"); it keys
// reading progress and cover thumbnails.

import { detectFormat, stripExtension } from './formats.js';

/** Everything the app has seen this session, so the reader can find a book by id. */
export const bookCache = new Map();

export function titleFromName(name = '') {
  return stripExtension(name).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
}

/** Records saved before other formats existed have no format: they are PDFs. */
export const formatOf = (name, mime = '') => detectFormat(name, mime) ?? 'pdf';

export function driveBook(file) {
  const book = {
    id: `drive:${file.id}`,
    source: 'drive',
    fileId: file.id,
    name: file.name,
    title: titleFromName(file.name),
    // `format` is saved with the shelf entry, so a Drive file with no extension still opens as what it is
    format: file.format || formatOf(file.name, file.mimeType),
    size: Number(file.size) || 0,
    modified: file.modifiedTime || null,
  };
  bookCache.set(book.id, book);
  return book;
}

export function localBook(record) {
  const book = {
    id: `local:${record.id}`,
    source: 'local',
    origin: record.origin || 'device',
    fileId: record.id,
    name: record.name,
    title: titleFromName(record.name),
    format: record.format || formatOf(record.name),
    size: record.size || 0,
    modified: new Date(record.addedAt).toISOString(),
  };
  bookCache.set(book.id, book);
  return book;
}

/** Rebuild a minimal book from a saved progress record (e.g. Drive not connected yet). */
export function bookFromProgress(record) {
  return (
    bookCache.get(record.id) ?? {
      id: record.id,
      source: record.source,
      fileId: record.fileId,
      name: record.name,
      title: titleFromName(record.name),
      format: record.format || formatOf(record.name),
      size: record.size || 0,
      modified: null,
    }
  );
}

export const bookHref = (book) => `#/read/${book.source}/${encodeURIComponent(book.fileId)}`;
