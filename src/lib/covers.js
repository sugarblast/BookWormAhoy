// Cover thumbnails: rendered from page 1 of each PDF, cached in IndexedDB.
//
// Jobs run two at a time so a big Drive does not saturate the connection. The
// PDF engine is imported lazily on the first job. Cached covers are reused
// until the file's modified time changes.

import { db } from './db.js';

const MAX_CONCURRENT = 2;
const queue = [];
const failed = new Set();
let running = 0;

/**
 * Resolves to a cover Blob, or null if one cannot be made (encrypted, broken,
 * cancelled). Rejects with AuthError when Drive needs reconnecting.
 * `token.cancelled = true` skips the job if it has not started yet.
 */
export function requestCover(book, token = { cancelled: false }) {
  return new Promise((resolve, reject) => {
    queue.push({ book, token, resolve, reject });
    pump();
  });
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    if (job.token.cancelled) {
      job.resolve(null);
      continue;
    }
    running++;
    run(job)
      .then(job.resolve, job.reject)
      .finally(() => {
        running--;
        pump();
      });
  }
}

async function run({ book, token }) {
  try {
    const cached = await db.get('covers', book.id);
    if (cached?.blob && (!book.modified || !cached.version || cached.version === book.modified)) {
      return cached.blob;
    }
  } catch {
    /* cache unreadable: render fresh */
  }
  if (failed.has(book.id) || token.cancelled) return null;

  try {
    const { openBook, renderCover } = await import('./pdfdoc.js');
    const { pdf, task } = await openBook(book, { forCover: true });
    try {
      const { blob } = await renderCover(pdf);
      try {
        await db.put('covers', { id: book.id, version: book.modified, blob });
      } catch {
        /* storage full: the cover still shows this session */
      }
      return blob;
    } finally {
      task.destroy();
    }
  } catch (error) {
    if (error?.name === 'AuthError') throw error;
    failed.add(book.id);
    return null;
  }
}

export async function forgetCover(bookId) {
  failed.delete(bookId);
  try {
    await db.delete('covers', bookId);
  } catch {
    /* nothing cached */
  }
}
