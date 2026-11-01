// The shelf: connect screen, "Continue reading", search, sort and the cover grid.

import { clear, createMenu, debounce, formatBytes, formatRelative, h, hashString, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { currentTheme, nextTheme, setTheme, settings, THEME_LABELS } from '../lib/settings.js';
import { connect, disconnect, ensureToken, getAuthStatus, onAuthChange, preloadGis } from '../lib/auth.js';
import { isDriveConfigured, isDropboxConfigured } from '../config.js';
import { getAccount } from '../lib/drive.js';
import { pickPdfs, preloadPicker } from '../lib/picker.js';
import { chooseFromDropbox, downloadFromDropbox, preloadDropbox } from '../lib/dropbox.js';
import { assertRoom } from '../lib/storage.js';
import { openAddDialog } from './addDialog.js';
import { createStorageMeter } from './storageMeter.js';
import { bookCache, bookFromProgress, bookHref, driveBook, localBook } from '../lib/books.js';
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
    authProblem: false,
    account: null,
    transfer: null,
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
  // Nothing to connect to unless Google Drive was switched on when the site was built.
  const accountHost = h('div', { class: 'relative', hidden: !isDriveConfigured() }, accountButton);
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
          { label: 'Add from Google Drive…', onSelect: () => openFromDrive() },
          { label: 'Switch account', onSelect: () => doConnect({ chooseAccount: true }) },
          { separator: true },
          { label: 'Disconnect', onSelect: () => doDisconnect() },
          { label: 'Disconnect and revoke access', onSelect: () => doDisconnect({ revoke: true }) },
        ];
      }
      if (status === 'expired') {
        return [
          { label: 'Reconnect Google Drive', onSelect: () => doConnect() },
          { separator: true },
          { label: 'Forget this connection', onSelect: () => doDisconnect() },
        ];
      }
      return [{ label: 'Add from Google Drive…', onSelect: () => openFromDrive() }];
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
  const main = h(
    'main',
    { class: 'mx-auto w-full max-w-[1400px] px-4 pb-24 pt-6 sm:px-8' },
    bannerSlot,
    contentSlot,
  );

  // Dropping PDFs anywhere on the shelf adds them.
  const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
  main.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  main.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    addLocalFiles([...event.dataTransfer.files]);
  });

  const meter = createStorageMeter();
  const refreshMeter = debounce(() => !destroyed && meter.refresh(), 250);
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
    const [progress, , saved] = await Promise.all([
      loadAllProgress(),
      readLocal(),
      db.get('meta', 'driveBooks').catch(() => null),
    ]);
    if (destroyed) return;
    state.progress = progress;
    state.drive = (saved?.files ?? []).map(driveBook);
    state.ready = true;
    render();
    db.delete('meta', 'driveList').catch(() => {}); // cache from the old "list the whole Drive" design
    preloadGis();
    if (getAuthStatus() === 'signed-in') {
      preloadPicker();
      loadAccount();
    }
  }

  function loadAccount() {
    getAccount()
      .then((account) => {
        state.account = account;
        if (!destroyed) renderAccountButton();
      })
      .catch(() => {});
  }

  function saveDriveBooks() {
    const files = state.drive.map((book) => ({ id: book.fileId, name: book.name, size: book.size, modifiedTime: book.modified }));
    return db.put('meta', { id: 'driveBooks', files, savedAt: Date.now() }).catch(() => {});
  }

  let picking = false;
  /** "Open from Google Drive": sign in if needed, show Google's picker, put the chosen PDFs on the shelf. */
  async function openFromDrive() {
    if (picking || destroyed || !isDriveConfigured()) return;
    picking = true;
    try {
      let token;
      if (getAuthStatus() === 'signed-in') {
        token = await ensureToken({ minTtlMs: 120_000 });
      } else {
        await connect();
        state.authProblem = false;
        token = await ensureToken({ minTtlMs: 120_000 });
        loadAccount();
      }
      const files = await pickPdfs({ token });
      if (destroyed || !files.length) return;
      const shelf = new Map(state.drive.map((book) => [book.fileId, book]));
      const before = shelf.size;
      for (const file of files) shelf.set(file.id, driveBook(file));
      state.drive = [...shelf.values()];
      await saveDriveBooks();
      render();
      const added = shelf.size - before;
      toast(added ? `Added ${added === 1 ? '1 PDF' : `${added} PDFs`} from Google Drive.` : 'Those PDFs are already on your shelf.');
    } catch (error) {
      toast(error?.message ?? 'Could not open the Google Drive picker.', { kind: 'error' });
    } finally {
      picking = false;
    }
  }

  async function doConnect({ chooseAccount = false } = {}) {
    if (!isDriveConfigured()) return;
    try {
      await connect({ chooseAccount });
      state.authProblem = false;
      toast('Connected to Google Drive.');
      loadAccount();
      render();
    } catch (error) {
      toast(error?.message ?? 'Could not connect to Google Drive.', { kind: 'error' });
    }
  }

  async function doDisconnect({ revoke = false } = {}) {
    if (revoke && !window.confirm('Cancel Bookworm\'s access to your Google account? Your books stay on the shelf, but you will have to pick the Drive files again.')) return;
    await disconnect({ revoke });
    state.account = null;
    state.authProblem = false;
    renderAccountButton();
    render();
    toast(revoke ? 'Access revoked and disconnected from Google Drive.' : 'Disconnected from Google Drive.');
  }

  function openAdd() {
    openAddDialog({
      sources: { drive: isDriveConfigured(), dropbox: isDropboxConfigured() },
      onFiles: (files) => addLocalFiles(files),
      onDrive: () => openFromDrive(),
      onDropbox: () => openFromDropbox(),
      onOpen: () => {
        if (isDropboxConfigured()) preloadDropbox().catch(() => {}); // so its window can open inside the click
      },
    });
  }

  /** Copies PDFs into this browser's storage, refusing any that clearly will not fit. */
  async function storeFiles(entries, origin) {
    let added = 0;
    for (const { name, size, blob } of entries) {
      try {
        await assertRoom(size, name);
        await db.put('files', { id: crypto.randomUUID(), name, size, blob, addedAt: Date.now(), origin });
        added++;
      } catch (error) {
        toast(error?.name === 'StorageFullError' ? error.message : `Could not store ${name}. Your browser may be out of space.`, { kind: 'error', timeout: 9000 });
      }
    }
    if (added) {
      await readLocal();
      if (!destroyed) render();
    }
    return added;
  }

  async function addLocalFiles(files) {
    const pdfs = files.filter((file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
    if (!pdfs.length) {
      toast('Choose one or more PDF files.', { kind: 'error' });
      return;
    }
    const added = await storeFiles(pdfs.map((file) => ({ name: file.name, size: file.size, blob: file })), 'device');
    if (added) toast(added === 1 ? 'Added 1 PDF to this browser.' : `Added ${added} PDFs to this browser.`);
  }

  let transferring = false;
  /** Dropbox's window, then each chosen PDF is downloaded into this browser. */
  async function openFromDropbox() {
    if (transferring || destroyed || !isDropboxConfigured()) return;
    let chosen;
    try {
      chosen = await chooseFromDropbox();
    } catch (error) {
      toast(error?.message ?? 'Could not open Dropbox.', { kind: 'error' });
      return;
    }
    if (!chosen.length) return;
    transferring = true;
    let added = 0;
    try {
      for (const [index, file] of chosen.entries()) {
        state.transfer = { name: file.name, index: index + 1, total: chosen.length, fraction: 0 };
        renderBanner();
        try {
          if (file.bytes) await assertRoom(file.bytes, file.name);
          const blob = await downloadFromDropbox(file, {
            onProgress: (fraction) => {
              state.transfer = { ...state.transfer, fraction };
              renderBanner();
            },
          });
          added += await storeFiles([{ name: file.name, size: blob.size, blob }], 'dropbox');
        } catch (error) {
          toast(`${file.name}: ${error?.message ?? 'could not be saved.'}`, { kind: 'error', timeout: 9000 });
        }
      }
    } finally {
      state.transfer = null;
      transferring = false;
      renderBanner();
    }
    if (added) toast(added === 1 ? 'Saved 1 PDF from Dropbox to this browser.' : `Saved ${added} PDFs from Dropbox to this browser.`);
  }

  async function removeLocal(book) {
    const ok = window.confirm(`Remove "${book.title}" from this browser? ${book.origin === 'dropbox' ? 'The original stays in your Dropbox.' : 'The original file on your device is not touched.'}`);
    if (!ok) return;
    await Promise.allSettled([db.delete('files', book.fileId), db.delete('progress', book.id), forgetCover(book.id)]);
    state.progress.delete(book.id);
    bookCache.delete(book.id);
    await readLocal();
    if (!destroyed) render();
  }

  async function removeDrive(book) {
    const ok = window.confirm(`Take "${book.title}" off your shelf? The file stays in your Google Drive.`);
    if (!ok) return;
    await Promise.allSettled([db.delete('progress', book.id), forgetCover(book.id)]);
    state.progress.delete(book.id);
    bookCache.delete(book.id);
    state.drive = state.drive.filter((item) => item.id !== book.id);
    await saveDriveBooks();
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
      : [book.source === 'local' ? (book.origin === 'dropbox' ? 'From Dropbox' : 'This device') : null, formatBytes(book.size)].filter(Boolean).join(', ');
    const link = h(
      'a',
      { class: 'book-link', href: bookHref(book) },
      cover,
      h('div', { class: 'book-title', title: book.title }, book.title),
      meta ? h('div', { class: 'book-meta' }, meta) : null,
      showOpened && record ? h('div', { class: 'book-meta' }, `Opened ${formatRelative(record.updatedAt)}`) : null,
    );
    const item = h('div', { class: 'book' }, link);
    const local = book.source === 'local';
    item.append(
      h(
        'button',
        {
          class: 'book-remove',
          type: 'button',
          'aria-label': local ? `Remove ${book.title} from this browser` : `Take ${book.title} off the shelf`,
          onclick: () => (local ? removeLocal(book) : removeDrive(book)),
        },
        icon('x', 'size-4'),
      ),
    );
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
    const hasDriveBooks = state.drive.length > 0 || [...state.progress.keys()].some((id) => id.startsWith('drive:'));
    const needsReconnect = hasDriveBooks && (state.authProblem || getAuthStatus() === 'expired');
    const transfer = state.transfer;
    bannerSlot.replaceChildren(
      ...(transfer
        ? [
            h(
              'div',
              { class: 'mb-8 rounded-lg border border-line bg-surface px-4 py-3', role: 'status' },
              h('p', { class: 'truncate text-sm' }, `Saving from Dropbox (${transfer.index} of ${transfer.total}): ${transfer.name}`),
              h('div', { class: 'meter-track mt-2' }, h('div', { class: 'transfer-fill', style: { width: `${Math.round(transfer.fraction * 100)}%` } })),
            ),
          ]
        : []),
      ...(needsReconnect
        ? [
            h(
              'div',
              { class: 'mb-8 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-line bg-surface px-4 py-3', role: 'status' },
              icon('alert', 'size-5 text-accent'),
              h('p', { class: 'min-w-0 flex-1 text-sm' }, 'Your Google Drive session timed out. Covers and books from Drive cannot load until you reconnect.'),
              h('button', { class: 'btn btn-primary', type: 'button', onclick: () => doConnect() }, 'Reconnect Google Drive'),
            ),
          ]
        : []),
    );
  }

  function hero() {
    const names = ['this device', isDriveConfigured() ? 'Google Drive' : null, isDropboxConfigured() ? 'Dropbox' : null].filter(Boolean);
    const sourcesText = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0];

    return h(
      'section',
      { class: 'mx-auto max-w-2xl py-16 md:py-28' },
      h('h1', { class: 'max-w-[16ch] font-display text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl' }, 'Read your PDFs like books.'),
      h(
        'p',
        { class: 'mt-5 max-w-[46ch] text-lg text-muted' },
        `Add PDFs from ${sourcesText}. Bookworm gives each one a cover, remembers your page, and opens it in a calm reader with a table of contents. It runs entirely in this browser tab, with no Bookworm server in between.`,
      ),
      h('div', { class: 'mt-8' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openAdd() }, icon('plus', 'size-4'), 'Add books')),
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

    const hasAnything = allBooks().length > 0 || state.progress.size > 0;
    if (!hasAnything) {
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
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openAdd() }, icon('plus', 'size-4'), 'Add books'),
    );
    const count = books.length === 1 ? '1 PDF' : `${books.length} PDFs`;

    let body;
    if (!books.length && searching) {
      body = emptyMessage(`No PDFs match "${state.query}"`, 'Check the spelling, or search for a different word from the title.', h('button', { class: 'btn btn-quiet mt-6', type: 'button', onclick: () => { searchInput.value = ''; state.query = ''; renderContent(); } }, 'Clear search'));
    } else if (!books.length) {
      body = emptyMessage('Your shelf is empty', 'Use Add books to bring in PDFs.');
    } else {
      body = h('div', { class: 'shelf' }, books.map((book) => bookItem(book)));
    }

    sections.push(h('section', { 'aria-label': 'Library' }, heading('Library', { count, actions }), body));
    sections.push(h('section', { class: 'mt-16 max-w-xl', 'aria-label': 'Storage' }, meter.el));
    contentSlot.replaceChildren(...sections);
    refreshMeter();
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
    meter.destroy();
    refreshMeter.cancel();
    unsubscribeAuth();
    document.removeEventListener('keydown', onKeydown);
    clear(root);
  };
}
