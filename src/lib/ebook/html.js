// Prepares one chapter of a book (untrusted HTML and CSS) for display.
//
//  * Scripts, frames, forms, media and anything that could load from the network
//    are removed. (The reader also shows chapters in a sandboxed frame under the
//    site's Content-Security-Policy, so this is a second line of defence.)
//  * The book's own colours, backgrounds and absolute font sizes are dropped, so
//    the reader's themes and text-size setting always win and text is never
//    unreadable (for example black text on the dark theme).
//  * Images become blob: URLs read from the book; links are rewritten to
//    data attributes that the reader handles itself.

import { resolveHref, schemeOf } from './paths.js';

const REMOVE =
  'script,iframe,frame,frameset,object,embed,applet,form,input,button,select,textarea,audio,video,source,track,canvas,noscript,meta,link,base,template,dialog,style';
const PRESENTATION_ATTRS = ['color', 'bgcolor', 'background', 'text', 'link', 'vlink', 'alink', 'face'];
const ABSOLUTE_UNITS = /\d(px|pt|pc|cm|mm|in|q)\b/i;
const BODY_ONLY_DROP = /^(margin|padding|width|height|min-|max-|inset|top|left|right|bottom)/;

function shouldDropProperty(property, value) {
  const v = value.toLowerCase();
  if (v.includes('url(') || v.includes('expression(')) return true;
  if (
    property === 'color' ||
    property === 'font' ||
    property === 'font-family' ||
    property === 'opacity' ||
    property === 'filter' ||
    property === 'overflow' ||
    property === 'z-index' ||
    property === 'text-shadow' ||
    property === 'caret-color' ||
    property === 'mix-blend-mode' ||
    property.startsWith('background') ||
    property.startsWith('animation') ||
    property.startsWith('transition') ||
    property.startsWith('column') ||
    property.startsWith('overflow') ||
    property.startsWith('-webkit-text-') ||
    property.startsWith('-webkit-column') ||
    property.startsWith('-webkit-box-')
  ) {
    return true;
  }
  if (property === 'font-size' || property === 'line-height') return ABSOLUTE_UNITS.test(v);
  if (property === 'position') return /fixed|absolute|sticky/.test(v);
  if (['top', 'left', 'right', 'bottom', 'inset'].includes(property)) return true;
  if (['height', 'min-height', 'max-height'].includes(property)) return /vh|vw|%/.test(v);
  if (['width', 'min-width'].includes(property)) return /vw|vh/.test(v);
  return false;
}

function cleanDeclaration(style, { bodyLike = false } = {}) {
  for (const property of [...style]) {
    if (shouldDropProperty(property, style.getPropertyValue(property)) || (bodyLike && BODY_ONLY_DROP.test(property))) {
      style.removeProperty(property);
    }
  }
}

function cleanRules(list, removeRule) {
  for (let i = list.length - 1; i >= 0; i--) {
    const rule = list[i];
    switch (rule.type) {
      case 1: {
        // style rule
        const bodyLike = /(^|,)\s*(html|body)\s*(,|$)/i.test(rule.selectorText ?? '');
        cleanDeclaration(rule.style, { bodyLike });
        if (rule.cssRules?.length) cleanRules(rule.cssRules, (index) => rule.deleteRule(index));
        break;
      }
      case 4: // @media
      case 12: // @supports
        cleanRules(rule.cssRules, (index) => rule.deleteRule(index));
        break;
      default:
        // @font-face, @import, @page, @keyframes, @namespace and anything newer
        removeRule(i);
    }
  }
}

