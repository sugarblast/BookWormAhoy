// Copies the runtime assets PDF.js loads on demand (character maps, the 14
// standard fonts, the JPEG 2000 / JBIG2 wasm decoders and ICC profiles) into
// public/pdfjs/ so the app serves them itself. Without these, scanned books
// and PDFs with non-embedded fonts render blank or with the wrong glyphs.
//
// Runs automatically before `npm run dev` and `npm run build`.

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = dirname(require.resolve('pdfjs-dist/package.json'));
const target = join(root, 'public', 'pdfjs');

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const from = join(source, folder);
  if (!existsSync(from)) {
    console.warn(`[pdfjs-assets] skipped ${folder}: not found in pdfjs-dist`);
    continue;
  }
  cpSync(from, join(target, folder), { recursive: true });
}

console.log('[pdfjs-assets] copied to public/pdfjs');
