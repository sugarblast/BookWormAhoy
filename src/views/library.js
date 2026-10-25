// The shelf: connect screen, "Continue reading", search, sort and the cover grid.

import { clear, createMenu, debounce, formatBytes, formatRelative, h, hashString, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { currentTheme, nextTheme, setTheme, settings, THEME_LABELS } from '../lib/settings.js';
import { AuthError, connect, disconnect, ensureToken, getAuthStatus, onAuthChange, preloadGis } from '../lib/auth.js';
import { getClientId, looksLikeClientId, saveClientId } from '../config.js';
import { getAccount, listPdfs } from '../lib/drive.js';
import { bookCache, bookFromProgress, bookHref, localBook } from '../lib/books.js';
import { db } from '../lib/db.js';
import { fractionRead, isStarted, loadAllProgress } from '../lib/progress.js';
import { forgetCover, requestCover } from '../lib/covers.js';

const CLOTH = ['#23594a', '#26364f', '#6b2a2f', '#8a6a24', '#44505c', '#4b3556', '#1f5f66', '#5a4632'];
const clothFor = (book) => CLOTH[hashString(book.id) % CLOTH.length];
const THEME_ICONS = { light: 'sun', sepia: 'tone', dark: 'moon' };
const SORTS = [
  ['recent', 'Recently read'],
  ['title', 'Title A to Z'],
  ['modified', 'Newest first'],
  ['size', 'Largest first'],
];

/* ------------------------------------------------------------------ *
 * Covers
 * ------------------------------------------------------------------ */

function placeholderCover(book) {
  return h(
    'div',
    { class: 'cover-ph', style: { '--cc': clothFor(book) } },
    h('div', { class: 'cover-ph-title' }, book.title),
    h('div', { class: 'cover-ph-rule' }),
  );
}

function bookCover(book, record) {
  const face = h('div', { class: 'book-face' }, placeholderCover(book));
  const cover = h('div', { class: 'book-cover' }, face);
  if (isStarted(record)) {
    // Ribbon length is progress: a short tab just started, nearly the whole cover when almost done.
    const length = 12 + fractionRead(record) * 76;
    cover.append(
      h('div', { class: 'ribbon-wrap', style: { height: `${length}%` }, 'aria-hidden': 'true' }, h('div', { class: 'ribbon' })),
    );
  }
  return { cover, face };
}

/** Lazily renders real covers for the items that scroll into view. */
function createCoverLoader(onAuthError) {
  const faces = new WeakMap();
  const tokens = new Set();
  let urls = [];
  let observer = null;

  async function load(face) {
    const book = faces.get(face);
    if (!book) return;
    const token = { cancelled: false };
    tokens.add(token);
    try {
      const blob = await requestCover(book, token);
      if (!blob || token.cancelled) return;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = h('img', { src: url, alt: '', decoding: 'async' });
      // Portrait pages fill the cover; landscape ones (slides, spreads) are shown whole instead of cropped.
      img.addEventListener(
        'load',
        () => {
          if (img.naturalWidth / img.naturalHeight > 0.9) face.dataset.fit = 'contain';
        },
        { once: true },
      );
      face.replaceChildren(img);
    } catch (error) {
      if (error?.name === 'AuthError') onAuthError(error);
    } finally {
      tokens.delete(token);
    }
  }

  function reset() {
    observer?.disconnect();
    for (const token of tokens) token.cancelled = true;
    tokens.clear();
    for (const url of urls) URL.revokeObjectURL(url);
    urls = [];
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          load(entry.target);
        }
      },
      { rootMargin: '400px 0px' },
    );
  }

  reset();
  return {
    reset,
    attach(face, book) {
      faces.set(face, book);
      observer.observe(face);
    },
    destroy() {
      observer?.disconnect();
      for (const token of tokens) token.cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
    },
  };
}

/* ------------------------------------------------------------------ *
 * View
 * ------------------------------------------------------------------ */

