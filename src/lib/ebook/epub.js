// EPUB 2 and 3: the container, package (OPF), spine, table of contents (nav or NCX), cover, chapters.

import { BookError } from './errors.js';
import { openZip } from './zip.js';
import { cleanCss, parseMarkup, prepareChapter } from './html.js';
import { dirname, resolveHref } from './paths.js';
import { buildOutline, byLocal, imageTypeFor, isImagePath, parseXml, textOf } from './util.js';

const FONT_OBFUSCATION = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'];
const FONT_FILE = /\.(ttf|otf|woff2?|eot)$/i;
const CONTENT_TYPES = /x?html|svg|xml/i;

async function assertNotProtected(zip) {
  if (!zip.has('META-INF/encryption.xml')) return;
  let doc;
  try {
    doc = parseXml(await zip.text('META-INF/encryption.xml'));
  } catch {
    return;
  }
  for (const data of byLocal(doc.documentElement, 'EncryptedData')) {
    const algorithm = byLocal(data, 'EncryptionMethod')[0]?.getAttribute('Algorithm') ?? '';
    const uri = byLocal(data, 'CipherReference')[0]?.getAttribute('URI') ?? '';
    if (!FONT_OBFUSCATION.includes(algorithm) && !FONT_FILE.test(uri)) {
      throw new BookError('This book is protected by DRM (copy protection), so Bookworm cannot open it.', 'drm');
    }
  }
}

function listFromNav(list) {
  const items = [];
  for (const li of [...list.children].filter((child) => child.localName === 'li')) {
    const link = [...li.children].find((child) => child.localName === 'a' || child.localName === 'span');
    const sub = [...li.children].find((child) => child.localName === 'ol');
    items.push({
      title: textOf(link) || textOf(li.firstElementChild),
      href: link?.localName === 'a' ? link.getAttribute('href') : null,
      children: sub ? listFromNav(sub) : [],
    });
  }
  return items;
}

function listFromNcx(parent) {
  return [...parent.children]
    .filter((child) => child.localName === 'navPoint')
    .map((point) => ({
      title: textOf(byLocal(point, 'text')[0]),
      href: byLocal(point, 'content')[0]?.getAttribute('src') ?? null,
      children: listFromNcx(point),
    }));
}

