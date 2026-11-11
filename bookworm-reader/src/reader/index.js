// Picks the reader for a book: PDFs go to the PDF.js reader, every other format to
// the book reader. Each is loaded on demand so neither costs anything until used.

import { bookCache, formatOf } from '../lib/books.js';
import { db } from '../lib/db.js';
import { getFileMeta } from '../lib/drive.js';
import { getProgress } from '../lib/progress.js';

async function formatFor(source, fileId) {
  const id = `${source}:${fileId}`;
  const cached = bookCache.get(id);
  if (cached) return cached.format;
  try {
    if (source === 'local') {
      const record = await db.get('files', fileId);
      return record ? record.format || formatOf(record.name, record.blob?.type) : 'pdf';
    }
    const saved = await getProgress(id);
    if (saved?.name) return saved.format || formatOf(saved.name);
    return (await getFileMeta(fileId)).format; // also puts the book in the cache
  } catch {
    return 'pdf'; // the PDF reader shows the proper error (reconnect, missing file...)
  }
}

export function mountReader(root, params) {
  let destroyed = false;
  let inner = null;
  formatFor(params.source, params.fileId).then(async (format) => {
    if (destroyed) return;
    const module = format === 'pdf' ? await import('./reader.js') : await import('./bookReader.js');
    if (destroyed) return;
    inner = module.mountReader(root, params);
  });
  return function destroy() {
    destroyed = true;
    inner?.();
  };
}
