// How much room this site has in the browser, and a request to keep it.
//
// Books added from the device or Dropbox are copied into the browser's own
// storage (IndexedDB). Books picked from Google Drive are not: only their
// covers are kept. Browsers set a quota per site, and `navigator.storage`
// reports an estimate of it.

import { db } from './db.js';
import { formatBytes } from './dom.js';

const size = (bytes) => formatBytes(bytes) || '0 B';

export class StorageFullError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageFullError';
  }
}

async function estimate() {
  try {
    const { usage = 0, quota = 0 } = (await navigator.storage?.estimate?.()) ?? {};
    return quota > 0 ? { usage, quota, free: Math.max(0, quota - usage) } : null;
  } catch {
    return null;
  }
}

/** What Bookworm itself keeps: the PDFs copied here and the small cover images. */
async function ownBytes() {
  try {
    const [files, covers] = await Promise.all([db.all('files'), db.all('covers')]);
    return {
      books: files.reduce((sum, file) => sum + (file.size || file.blob?.size || 0), 0),
      covers: covers.reduce((sum, cover) => sum + (cover.blob?.size || 0), 0),
      bookCount: files.length,
    };
  } catch {
    return { books: 0, covers: 0, bookCount: 0 };
  }
}

export async function getStorage() {
  const room = await estimate();
  if (!room) return { supported: false };
  let persisted = false;
  try {
    persisted = (await navigator.storage.persisted?.()) ?? false;
  } catch {
    /* unknown */
  }
  return { supported: true, ...room, persisted, own: await ownBytes() };
}

/** Asks the browser not to clear this site's files when the disk gets full. */
export async function requestPersistence() {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** Throws a plain-language error when `bytes` clearly will not fit. Unknown quota never blocks. */
export async function assertRoom(bytes, name) {
  const room = await estimate();
  if (!room) return;
  const margin = 8 * 1024 * 1024;
  if (bytes + margin > room.free) {
    throw new StorageFullError(
      `"${name}" is ${size(bytes)} but this browser only has about ${size(room.free)} left for Bookworm. Take some books off the shelf with the ✕ button, or open it from Google Drive instead.`,
    );
  }
}
