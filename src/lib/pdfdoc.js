// Everything that touches the PDF.js core: opening a book from Drive or from
// this device, rendering a cover, and reading the table of contents.
//
// Imported lazily (dynamic import) so the shelf loads without paying for the
// PDF engine until the first cover or book is actually needed.

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { db } from './db.js';
import { ensureToken } from './auth.js';
import { mediaUrl } from './drive.js';
import { mapLimit } from './dom.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// Served from /pdfjs/ (copied there by scripts/copy-pdfjs-assets.mjs).
const asset = (folder) => new URL(`pdfjs/${folder}/`, document.baseURI).href;
const ASSET_URLS = {
  cMapUrl: asset('cmaps'),
  standardFontDataUrl: asset('standard_fonts'),
  wasmUrl: asset('wasm'),
  iccUrl: asset('iccs'),
};

export const { PasswordResponses } = pdfjs;

/**
 * pdf_viewer.mjs reads `globalThis.pdfjsLib` when it is first evaluated, so it
 * must only be imported after the core above has run. Hence the lazy import.
 */
let viewerLib;
export function loadViewerLib() {
  viewerLib ??= import('pdfjs-dist/web/pdf_viewer.mjs');
  return viewerLib;
}

async function sourceFor(book, forCover) {
  if (book.source === 'drive') {
    // A full read can run for minutes; start it with a token that will last.
    const token = await ensureToken({ minTtlMs: forCover ? 60_000 : 10 * 60_000 });
    return { url: mediaUrl(book.fileId), httpHeaders: { Authorization: `Bearer ${token}` } };
  }
  const record = await db.get('files', book.fileId);
  if (!record) throw Object.assign(new Error('This file is no longer stored in this browser.'), { name: 'MissingLocalFile' });
  return { data: new Uint8Array(await record.blob.arrayBuffer()) };
}

/**
 * Opens a book. For covers only the first page is needed, so streaming and
 * background prefetching are both switched off (PDF.js keeps downloading the
 * whole file unless both are off) and the caller destroys the task right after
 * rendering; PDF.js then uses HTTP range requests when the server allows them.
 */
export async function openBook(book, { forCover = false, onProgress, onPassword } = {}) {
  const source = await sourceFor(book, forCover);
  const task = pdfjs.getDocument({
    ...source,
    ...ASSET_URLS,
    disableAutoFetch: forCover,
    disableStream: forCover,
    verbosity: pdfjs.VerbosityLevel?.ERRORS ?? 0,
  });
  if (onProgress) task.onProgress = onProgress;
  if (onPassword) task.onPassword = (update, reason) => onPassword(update, reason, task);
  try {
    return { pdf: await task.promise, task };
  } catch (error) {
    task.destroy();
    throw error;
  }
}

export async function renderCover(pdf, cssWidth = 320) {
  const page = await pdf.getPage(1);
  const natural = page.getViewport({ scale: 1 });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: (cssWidth * ratio) / natural.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  await page.render({ canvas, viewport, background: '#ffffff' }).promise;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  page.cleanup();
  if (!blob) throw new Error('Could not encode the cover image.');
  return { blob, width: canvas.width, height: canvas.height };
}

async function destinationToPage(pdf, dest) {
  try {
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const target = explicit[0];
    if (Number.isInteger(target)) return target + 1;
    if (target && typeof target === 'object') return (await pdf.getPageIndex(target)) + 1;
  } catch {
    /* broken destination: the entry stays clickable but shows no page number */
  }
  return null;
}

/**
 * The PDF's built-in bookmarks as a tree plus a flat list in reading order.
 * Each node: { title, dest, url, depth, parent, children, page }.
 */
export async function loadOutline(pdf) {
  const raw = await pdf.getOutline();
  const flat = [];
  const walk = (items, depth, parent) =>
    items.map((item) => {
      const node = {
        title: (item.title ?? '').replace(/\s+/g, ' ').trim() || 'Untitled section',
        dest: item.dest ?? null,
        url: item.url ?? null,
        depth,
        parent,
        children: [],
        page: null,
      };
      flat.push(node);
      node.children = walk(item.items ?? [], depth + 1, node);
      return node;
    });
  const tree = walk(raw ?? [], 0, null);
  await mapLimit(flat, 8, async (node) => {
    node.page = node.dest ? await destinationToPage(pdf, node.dest) : null;
  });
  return { tree, flat };
}

/** The deepest section that has started on or before `page`. */
export function chapterFor(flat, page) {
  let best = null;
  for (const node of flat) {
    if (node.page != null && node.page <= page && (!best || node.page >= best.page)) best = node;
  }
  return best;
}

/** Turn whatever PDF.js or the network threw into something a person can act on. */
export function describeOpenError(error) {
  const name = error?.name ?? '';
  if (name === 'AuthError') return { kind: 'auth', message: error.message };
  if (name === 'PasswordException') return { kind: 'password', message: 'This PDF is password-protected and no password was entered.' };
  if (name === 'InvalidPDFException') return { kind: 'invalid', message: 'This file is not a valid PDF, or it is damaged.' };
  if (name === 'MissingLocalFile') return { kind: 'missing', message: error.message };
  const status = error?.status ?? error?.details?.status;
  if (status === 404) return { kind: 'missing', message: 'Google Drive could not find this file. It may have been deleted or unshared.' };
  if (status === 403) return { kind: 'forbidden', message: 'Google Drive refused access to this file. Ask the owner to share it with you.' };
  if (name === 'MissingPDFException') return { kind: 'missing', message: 'The file could not be found.' };
  if (name === 'UnexpectedResponseException' || name === 'ResponseException') {
    return { kind: 'network', message: `The download failed${status ? ` (HTTP ${status})` : ''}. Try again in a moment.` };
  }
  return { kind: 'unknown', message: error?.message || 'Something went wrong while opening this PDF.' };
}
