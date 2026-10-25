// CSS order matters: PDF.js's own stylesheet first, ours after so our
// theme overrides win.
import 'pdfjs-dist/web/pdf_viewer.css';
import './style.css';
import '@fontsource-variable/literata';
import '@fontsource-variable/hanken-grotesk';

import { applyTheme } from './lib/settings.js';
import { mountLibrary } from './views/library.js';
import { h } from './lib/dom.js';

applyTheme();

const app = document.getElementById('app');
let unmount = null;
let view = null;
let routeToken = 0;
let libraryScroll = 0;

// Hash routing (#/ and #/read/<drive|local>/<id>) because GitHub Pages cannot
// rewrite unknown paths to index.html.
async function route() {
  const token = ++routeToken;
  if (view === 'library') libraryScroll = window.scrollY;
  unmount?.();
  unmount = null;
  app.replaceChildren();
  document.getElementById('toasts')?.replaceChildren(); // messages belong to the screen they came from

  const match = location.hash.match(/^#\/read\/(drive|local)\/([^/?#]+)/);
  if (!match) {
    view = 'library';
    document.title = 'Bookworm';
    unmount = mountLibrary(app, { restoreScroll: libraryScroll });
    return;
  }

  view = 'reader';
  try {
    // The reader (and the PDF viewer inside it) is only fetched when needed.
    const { mountReader } = await import('./reader/reader.js');
    if (token !== routeToken) return;
    unmount = mountReader(app, { source: match[1], fileId: decodeURIComponent(match[2]) });
  } catch (error) {
    if (token !== routeToken) return;
    app.replaceChildren(
      h(
        'div',
        { class: 'mx-auto max-w-md p-8 text-center' },
        h('p', { class: 'font-display text-xl' }, 'The reader failed to load.'),
        h('p', { class: 'mt-2 text-muted' }, error?.message ?? 'Check your connection and reload the page.'),
        h('a', { class: 'btn btn-primary mt-6', href: '#/' }, 'Back to library'),
      ),
    );
  }
}

window.addEventListener('hashchange', route);
route();
