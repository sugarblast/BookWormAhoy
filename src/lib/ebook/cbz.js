// Comic book archives (.cbz): a ZIP of page images. Each image is one page.

import { BookError } from './errors.js';
import { openZip } from './zip.js';
import { byLocal, imageTypeFor, isImagePath, textOf } from './util.js';
import { naturalCompare } from './paths.js';

export async function openCbz(blob) {
  const zip = await openZip(blob);
  const pages = zip
    .names()
    .filter((name) => isImagePath(name) && !/(^|\/)(__MACOSX|\.)/.test(name) && !/\.svg$/i.test(name))
    .sort(naturalCompare);
  if (!pages.length) throw new BookError('This comic archive has no page images.');

  let metadata = { title: '', author: '', language: '' };
  const infoName = zip.names().find((name) => /(^|\/)comicinfo\.xml$/i.test(name));
  if (infoName) {
    try {
      const doc = new DOMParser().parseFromString(await zip.text(infoName), 'application/xml');
      const get = (name) => textOf(byLocal(doc.documentElement, name)[0]);
      const series = get('Series');
      const number = get('Number');
      metadata = {
        title: get('Title') || [series, number && `#${number}`].filter(Boolean).join(' '),
        author: get('Writer'),
        language: get('LanguageISO'),
      };
    } catch {
      /* the metadata file is optional */
    }
  }

  async function load(index) {
    const path = pages[index];
    const url = URL.createObjectURL(await zip.blob(path, imageTypeFor(path)));
    return {
      css: '',
      bodyHtml: `<img class="bw-page" src="${url}" alt="Page ${index + 1}">`,
      bodyClass: 'cbz',
      bodyId: '',
      lang: '',
      dir: '',
      text: '',
      revoke: () => URL.revokeObjectURL(url),
    };
  }

  return {
    format: 'cbz',
    fixed: true,
    metadata,
    sections: pages.map((path, index) => ({ index, size: 1 })),
    outline: { tree: [], flat: [] },
    load,
    cover: () => zip.blob(pages[0], imageTypeFor(pages[0])),
    destroy() {},
  };
}
