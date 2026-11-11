// Opens any supported book format and returns one common shape:
//
//   {
//     format, fixed,                       fixed = comic pages (one image per page)
//     metadata: { title, author, language },
//     sections: [{ index, size }],         reading order; size weights progress
//     outline:  { tree, flat },            nodes: { title, depth, parent, children, target: { index, fragment } | null }
//     load(index) -> { css, bodyHtml, bodyClass, bodyId, lang, dir, text, revoke() }
//     resolveLink(fromIndex, path, fragment) -> { index, fragment } | null   (optional)
//     locate(path, fragment) -> { index, fragment } | null                    (optional)
//     cover() -> Promise<Blob | null>
//     destroy()
//   }

import { BookError } from './errors.js';
import { toCoverBlob } from './util.js';

export { BookError };

export async function openEbook(blob, format, fileName = '') {
  switch (format) {
    case 'epub':
      return (await import('./epub.js')).openEpub(blob);
    case 'fb2':
      return (await import('./fb2.js')).openFb2(blob, fileName);
    case 'cbz':
      return (await import('./cbz.js')).openCbz(blob);
    case 'txt':
      return (await import('./txt.js')).openTxt(blob, fileName);
    case 'mobi':
      return (await import('./mobi.js')).openMobi(blob, fileName);
    default:
      throw new BookError('Bookworm cannot open this kind of file.', 'unsupported');
  }
}

/** A shelf-sized cover JPEG for a book blob, or null when it has no usable cover image. */
export async function coverFor(blob, format, fileName = '') {
  const book = await openEbook(blob, format, fileName);
  try {
    const raw = await book.cover();
    return raw ? await toCoverBlob(raw) : null;
  } finally {
    book.destroy();
  }
}

/** The page of a book that holds `path#fragment`, resolved from the section `fromIndex`. */
export function resolveLink(book, fromIndex, path, fragment) {
  if (book.resolveLink) {
    const found = book.resolveLink(fromIndex, path, fragment);
    if (found) return found;
  }
  if (!path) return { index: fromIndex, fragment };
  return book.locate?.(path, fragment) ?? null;
}
