import { BookError } from './errors.js';

/** Parses strict XML or throws a readable BookError. */
export function parseXml(text, what = 'a file') {
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new BookError(`This book has a broken ${what}.`);
  return doc;
}

/** All descendants with a given local name, ignoring XML namespaces and prefixes. */
export const byLocal = (root, name) => [...root.getElementsByTagName('*')].filter((element) => element.localName === name);

export const textOf = (element) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

const IMAGE_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};
export const IMAGE_EXTENSIONS = Object.keys(IMAGE_TYPES);
export const imageTypeFor = (path) => IMAGE_TYPES[path.split('.').pop().toLowerCase()] ?? 'application/octet-stream';
export const isImagePath = (path) => /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i.test(path);

/** Builds the outline shape the contents drawer uses: { tree, flat } with depth/parent/children links. */
export function buildOutline(items, resolveTarget) {
  const flat = [];
  const walk = (list, depth, parent) =>
    list
      .map((item) => {
        const node = {
          title: item.title || 'Untitled',
          depth,
          parent,
          children: [],
          target: item.href != null ? resolveTarget(item.href) : (item.target ?? null),
          page: null,
        };
        flat.push(node);
        node.children = walk(item.children ?? [], depth + 1, node);
        return node;
      })
      .filter((node) => {
        if (node.target || node.children.length) return true;
        flat.splice(flat.indexOf(node), 1);
        return false;
      });
  return { tree: walk(items, 0, null), flat };
}

/** Downscales a cover image to a shelf-sized JPEG. Resolves null if the image cannot be decoded. */
export async function toCoverBlob(blob, width = 480) {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, width / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.84));
  } catch {
    return null;
  }
}
