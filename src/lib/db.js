// IndexedDB wrapper. Four object stores, all keyed by `id`:
//   progress  last page read per book
//   covers    generated cover thumbnails (Blobs)
//   files     PDFs opened from this device (Blobs)
//   meta      small cached values, e.g. the last Drive listing
//
// If IndexedDB is unavailable (some private-browsing modes) everything falls
// back to in-memory maps so the app still works for the current session.

const NAME = 'bookworm';
const VERSION = 1;
const STORES = ['progress', 'covers', 'files', 'meta'];

const memory = Object.fromEntries(STORES.map((store) => [store, new Map()]));
let connection = null;
let useMemory = false;

function open() {
  if (useMemory) return Promise.resolve(null);
  connection ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(NAME, VERSION);
      request.onupgradeneeded = () => {
        for (const store of STORES) {
          if (!request.result.objectStoreNames.contains(store)) {
            request.result.createObjectStore(store, { keyPath: 'id' });
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        useMemory = true;
        resolve(null);
      };
    } catch {
      useMemory = true;
      resolve(null);
    }
  });
  return connection;
}

function inMemory(store, op, arg) {
  const map = memory[store];
  if (op === 'get') return map.get(arg);
  if (op === 'put') {
    map.set(arg.id, arg);
    return arg.id;
  }
  if (op === 'delete') return void map.delete(arg);
  return [...map.values()];
}

async function run(store, mode, op, arg) {
  const conn = await open();
  if (!conn) return inMemory(store, op, arg);
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(store, mode);
    const os = tx.objectStore(store);
    const request =
      op === 'get' ? os.get(arg) : op === 'put' ? os.put(arg) : op === 'delete' ? os.delete(arg) : os.getAll();
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const db = {
  get: (store, id) => run(store, 'readonly', 'get', id),
  put: (store, value) => run(store, 'readwrite', 'put', value),
  delete: (store, id) => run(store, 'readwrite', 'delete', id),
  all: (store) => run(store, 'readonly', 'all'),
};