export function mountLibrary(root, { restoreScroll = 0 } = {}) {
  const state = {
    ready: false,
    drive: [],
    local: [],
    progress: new Map(),
    query: '',
    sort: settings.get('sort'),
    loading: false,
    driveError: null,
    authProblem: false,
    account: null,
  };
  let destroyed = false;
  let scrollRestored = false;

  const loader = createCoverLoader(() => {
    if (!state.authProblem) {
      state.authProblem = true;
      renderBanner();
    }
  });

  /* ---- header ---- */

  const themeButton = h('button', { class: 'icon-btn', type: 'button', onclick: () => { setTheme(nextTheme()); renderThemeButton(); } });
  function renderThemeButton() {
    const theme = currentTheme();
    themeButton.replaceChildren(icon(THEME_ICONS[theme]));
    themeButton.setAttribute('aria-label', `Theme: ${THEME_LABELS[theme]}. Switch to ${THEME_LABELS[nextTheme()]}.`);
    themeButton.title = themeButton.getAttribute('aria-label');
  }

  const accountButton = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Google Drive account' });
  const accountHost = h('div', { class: 'relative' }, accountButton);
  function renderAccountButton() {
    const initial = state.account?.displayName?.trim()?.[0]?.toUpperCase();
    accountButton.replaceChildren(
      getAuthStatus() === 'signed-in' && initial
        ? h('span', { class: 'grid size-7 place-items-center rounded-full bg-accent text-sm font-semibold text-accent-ink' }, initial)
        : icon('cloud'),
    );
  }
  createMenu({
    anchor: accountButton,
    host: accountHost,
    getItems() {
      const status = getAuthStatus();
      if (status === 'signed-in') {
        return [
          { note: state.account?.emailAddress ?? 'Google Drive connected' },
          { label: 'Refresh library', onSelect: () => refreshDrive() },
          { label: 'Switch account', onSelect: () => doConnect({ chooseAccount: true }) },
          { separator: true },
          { label: 'Disconnect Google Drive', onSelect: doDisconnect },
        ];
      }
      if (status === 'expired') {
        return [
          { label: 'Reconnect Google Drive', onSelect: () => doConnect() },
          { separator: true },
          { label: 'Forget this connection', onSelect: doDisconnect },
        ];
      }
      return [{ label: 'Connect Google Drive', onSelect: () => doConnect() }];
    },
  });

  const searchInput = h('input', {
    type: 'search',
    class: 'field w-full pl-10',
    placeholder: 'Search your library',
    'aria-label': 'Search your library',
    autocomplete: 'off',
    spellcheck: 'false',
    oninput: debounce(() => {
      state.query = searchInput.value.trim();
      renderContent();
    }, 120),
  });
  const sortSelect = h(
    'select',
    {
      class: 'field',
      'aria-label': 'Sort books',
      onchange: () => {
        state.sort = sortSelect.value;
        settings.set('sort', state.sort);
        renderContent();
      },
    },
    SORTS.map(([value, label]) => h('option', { value, selected: value === state.sort }, label)),
  );

  const header = h(
    'header',
    { class: 'sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur' },
    h(
      'div',
      { class: 'mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-8' },
      h(
        'a',
        { href: '#/', class: 'order-1 flex items-center gap-2 rounded-md font-display text-xl font-semibold tracking-tight' },
        h('span', { class: 'mark', 'aria-hidden': 'true' }),
        'Bookworm',
      ),
      h(
        'div',
        { class: 'order-3 flex w-full gap-2 sm:order-2 sm:w-auto sm:max-w-xl sm:flex-1 sm:pl-6' },
        h(
          'label',
          { class: 'relative block min-w-0 flex-1' },
          h('span', { class: 'pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted' }, icon('search', 'size-4')),
          searchInput,
        ),
        sortSelect,
      ),
      h('div', { class: 'order-2 ml-auto flex items-center gap-1 sm:order-3' }, themeButton, accountHost),
    ),
  );

  const bannerSlot = h('div', { class: 'empty:hidden' });
  const contentSlot = h('div');
  const fileInput = h('input', {
    type: 'file',
    accept: 'application/pdf,.pdf',
    multiple: true,
    class: 'hidden',
    onchange: async () => {
      const files = [...fileInput.files];
      fileInput.value = '';
      await addLocalFiles(files);
    },
  });

  const main = h(
    'main',
    { class: 'mx-auto w-full max-w-[1400px] px-4 pb-24 pt-6 sm:px-8' },
    bannerSlot,
    contentSlot,
    fileInput,
  );
  root.replaceChildren(header, main);
  renderThemeButton();
  renderAccountButton();

  const unsubscribeAuth = onAuthChange(() => {
    renderAccountButton();
    renderBanner();
  });
  const onKeydown = (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName ?? '');
    if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      searchInput.focus();
    }
  };
  document.addEventListener('keydown', onKeydown);

  /* ---- data ---- */

  async function readLocal() {
    try {
      state.local = (await db.all('files')).map(localBook);
    } catch {
      state.local = [];
    }
  }

  async function init() {
    const [progress, , cached] = await Promise.all([
      loadAllProgress(),
      readLocal(),
      db.get('meta', 'driveList').catch(() => null),
    ]);
    if (destroyed) return;
    state.progress = progress;
    if (cached?.books) {
      for (const book of cached.books) bookCache.set(book.id, book);
      state.drive = cached.books;
    }
    state.ready = true;
    render();
    if (getAuthStatus() !== 'signed-out') refreshDrive();
    preloadGis();
  }

  let refreshing = false;
  async function refreshDrive() {
    if (refreshing || destroyed) return;
    refreshing = true;
    state.loading = true;
    state.driveError = null;
    renderContent();
    try {
      await ensureToken();
      const books = await listPdfs({
        onPage: (partial) => {
          if (destroyed) return;
          state.drive = partial;
          scheduleRender();
        },
      });
      state.drive = books;
      state.authProblem = false;
      db.put('meta', { id: 'driveList', books, savedAt: Date.now() }).catch(() => {});
      getAccount()
        .then((account) => {
          state.account = account;
          if (!destroyed) renderAccountButton();
        })
        .catch(() => {});
    } catch (error) {
      if (error instanceof AuthError) state.authProblem = true;
      else state.driveError = error?.message ?? 'Could not load your Drive.';
    } finally {
      state.loading = false;
      refreshing = false;
      if (!destroyed) {
        render();
      }
    }
  }

  const scheduleRender = debounce(() => !destroyed && renderContent(), 150);

  async function doConnect({ chooseAccount = false } = {}) {
    if (!getClientId()) {
      renderContent();
      return;
    }
    try {
      await connect({ chooseAccount });
      state.authProblem = false;
      toast('Connected to Google Drive.');
      await refreshDrive();
    } catch (error) {
      toast(error?.message ?? 'Could not connect to Google Drive.', { kind: 'error' });
    }
  }

  async function doDisconnect() {
    await disconnect();
    state.drive = [];
    state.account = null;
    state.authProblem = false;
    db.delete('meta', 'driveList').catch(() => {});
    renderAccountButton();
    render();
    toast('Disconnected from Google Drive.');
  }

  async function addLocalFiles(files) {
    const pdfs = files.filter((file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
    if (!pdfs.length) {
      toast('Choose one or more PDF files.', { kind: 'error' });
      return;
    }
    let added = 0;
    for (const file of pdfs) {
      try {
        await db.put('files', { id: crypto.randomUUID(), name: file.name, size: file.size, blob: file, addedAt: Date.now() });
        added++;
      } catch {
        toast(`Could not store ${file.name}. Your browser may be out of space.`, { kind: 'error' });
      }
    }
    if (added) {
      await readLocal();
      if (!destroyed) render();
      toast(added === 1 ? 'Added 1 PDF to this browser.' : `Added ${added} PDFs to this browser.`);
    }
  }

  async function removeLocal(book) {
    const ok = window.confirm(`Remove "${book.title}" from this browser? The original file on your device is not touched.`);
    if (!ok) return;
    await Promise.allSettled([db.delete('files', book.fileId), db.delete('progress', book.id), forgetCover(book.id)]);
    state.progress.delete(book.id);
    bookCache.delete(book.id);
    await readLocal();
    if (!destroyed) render();
  }

  /* ---- rendering ---- */

  function allBooks() {
    return [...state.local, ...state.drive];
  }

  function visibleBooks() {
    const tokens = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = allBooks().filter((book) => {
      const title = book.title.toLowerCase();
      return tokens.every((token) => title.includes(token));
    });
    const modified = (book) => (book.modified ? Date.parse(book.modified) : 0);
    const lastRead = (book) => state.progress.get(book.id)?.updatedAt ?? 0;
    const order = {
      recent: (a, b) => lastRead(b) - lastRead(a) || modified(b) - modified(a),
      title: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
      modified: (a, b) => modified(b) - modified(a),
      size: (a, b) => b.size - a.size,
    };
    return matches.sort(order[state.sort] ?? order.recent);
  }

  function bookItem(book, { showOpened = false } = {}) {
    const record = state.progress.get(book.id);
    const { cover, face } = bookCover(book, record);
    loader.attach(face, book);

    const meta = isStarted(record)
      ? `Page ${record.page} of ${record.numPages}`
      : [book.source === 'local' ? 'This device' : null, formatBytes(book.size)].filter(Boolean).join(', ');
    const link = h(
      'a',
      { class: 'book-link', href: bookHref(book) },
      cover,
      h('div', { class: 'book-title', title: book.title }, book.title),
      meta ? h('div', { class: 'book-meta' }, meta) : null,
      showOpened && record ? h('div', { class: 'book-meta' }, `Opened ${formatRelative(record.updatedAt)}`) : null,
    );
    const item = h('div', { class: 'book' }, link);
    if (book.source === 'local') {
      item.append(
        h(
          'button',
          {
            class: 'book-remove',
            type: 'button',
            'aria-label': `Remove ${book.title} from this browser`,
            onclick: () => removeLocal(book),
          },
          icon('x', 'size-4'),
        ),
      );
    }
    return item;
  }

  function heading(text, extra) {
    return h(
      'div',
      { class: 'mb-5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2' },
      h('h2', { class: 'font-display text-2xl font-semibold tracking-tight' }, text, extra?.count != null ? h('span', { class: 'ml-3 font-sans text-sm font-normal text-muted' }, extra.count) : null),
      extra?.actions ?? null,
    );
  }

  function renderBanner() {
    if (destroyed) return;
    const status = getAuthStatus();
    const hasLocalOnly = status === 'signed-out' && (state.local.length > 0 || state.progress.size > 0);
    let banner = null;
    if (state.authProblem || status === 'expired') {
      banner = [
        'Your Google Drive session timed out. Covers and books from Drive cannot load until you reconnect.',
        'Reconnect Google Drive',
      ];
    } else if (hasLocalOnly && getClientId()) {
      banner = ['Connect Google Drive to list the PDFs you keep there.', 'Connect Google Drive'];
    }
    bannerSlot.replaceChildren(
      ...(banner
        ? [
            h(
              'div',
              { class: 'mb-8 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-line bg-surface px-4 py-3', role: 'status' },
              icon('alert', 'size-5 text-accent'),
              h('p', { class: 'min-w-0 flex-1 text-sm' }, banner[0]),
              h('button', { class: 'btn btn-primary', type: 'button', onclick: () => doConnect() }, banner[1]),
            ),
          ]
        : []),
    );
  }

  function hero() {
    const demo = [
      { id: 'demo:1', title: 'Middlemarch' },
      { id: 'demo:2', title: 'Moby-Dick' },
      { id: 'demo:3', title: 'The Odyssey' },
    ];
    const placement = [
      { left: '2%', top: '12%', width: '44%', transform: 'rotate(-7deg)' },
      { left: '28%', top: '2%', width: '46%', transform: 'rotate(2deg)' },
      { left: '52%', top: '16%', width: '44%', transform: 'rotate(8deg)' },
    ];
    const stack = h(
      'div',
      { class: 'relative mx-auto w-full max-w-md', style: { aspectRatio: '1 / 0.92' }, 'aria-hidden': 'true' },
      demo.map((book, i) => {
        const { cover } = bookCover(book, i === 1 ? { page: 140, numPages: 320 } : null);
        Object.assign(cover.style, { position: 'absolute', ...placement[i] });
        return cover;
      }),
    );

    const canConnect = Boolean(getClientId());
    const idInput = h('input', {
      class: 'field w-full',
      placeholder: '1234567890-abc123.apps.googleusercontent.com',
      'aria-label': 'Google OAuth client ID',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const setup = h(
      'form',
      {
        class: 'mt-8 max-w-lg rounded-lg border border-line bg-surface p-4',
        onsubmit: (event) => {
          event.preventDefault();
          if (!looksLikeClientId(idInput.value)) {
            toast('That does not look like a client ID. It ends in .apps.googleusercontent.com.', { kind: 'error' });
            return;
          }
          saveClientId(idInput.value);
          preloadGis();
          renderContent();
          doConnect();
        },
      },
      h('p', { class: 'text-sm' }, 'To connect Drive, Bookworm needs a Google OAuth client ID. Create one in Google Cloud Console (the README has the steps), then paste it here. It stays in this browser.'),
      h('div', { class: 'mt-3 flex flex-col gap-2 sm:flex-row' }, idInput, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save and connect')),
    );

    return h(
      'section',
      { class: 'grid items-center gap-12 py-10 md:grid-cols-[1.1fr_1fr] md:py-20' },
      h(
        'div',
        null,
        h('h1', { class: 'max-w-[16ch] font-display text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl' }, 'Read your Drive PDFs like books.'),
        h(
          'p',
          { class: 'mt-5 max-w-[46ch] text-lg text-muted' },
          'Bookworm lists the PDFs in your Google Drive with a cover for each, remembers your page, and opens them in a calm reader with a table of contents. It runs entirely in this browser tab, with no Bookworm server in between.',
        ),
        h(
          'div',
          { class: 'mt-8 flex flex-wrap gap-3' },
          canConnect
            ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => doConnect() }, icon('cloud', 'size-4'), 'Connect Google Drive')
            : null,
          h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => fileInput.click() }, icon('upload', 'size-4'), 'Open a PDF from this device'),
        ),
        canConnect ? h('p', { class: 'mt-4 text-sm text-muted' }, 'Read-only access to your Drive. Disconnect any time from the account menu.') : setup,
      ),
      stack,
    );
  }

  function skeleton() {
    return h(
      'div',
      { class: 'shelf', 'aria-hidden': 'true' },
      Array.from({ length: 12 }, () =>
        h('div', null, h('div', { class: 'aspect-[2/3] animate-pulse rounded-[2px_6px_6px_2px] bg-line/70' }), h('div', { class: 'mt-3 h-4 w-3/4 animate-pulse rounded bg-line/70' })),
      ),
    );
  }

  function emptyMessage(title, body, action) {
    return h(
      'div',
      { class: 'mx-auto max-w-md py-16 text-center' },
      h('p', { class: 'font-display text-xl font-semibold' }, title),
      h('p', { class: 'mt-2 text-muted' }, body),
      action ?? null,
    );
  }

  function renderContent() {
    if (destroyed || !state.ready) return;
    loader.reset();

    const status = getAuthStatus();
    const hasAnything = allBooks().length > 0 || state.progress.size > 0;
    if (!hasAnything && !state.loading && status === 'signed-out') {
      contentSlot.replaceChildren(hero());
      return;
    }

    const sections = [];
    const searching = state.query.length > 0;

    if (!searching) {
      const resuming = [...state.progress.values()]
        .filter(isStarted)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 10);
      if (resuming.length) {
        sections.push(
          h(
            'section',
            { class: 'mb-14', 'aria-label': 'Continue reading' },
            heading('Continue reading'),
            h(
              'div',
              { class: 'flex gap-6 overflow-x-auto px-1 pb-4 pt-2 sm:gap-8' },
              resuming.map((record) => h('div', { class: 'w-36 flex-none sm:w-44' }, bookItem(bookFromProgress(record), { showOpened: true }))),
            ),
          ),
        );
      }
    }

    const books = visibleBooks();
    const actions = h(
      'div',
      { class: 'flex items-center gap-2' },
      state.loading ? h('span', { class: 'mr-1 flex items-center gap-2 text-sm text-muted', role: 'status' }, h('span', { class: 'spinner', style: { width: '1rem', height: '1rem' } }), 'Loading Drive') : null,
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => fileInput.click() }, icon('upload', 'size-4'), 'Add from device'),
      status === 'signed-in'
        ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Refresh library', title: 'Refresh library', onclick: () => refreshDrive() }, icon('refresh', 'size-4'))
        : null,
    );
    const count = books.length === 1 ? '1 PDF' : `${books.length} PDFs`;

    let body;
    if (state.driveError && !allBooks().length) {
      body = emptyMessage('Could not load your Drive', state.driveError, h('button', { class: 'btn btn-primary mt-6', type: 'button', onclick: () => refreshDrive() }, 'Try again'));
    } else if (!books.length && state.loading) {
      body = skeleton();
    } else if (!books.length && searching) {
      body = emptyMessage(`No PDFs match "${state.query}"`, 'Check the spelling, or search for a different word from the title.', h('button', { class: 'btn btn-quiet mt-6', type: 'button', onclick: () => { searchInput.value = ''; state.query = ''; renderContent(); } }, 'Clear search'));
    } else if (!books.length) {
      body = emptyMessage('No PDFs found in your Drive', 'Upload a PDF to Google Drive and refresh, or open one from this device.', h('button', { class: 'btn btn-primary mt-6', type: 'button', onclick: () => fileInput.click() }, icon('upload', 'size-4'), 'Open a PDF from this device'));
    } else {
      body = h('div', { class: 'shelf' }, books.map((book) => bookItem(book)));
    }

    sections.push(h('section', { 'aria-label': 'Library' }, heading('Library', { count, actions }), state.driveError && allBooks().length ? h('p', { class: 'mb-4 text-sm text-muted', role: 'status' }, `Showing saved results. ${state.driveError}`) : null, body));
    contentSlot.replaceChildren(...sections);
  }

  function render() {
    if (destroyed) return;
    renderBanner();
    renderContent();
    if (!scrollRestored && state.ready) {
      scrollRestored = true;
      if (restoreScroll) requestAnimationFrame(() => window.scrollTo(0, restoreScroll));
    }
  }

  init();

  return function destroy() {
    destroyed = true;
    loader.destroy();
    unsubscribeAuth();
    document.removeEventListener('keydown', onKeydown);
    scheduleRender.cancel();
    clear(root);
  };
}
