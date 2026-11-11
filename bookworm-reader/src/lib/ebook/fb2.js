// FictionBook 2 (.fb2, and .fbz / .fb2.zip): one XML file with chapters, notes and
// base64 images. Top-level sections become chapters; deeply nested ones are
// flattened so every chapter is a separate page of the contents.

import { BookError } from './errors.js';
import { openZip } from './zip.js';
import { buildOutline, byLocal, textOf } from './util.js';

const XLINK = 'http://www.w3.org/1999/xlink';
const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hrefOf = (element) => element.getAttributeNS(XLINK, 'href') ?? [...element.attributes].find((a) => a.localName === 'href')?.value ?? '';
const children = (element, name) => [...element.children].filter((child) => child.localName === name);

async function readXmlBytes(blob) {
  let bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const zip = await openZip(blob);
    const entry = zip.names().find((n) => /\.fb2$/i.test(n)) ?? zip.names()[0];
    if (!entry) throw new BookError('This FB2 archive is empty.');
    bytes = await zip.read(entry);
  }
  // The XML prolog may name a legacy encoding (windows-1251 is common).
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 300));
  const encoding = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1] ?? 'utf-8';
  let text;
  try {
    text = new TextDecoder(encoding).decode(bytes);
  } catch {
    text = new TextDecoder('utf-8').decode(bytes);
  }
  return text.replace(/^﻿/, '');
}

