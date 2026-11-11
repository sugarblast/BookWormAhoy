// The file types Bookworm knows about, and how each one is recognised.
//
// PDFs go through PDF.js. Everything else ("books") is read by the small,
// dependency-free engines in ./ebook/ and shown by the book reader.

export const FORMATS = {
  pdf: { label: 'PDF', extensions: ['pdf'], mimes: ['application/pdf'], supported: true },
  epub: { label: 'EPUB', extensions: ['epub'], mimes: ['application/epub+zip'], supported: true },
  mobi: { label: 'MOBI', extensions: ['mobi', 'prc'], mimes: ['application/x-mobipocket-ebook'], supported: true },
  fb2: {
    label: 'FB2',
    extensions: ['fb2', 'fbz', 'fb2.zip'],
    mimes: ['application/x-fictionbook+xml', 'application/x-fictionbook', 'application/fb2+zip'],
    supported: true,
  },
  cbz: { label: 'CBZ', extensions: ['cbz'], mimes: ['application/vnd.comicbook+zip', 'application/x-cbz'], supported: true },
  txt: { label: 'TXT', extensions: ['txt'], mimes: ['text/plain'], supported: true },

  // Recognised only so Bookworm can explain why it will not open them.
  azw3: {
    label: 'AZW3',
    extensions: ['azw3', 'azw', 'azw4', 'kfx'],
    mimes: ['application/vnd.amazon.ebook'],
    supported: false,
    hint: 'Kindle AZW3 books are not supported yet. Convert the file to EPUB with the free Calibre app and add that instead.',
  },
  cbr: {
    label: 'CBR',
    extensions: ['cbr'],
    mimes: ['application/vnd.comicbook-rar', 'application/x-cbr'],
    supported: false,
    hint: 'CBR (RAR) comics are not supported. Convert the file to CBZ with Calibre or 7-Zip and add that instead.',
  },
  djvu: {
    label: 'DjVu',
    extensions: ['djvu', 'djv'],
    mimes: ['image/vnd.djvu', 'image/x-djvu'],
    supported: false,
    hint: 'DjVu files are not supported. Convert the file to PDF and add that instead.',
  },
};

/** 'epub', 'pdf', ... or null when the name and type match nothing known. */
export function detectFormat(name = '', mime = '') {
  const lower = name.toLowerCase();
  let best = null;
  let bestLength = 0;
  for (const [key, format] of Object.entries(FORMATS)) {
    for (const extension of format.extensions) {
      if (lower.endsWith(`.${extension}`) && extension.length > bestLength) {
        best = key;
        bestLength = extension.length;
      }
    }
  }
  if (best) return best;
  const type = mime.toLowerCase().split(';')[0].trim();
  if (type) for (const [key, format] of Object.entries(FORMATS)) if (format.mimes.includes(type)) return key;
  return null;
}

export const isSupported = (key) => Boolean(key && FORMATS[key]?.supported);
export const isBookFormat = (key) => isSupported(key) && key !== 'pdf';
export const formatLabel = (key) => FORMATS[key]?.label ?? '';

/** "Moby_Dick.epub" -> "Moby_Dick" (only strips an extension Bookworm knows). */
export function stripExtension(name = '') {
  const lower = name.toLowerCase();
  let cut = 0;
  for (const format of Object.values(FORMATS)) {
    for (const extension of format.extensions) {
      if (lower.endsWith(`.${extension}`) && extension.length + 1 > cut) cut = extension.length + 1;
    }
  }
  return cut ? name.slice(0, name.length - cut) : name;
}

const supportedFormats = () => Object.values(FORMATS).filter((format) => format.supported);

/** Value for <input accept>. */
export const ACCEPT = supportedFormats()
  .flatMap((format) => [...format.mimes, ...format.extensions.map((extension) => `.${extension}`)])
  .join(',');

/** Extensions for Dropbox's Chooser. */
export const DROPBOX_EXTENSIONS = supportedFormats().flatMap((format) => format.extensions.map((extension) => `.${extension}`));

/**
 * MIME types for Google's picker. Drive labels many ebook uploads with a generic
 * type, so zip and octet-stream are included and the picked files are filtered
 * by name afterwards.
 */
export const PICKER_MIMES = [
  ...new Set([
    ...supportedFormats().flatMap((format) => format.mimes),
    'application/zip',
    'application/x-zip-compressed',
    'application/octet-stream',
  ]),
].join(',');

/** Human list for messages: "PDF, EPUB, MOBI, FB2, CBZ and TXT". */
export function supportedList() {
  const labels = supportedFormats().map((format) => format.label);
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

/** Why a file cannot be added, or '' when it can. */
export function whyNotSupported(name, mime) {
  const key = detectFormat(name, mime);
  if (isSupported(key)) return '';
  if (key) return FORMATS[key].hint;
  return `${name} is not a format Bookworm can open. It reads ${supportedList()}.`;
}