/** Rewrites a book's stylesheet so it keeps layout and emphasis but not colours, fonts or remote loads. */
export function cleanCss(text) {
  try {
    const sheet = new CSSStyleSheet();
    // @import is never loaded (and browsers log a warning when a constructed sheet has one).
    sheet.replaceSync(text.replace(/@import\b[^;{}]*;?/gi, ''));
    cleanRules(sheet.cssRules, (index) => sheet.deleteRule(index));
    return [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
  } catch {
    return ''; // unparsable stylesheet: show the book without it
  }
}

export function parseMarkup(text, mime = 'application/xhtml+xml') {
  if (/xml/.test(mime)) {
    const xml = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    if (!xml.getElementsByTagName('parsererror').length) return { doc: xml, xml: true };
  }
  return { doc: new DOMParser().parseFromString(text, 'text/html'), xml: false };
}

const localNameIs = (element, name) => element.localName?.toLowerCase() === name;

/**
 * @param {string} text            the chapter's markup
 * @param {object} options
 * @param {string} options.path    the chapter's path inside the book (links are resolved against it)
 * @param {string} options.mime
 * @param {(path: string) => Promise<string|null>} options.readStylesheet  returns cleaned CSS for a path in the book
 * @param {(path: string) => Promise<string|null>} options.imageUrl         returns a blob: URL for an image in the book
 */
export async function prepareChapter(text, { path, mime, readStylesheet, imageUrl }) {
  const { doc, xml } = parseMarkup(text, mime);
  const root = doc.documentElement;
  const sourceBody = doc.body ?? [...(root?.children ?? [])].find((child) => localNameIs(child, 'body')) ?? null;

  // 1. Stylesheets, in document order
  const sheets = [];
  const styleNodes = doc.querySelectorAll(xml ? 'style, link' : 'style, link[rel~="stylesheet" i]');
  for (const node of styleNodes) {
    if (localNameIs(node, 'style')) sheets.push({ text: node.textContent ?? '' });
    else if (/stylesheet/i.test(node.getAttribute('rel') ?? '') && node.getAttribute('href')) {
      sheets.push({ path: resolveHref(path, node.getAttribute('href')).path });
    }
  }

  // 2. Move the content into an inert HTML document, so it serialises as real HTML
  const inert = document.implementation.createHTMLDocument('');
  const body = inert.body;
  if (sourceBody) {
    for (const child of [...sourceBody.childNodes]) body.append(inert.importNode(child, true));
  } else if (root) {
    body.append(inert.importNode(root, true)); // e.g. a bare <svg> cover page
  }

  body.querySelectorAll(REMOVE).forEach((node) => node.remove());

  // 3. Attributes, links, images
  const pendingImages = [];
  for (const element of body.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcset' || name === 'ping' || name === 'formaction' || name === 'target' || name === 'rel') {
        element.removeAttribute(attribute.name);
      } else if (PRESENTATION_ATTRS.includes(name)) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.hasAttribute('style')) {
      cleanDeclaration(element.style);
      if (!element.getAttribute('style')) element.removeAttribute('style');
    }

    const tag = element.localName.toLowerCase();
    if (tag === 'a' || tag === 'area') {
      const href = element.getAttribute('href');
      if (href == null) continue;
      const scheme = schemeOf(href);
      if (['http', 'https', 'mailto', 'tel'].includes(scheme)) {
        element.setAttribute('data-bw', 'external');
        element.setAttribute('data-url', href.trim());
        element.setAttribute('href', '#');
      } else if (scheme === '') {
        const target = resolveHref(path, href);
        element.setAttribute('data-bw', 'internal');
        element.setAttribute('data-path', target.path);
        element.setAttribute('data-frag', target.fragment);
        element.setAttribute('href', '#');
      } else {
        element.removeAttribute('href');
      }
    } else if (tag === 'use') {
      const reference = element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? '';
      if (!reference.startsWith('#')) element.remove();
    } else if (tag === 'img' || tag === 'image') {
      const attributeName = tag === 'img' ? 'src' : element.hasAttribute('href') ? 'href' : 'xlink:href';
      const source = element.getAttribute(attributeName) ?? '';
      if (/^data:image\//i.test(source)) continue;
      pendingImages.push({ element, attributeName, source });
    }
  }

  // Inline images read from the book; anything else (remote) is dropped.
  await Promise.all(
    pendingImages.map(async ({ element, attributeName, source }) => {
      let url = null;
      if (source && schemeOf(source) === '') {
        const { path: imagePath } = resolveHref(path, source);
        url = imagePath ? await imageUrl(imagePath) : null;
      }
      if (url) {
        element.setAttribute(attributeName, url);
        if (attributeName === 'href') element.removeAttribute('xlink:href');
      } else if (element.localName.toLowerCase() === 'img') {
        const alt = (element.getAttribute('alt') ?? '').trim();
        element.replaceWith(alt ? inert.createTextNode(alt) : inert.createComment(''));
      } else {
        element.remove();
      }
    }),
  );

  // 4. The book's CSS, cleaned
  const cssParts = await Promise.all(
    sheets.map(async (sheet) => (sheet.text != null ? cleanCss(sheet.text) : (await readStylesheet(sheet.path)) ?? '')),
  );

  const attribute = (name) => sourceBody?.getAttribute(name) || '';
  return {
    css: cssParts.filter(Boolean).join('\n'),
    bodyHtml: body.innerHTML,
    bodyClass: attribute('class'),
    bodyId: attribute('id'),
    lang: root?.getAttribute?.('lang') || root?.getAttribute?.('xml:lang') || '',
    dir: root?.getAttribute?.('dir') || sourceBody?.getAttribute?.('dir') || '',
    text: (body.textContent ?? '').trim(),
  };
}