export async function openFb2(blob) {
  const text = await readXmlBytes(blob);
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (doc.getElementsByTagName('parsererror').length || root?.localName !== 'FictionBook') {
    throw new BookError('This file is not a valid FB2 book, or it is damaged.');
  }

  const info = byLocal(root, 'title-info')[0];
  const authorElement = info && byLocal(info, 'author')[0];
  const author = authorElement ? ['first-name', 'middle-name', 'last-name'].map((n) => textOf(byLocal(authorElement, n)[0])).filter(Boolean).join(' ') : '';
  const metadata = { title: textOf(info && byLocal(info, 'book-title')[0]), author, language: textOf(info && byLocal(info, 'lang')[0]) };

  const binaries = new Map();
  for (const binary of byLocal(root, 'binary')) {
    const id = binary.getAttribute('id');
    if (id) binaries.set(id, { type: binary.getAttribute('content-type') || 'image/jpeg', data: binary.textContent ?? '' });
  }
  const binaryBlob = (id) => {
    const entry = binaries.get(id);
    if (!entry) return null;
    try {
      const raw = atob(entry.data.replace(/\s+/g, ''));
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      return new Blob([bytes], { type: entry.type });
    } catch {
      return null;
    }
  };

  // ---- chapters -------------------------------------------------------
  const bodies = children(root, 'body');
  const mainBody = bodies.find((body) => !body.getAttribute('name')) ?? bodies[0];
  if (!mainBody) throw new BookError('This FB2 book has no text.');
  const pieces = [];
  const isSection = (element) => element.localName === 'section';
  const titleOf = (element) => textOf(children(element, 'title')[0]);

  function walk(section, depth) {
    const subsections = children(section, 'section');
    if (!subsections.length) {
      pieces.push({ element: section, depth, whole: true, title: titleOf(section) });
      return;
    }
    const lead = [...section.children].filter((child) => !isSection(child));
    if (lead.some((child) => child.localName !== 'title') || titleOf(section)) {
      pieces.push({ element: section, depth, whole: false, title: titleOf(section) });
    }
    for (const sub of subsections) walk(sub, depth + 1);
  }

  const topSections = children(mainBody, 'section');
  if (!topSections.length) {
    pieces.push({ element: mainBody, depth: 0, whole: true, title: metadata.title || titleOf(mainBody) });
  } else {
    const lead = [...mainBody.children].filter((child) => !isSection(child));
    if (lead.some((child) => child.localName !== 'title' || textOf(child))) {
      pieces.push({ element: mainBody, depth: 0, whole: false, title: titleOf(mainBody) || metadata.title });
    }
    for (const section of topSections) walk(section, 0);
  }
  const notesBody = bodies.find((body) => body !== mainBody && body.getAttribute('name') === 'notes') ?? bodies.find((body) => body !== mainBody);
  if (notesBody) pieces.push({ element: notesBody, depth: 0, whole: true, title: titleOf(notesBody) || 'Notes' });

  const idToIndex = new Map();
  pieces.forEach((piece, index) => {
    piece.index = index;
    piece.size = Math.max(1, (piece.element.textContent ?? '').length);
    const own = piece.whole ? [piece.element, ...piece.element.querySelectorAll('[id]')] : [piece.element, ...[...piece.element.children].filter((c) => !isSection(c)).flatMap((c) => [c, ...c.querySelectorAll('[id]')])];
    for (const element of own) {
      const id = element.getAttribute?.('id');
      if (id && !idToIndex.has(id)) idToIndex.set(id, index);
    }
  });

  // ---- XML -> HTML ----------------------------------------------------
  const heading = (depth) => `h${Math.min(6, Math.max(2, depth + 2))}`;

  function inline(node, depth) {
    let out = '';
    for (const child of node.childNodes) out += convert(child, depth);
    return out;
  }

  function convert(node, depth) {
    if (node.nodeType === 3) return escapeHtml(node.nodeValue);
    if (node.nodeType !== 1) return '';
    const name = node.localName;
    const idAttr = node.getAttribute('id') ? ` id="${escapeHtml(node.getAttribute('id'))}"` : '';
    switch (name) {
      case 'p':
        return `<p${idAttr}>${inline(node, depth)}</p>`;
      case 'title': {
        const lines = [...node.children].map((child) => inline(child, depth)).filter((line) => line.trim() && line !== '&nbsp;');
        return `<${heading(depth)}${idAttr}>${lines.join('<br>') || inline(node, depth)}</${heading(depth)}>`;
      }
      case 'subtitle':
        return `<h5 class="subtitle"${idAttr}>${inline(node, depth)}</h5>`;
      case 'epigraph':
        return `<blockquote class="epigraph"${idAttr}>${inline(node, depth)}</blockquote>`;
      case 'cite':
        return `<blockquote${idAttr}>${inline(node, depth)}</blockquote>`;
      case 'text-author':
        return `<p class="author"${idAttr}>${inline(node, depth)}</p>`;
      case 'poem':
        return `<div class="poem"${idAttr}>${inline(node, depth)}</div>`;
      case 'stanza':
        return `<div class="stanza">${inline(node, depth)}</div>`;
      case 'v':
        return `<p class="verse"${idAttr}>${inline(node, depth)}</p>`;
      case 'empty-line':
        return '<p class="empty">&nbsp;</p>';
      case 'annotation':
        return `<div class="annotation"${idAttr}>${inline(node, depth)}</div>`;
      case 'emphasis':
        return `<em>${inline(node, depth)}</em>`;
      case 'strong':
        return `<strong>${inline(node, depth)}</strong>`;
      case 'strikethrough':
        return `<s>${inline(node, depth)}</s>`;
      case 'sub':
      case 'sup':
      case 'code':
      case 'table':
      case 'tr':
      case 'th':
      case 'td':
        return `<${name}${idAttr}>${inline(node, depth)}</${name}>`;
      case 'a': {
        const href = hrefOf(node).trim();
        const label = inline(node, depth);
        if (href.startsWith('#')) return `<a data-bw="internal" data-path="" data-frag="${escapeHtml(href.slice(1))}" href="#">${label}</a>`;
        if (/^(https?|mailto):/i.test(href)) return `<a data-bw="external" data-url="${escapeHtml(href)}" href="#">${label}</a>`;
        return label;
      }
      case 'image': {
        const id = hrefOf(node).replace(/^#/, '');
        return binaries.has(id) ? `<img src="__bw_img:${escapeHtml(id)}" alt="">` : '';
      }
      case 'section':
        return `<section${idAttr}>${inline(node, depth + 1)}</section>`;
      default:
        return inline(node, depth);
    }
  }

  const BOOK_CSS = `
    p { margin: 0; text-indent: 1.3em; }
    h2, h3, h4, h5, h6, .subtitle, blockquote p, .author, .verse, .annotation p, p.empty, td p { text-indent: 0; }
    p.empty { height: 1em; }
    .epigraph { margin: 1.2em 0 1.2em 18%; font-style: italic; }
    blockquote { margin: 1em 0 1em 1.5em; }
    .author { text-align: right; font-style: italic; margin-top: 0.4em; }
    .stanza { margin: 1em 0 1em 1.5em; }
    .verse { margin: 0; }
    .subtitle { text-align: center; margin: 1.4em 0 0.8em; }
    img { display: block; margin: 1em auto; }
  `;

  async function load(index) {
    const piece = pieces[index];
    const element = piece.element;
    const depth = piece.depth;
    let html = '';
    if (piece.whole) {
      html = [...element.childNodes].map((child) => convert(child, depth)).join('');
    } else {
      html = [...element.childNodes].filter((child) => !(child.nodeType === 1 && isSection(child))).map((child) => convert(child, depth)).join('');
    }
    const urls = [];
    const cache = new Map();
    html = html.replace(/__bw_img:([^"]+)"/g, (match, id) => {
      const key = id.replace(/&amp;|&quot;|&lt;|&gt;/g, (m) => ({ '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>' })[m]);
      if (!cache.has(key)) {
        const blobValue = binaryBlob(key);
        const url = blobValue ? URL.createObjectURL(blobValue) : '';
        if (url) urls.push(url);
        cache.set(key, url);
      }
      return `${cache.get(key)}"`;
    });
    return {
      css: BOOK_CSS,
      bodyHtml: html,
      bodyClass: 'fb2',
      bodyId: '',
      lang: metadata.language,
      dir: '',
      text: (element.textContent ?? '').trim(),
      revoke: () => urls.forEach((url) => URL.revokeObjectURL(url)),
    };
  }

  // Contents: pieces nested by depth.
  const items = [];
  const stack = [];
  for (const piece of pieces) {
    const item = { title: piece.title || `Section ${piece.index + 1}`, target: { index: piece.index, fragment: '' }, children: [] };
    while (stack.length && stack.at(-1).depth >= piece.depth) stack.pop();
    (stack.length ? stack.at(-1).item.children : items).push(item);
    stack.push({ depth: piece.depth, item });
  }
  const outline = buildOutline(items, () => null);

  async function cover() {
    const page = info && byLocal(info, 'coverpage')[0];
    const image = page && byLocal(page, 'image')[0];
    const id = image ? hrefOf(image).replace(/^#/, '') : '';
    return (id && binaryBlob(id)) || null;
  }

  return {
    format: 'fb2',
    fixed: false,
    metadata,
    sections: pieces.map((piece) => ({ index: piece.index, size: piece.size })),
    outline,
    load,
    resolveLink(fromIndex, path, fragment) {
      if (path) return null;
      const index = idToIndex.get(fragment);
      return index == null ? { index: fromIndex, fragment } : { index, fragment };
    },
    cover,
    destroy() {},
  };
}