export async function openEpub(blob) {
  const zip = await openZip(blob);
  await assertNotProtected(zip);

  if (!zip.has('META-INF/container.xml')) throw new BookError('This file is not a valid EPUB (it has no container.xml).');
  const container = parseXml(await zip.text('META-INF/container.xml'), 'container.xml');
  const opfPath = byLocal(container.documentElement, 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath || !zip.has(opfPath)) throw new BookError('This EPUB does not say where its content is.');
  const opf = parseXml(await zip.text(opfPath), 'package file').documentElement;

  const manifest = new Map();
  for (const item of byLocal(opf, 'item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      path: resolveHref(opfPath, href).path,
      type: item.getAttribute('media-type') ?? '',
      properties: (item.getAttribute('properties') ?? '').split(/\s+/),
    });
  }

  const metadata = byLocal(opf, 'metadata')[0];
  const metaFirst = (name) => textOf(metadata && byLocal(metadata, name)[0]);
  const authors = metadata ? byLocal(metadata, 'creator').map(textOf).filter(Boolean) : [];

  const spineElement = byLocal(opf, 'spine')[0];
  const sections = [];
  for (const ref of spineElement ? byLocal(spineElement, 'itemref') : []) {
    const item = manifest.get(ref.getAttribute('idref'));
    if (!item || !CONTENT_TYPES.test(item.type) || !zip.has(item.path)) continue;
    sections.push({ index: sections.length, path: item.path, type: item.type, size: Math.max(zip.sizeOf(item.path), 1) });
  }
  if (!sections.length) throw new BookError('This EPUB has no readable pages.');
  const indexByPath = new Map(sections.map((section) => [section.path, section.index]));

  // Table of contents: EPUB 3 nav document first, then the EPUB 2 NCX.
  let rawToc = [];
  let tocPath = '';
  try {
    const navItem = [...manifest.values()].find((item) => item.properties.includes('nav'));
    if (navItem && zip.has(navItem.path)) {
      const { doc } = parseMarkup(await zip.text(navItem.path), navItem.type || 'application/xhtml+xml');
      const navs = [...doc.getElementsByTagName('nav')];
      const nav =
        navs.find((element) => /\btoc\b/.test(element.getAttribute('epub:type') ?? '') || element.getAttribute('role') === 'doc-toc') ??
        navs[0];
      const list = nav && [...nav.getElementsByTagName('ol')][0];
      if (list) {
        rawToc = listFromNav(list);
        tocPath = navItem.path;
      }
    }
  } catch {
    rawToc = [];
  }
  if (!rawToc.length) {
    try {
      const ncxItem =
        manifest.get(spineElement?.getAttribute('toc')) ?? [...manifest.values()].find((item) => item.type === 'application/x-dtbncx+xml');
      if (ncxItem && zip.has(ncxItem.path)) {
        const ncx = parseXml(await zip.text(ncxItem.path), 'table of contents').documentElement;
        const navMap = byLocal(ncx, 'navMap')[0];
        if (navMap) {
          rawToc = listFromNcx(navMap);
          tocPath = ncxItem.path;
        }
      }
    } catch {
      rawToc = [];
    }
  }

  const locate = (path, fragment = '') => {
    const index = indexByPath.get(path);
    return index == null ? null : { index, fragment };
  };
  const outline = buildOutline(rawToc, (href) => {
    const { path, fragment } = resolveHref(tocPath, href);
    return locate(path, fragment);
  });

  const stylesheets = new Map();
  const stylesheet = (path) => {
    if (!stylesheets.has(path)) {
      stylesheets.set(
        path,
        zip.has(path) ? zip.text(path).then(cleanCss, () => '') : Promise.resolve(''),
      );
    }
    return stylesheets.get(path);
  };

  async function load(index) {
    const section = sections[index];
    const urls = [];
    const prepared = await prepareChapter(await zip.text(section.path), {
      path: section.path,
      mime: section.type,
      readStylesheet: stylesheet,
      async imageUrl(path) {
        if (!zip.has(path)) return null;
        const url = URL.createObjectURL(await zip.blob(path, imageTypeFor(path)));
        urls.push(url);
        return url;
      },
    });
    return { ...prepared, revoke: () => urls.forEach((url) => URL.revokeObjectURL(url)) };
  }

  async function cover() {
    const byProperty = [...manifest.values()].find((item) => item.properties.includes('cover-image'));
    const metaId = metadata && byLocal(metadata, 'meta').find((meta) => meta.getAttribute('name') === 'cover')?.getAttribute('content');
    const byMeta = metaId ? manifest.get(metaId) : null;
    const images = [...manifest.values()].filter((item) => /^image\//.test(item.type) || isImagePath(item.path));
    const byName = images.find((item) => /cover/i.test(item.id) || /cover/i.test(item.path));

    for (const item of [byProperty, byMeta, byName]) {
      if (item && zip.has(item.path) && (isImagePath(item.path) || /^image\//.test(item.type))) {
        return zip.blob(item.path, item.type || imageTypeFor(item.path));
      }
    }
    // A cover page (guide reference or the first page) that holds just an image.
    const guide = byLocal(opf, 'reference').find((reference) => reference.getAttribute('type') === 'cover');
    const pagePath = guide ? resolveHref(opfPath, guide.getAttribute('href')).path : sections[0].path;
    if (zip.has(pagePath)) {
      const match = /(?:src|href)\s*=\s*["']([^"']+\.(?:jpe?g|png|gif|webp|svg))(?:[?#][^"']*)?["']/i.exec(await zip.text(pagePath));
      if (match) {
        const imagePath = resolveHref(pagePath, match[1]).path;
        if (zip.has(imagePath)) return zip.blob(imagePath, imageTypeFor(imagePath));
      }
    }
    return null;
  }

  return {
    format: 'epub',
    fixed: false,
    metadata: { title: metaFirst('title'), author: authors.join(', '), language: metaFirst('language') },
    sections,
    outline,
    load,
    locate,
    cover,
    destroy() {
      stylesheets.clear();
    },
  };
}
