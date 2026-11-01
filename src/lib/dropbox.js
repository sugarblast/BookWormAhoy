// "Dropbox" source: Dropbox's Chooser window picks the PDFs, then each one is
// downloaded into this browser (the Chooser's links expire after a few hours,
// so there is nothing to keep a reference to). Needs a Dropbox app key.

import { getDropboxKey } from '../config.js';

const SCRIPT_SRC = 'https://www.dropbox.com/static/api/2/dropins.js';

export class DropboxError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DropboxError';
    this.code = code;
  }
}

let loading = null;

/** Loads Dropbox's script once. Call it before the click so the Chooser window can open inside the click. */
export function preloadDropbox() {
  if (window.Dropbox?.choose) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const fail = () => {
      loading = null;
      reject(new DropboxError('Could not load Dropbox. Check your connection or content blocker.', 'load'));
    };
    const script = document.createElement('script');
    script.id = 'dropboxjs';
    script.src = SCRIPT_SRC;
    script.async = true;
    script.dataset.appKey = getDropboxKey();
    script.onload = () => (window.Dropbox?.choose ? resolve() : fail());
    script.onerror = () => {
      script.remove();
      fail();
    };
    document.head.append(script);
  });
  loading.catch(() => {});
  return loading;
}

function openChooser() {
  return new Promise((resolve) => {
    window.Dropbox.choose({
      linkType: 'direct',
      multiselect: true,
      extensions: ['.pdf'],
      folderselect: false,
      success: (files) => resolve(files.filter((file) => !file.isDir).map(({ name, link, bytes }) => ({ name, link, bytes: Number(bytes) || 0 }))),
      cancel: () => resolve([]),
    });
  });
}

/** Opens Dropbox's file window; resolves with the chosen PDFs ([] if cancelled). */
export function chooseFromDropbox() {
  // Already loaded: open synchronously so the browser counts it as part of the click.
  if (window.Dropbox?.choose) return openChooser();
  return preloadDropbox().then(openChooser);
}

/** Downloads one chosen file into a Blob, reporting progress as 0..1. */
export async function downloadFromDropbox(file, { onProgress } = {}) {
  let response;
  try {
    response = await fetch(file.link);
  } catch {
    throw new DropboxError('Dropbox did not let the browser download this file. Download it from Dropbox and add it with "This device" instead.', 'network');
  }
  if (!response.ok) throw new DropboxError(`Dropbox answered ${response.status}. Try choosing the file again.`, 'http');
  const total = Number(response.headers.get('content-length')) || file.bytes || 0;
  const chunks = [];
  let received = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (total) onProgress?.(Math.min(1, received / total));
    }
  } else {
    chunks.push(new Uint8Array(await response.arrayBuffer()));
  }
  const blob = new Blob(chunks, { type: 'application/pdf' });
  if ((await blob.slice(0, 5).text()) !== '%PDF-') throw new DropboxError('This file does not look like a PDF.', 'invalid');
  onProgress?.(1);
  return blob;
}
