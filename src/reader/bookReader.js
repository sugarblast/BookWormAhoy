// The reader for everything that is not a PDF: EPUB, MOBI, FB2, comics (CBZ) and text.
//
// Same quiet interface as the PDF reader (top and bottom bars that fade away, a
// contents drawer, themes, remembered position) around the book view, which shows
// one chapter at a time as pages or as a scroll.

import { clamp, debounce, h, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { THEME_LABELS, currentTheme, nextTheme, setTheme, settings } from '../lib/settings.js';
import { connect } from '../lib/auth.js';
import { downloadFile, getFileMeta } from '../lib/drive.js';
import { bookCache, localBook } from '../lib/books.js';
import { db } from '../lib/db.js';
import { getProgress, saveProgress } from '../lib/progress.js';
import { openEbook, resolveLink } from '../lib/ebook/index.js';
import { toCoverBlob } from '../lib/ebook/util.js';
import { createOutlineView } from './outline.js';
import { createBookView } from './bookView.js';

const THEME_ICONS = { light: 'sun', sepia: 'tone', dark: 'moon' };
const FLOWS = [
  ['paged', 'Pages', 'page'],
  ['scroll', 'Scroll', 'scroll'],
];
const SIZES = { min: 70, max: 220, step: 10 };
const SPACINGS = [
  ['compact', 'Tight'],
  ['normal', 'Normal'],
  ['relaxed', 'Airy'],
];
const FAMILIES = [
  ['serif', 'Serif'],
  ['sans', 'Sans'],
];
const ERROR_TITLES = {
  auth: 'Reconnect to keep reading',
  invalid: 'This book cannot be opened',
  unsupported: 'Format not supported',
  drm: 'Protected by DRM',
  missing: 'File not found',
  forbidden: 'No access to this file',
  network: 'The download failed',
};

function describeError(error) {
  const name = error?.name ?? '';
  if (name === 'AuthError') return { kind: 'auth', message: error.message };
  if (name === 'BookError') return { kind: error.kind, message: error.message };
  if (name === 'MissingLocalFile') return { kind: 'missing', message: error.message };
  const status = error?.status;
  if (status === 404) return { kind: 'missing', message: "Google Drive could not find this file. It may have been deleted, or Bookworm's access to it ended. Remove it from the shelf and pick it again." };
  if (status === 403) return { kind: 'forbidden', message: 'Google Drive refused access to this file. Pick it again with Open from Google Drive, or ask the owner to share it with you.' };
  if (name === 'TypeError') return { kind: 'network', message: 'The download failed. Check your connection and try again.' };
  return { kind: 'unknown', message: error?.message || 'Something went wrong while opening this book.' };
}

export function mountReader(root, { source, fileId }) {
  const bookId = `${source}:${fileId}`;
  const state = { book: null, ebook: null, saved: null, ready: false, weights: [], total: 1, outline: { tree: [], flat: [] }, location: null };
  let destroyed = false;
  let view = null;
  let outlineView = null;
  let hoveringChrome = false;
  let chromeTimer = 0;
  let loadingText = null;
  let loadingTitle = null;
  let panelOpen = false;
  let downloadController = null;

  const isDesktop = () => window.innerWidth >= 768;

  /* ================================================================ *
   * Interface
   * ================================================================ */

  const backLink = h('a', { class: 'icon-btn', href: '#/', 'aria-label': 'Back to library', title: 'Back to library' }, icon('arrowLeft'));
  const contentsButton = h(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': 'Contents', title: 'Contents (T)', 'aria-pressed': 'false', onclick: () => setSidebar(drawer.hidden) },
    icon('list'),
  );
  const titleEl = h('h1', { class: 'min-w-0 flex-1 truncate px-1 font-display text-base font-semibold sm:text-lg' }, 'Opening book');

  const flowButtons = FLOWS.map(([value, label, iconName]) =>
    h(
      'button',
      { type: 'button', 'aria-pressed': 'false', title: `${label} layout`, 'aria-label': `${label} layout`, dataset: { flow: value }, onclick: () => setFlow(value) },
      icon(iconName, 'size-4'),
      h('span', { class: 'hidden lg:inline' }, label),
    ),
  );
  const flowSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Reading layout' }, flowButtons);

  // Text settings popover
  const sizeLabel = h('span', { class: 'min-w-[3.25rem] text-center text-sm tabular-nums' }, '100%');
  const smaller = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Smaller text', title: 'Smaller text (-)', onclick: () => changeSize(-SIZES.step) }, h('span', { class: 'text-sm font-semibold' }, 'A'));
  const larger = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Larger text', title: 'Larger text (+)', onclick: () => changeSize(SIZES.step) }, h('span', { class: 'text-xl font-semibold' }, 'A'));
  const familyButtons = FAMILIES.map(([value, label]) => h('button', { type: 'button', 'aria-pressed': 'false', dataset: { family: value }, onclick: () => setOption('bookFamily', value, { family: value }) }, label));
  const spacingButtons = SPACINGS.map(([value, label]) => h('button', { type: 'button', 'aria-pressed': 'false', dataset: { spacing: value }, onclick: () => setOption('bookSpacing', value, { spacing: value }) }, label));
  const panelRow = (label, control) => h('div', { class: 'flex items-center justify-between gap-4' }, h('span', { class: 'text-sm text-muted' }, label), control);
  const textPanel = h(
    'div',
    { class: 'menu menu-end text-panel', role: 'dialog', 'aria-label': 'Text settings', hidden: true },
    h('div', { class: 'flex flex-col gap-3 p-3' },
      panelRow('Text size', h('div', { class: 'flex items-center' }, smaller, sizeLabel, larger)),
      panelRow('Typeface', h('div', { class: 'seg', role: 'group', 'aria-label': 'Typeface' }, familyButtons)),
      panelRow('Spacing', h('div', { class: 'seg', role: 'group', 'aria-label': 'Line spacing' }, spacingButtons)),
    ),
  );
  const textButton = h(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': 'Text settings', title: 'Text settings', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => setPanel(!panelOpen) },
    h('span', { class: 'font-display text-base font-semibold leading-none' }, 'Aa'),
  );
  const textHost = h('div', { class: 'relative' }, textButton, textPanel);

  const themeButton = h('button', { class: 'icon-btn', type: 'button', onclick: () => { setTheme(nextTheme()); renderThemeButton(); view?.relayout(); } });
  function renderThemeButton() {
    const theme = currentTheme();
    themeButton.replaceChildren(icon(THEME_ICONS[theme]));
    const label = `Reading theme: ${THEME_LABELS[theme]}. Switch to ${THEME_LABELS[nextTheme()]}.`;
    themeButton.setAttribute('aria-label', label);
    themeButton.title = label;
  }
  const fullscreenButton = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Full screen', title: 'Full screen (F)', onclick: () => toggleFullscreen() }, icon('maximize'));
  function renderFullscreenButton() {
    const on = Boolean(document.fullscreenElement);
    fullscreenButton.replaceChildren(icon(on ? 'minimize' : 'maximize'));
    fullscreenButton.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
  }

  const chromeHover = { onpointerenter: () => (hoveringChrome = true), onpointerleave: () => (hoveringChrome = false) };
  const topbar = h(
    'div',
    { class: 'chrome chrome-top', ...chromeHover },
    backLink,
    contentsButton,
    titleEl,
    flowSeg,
    textHost,
    themeButton,
    h('div', { class: 'hidden sm:block' }, fullscreenButton),
  );

  const chapterButton = h('button', { type: 'button', class: 'hidden max-w-[34%] truncate text-left font-display text-sm text-muted hover:text-ink sm:block', title: 'Open contents', onclick: () => setSidebar(true) });
  const scrub = h('input', { type: 'range', class: 'scrub', min: '0', max: '1000', value: '0', step: '1', 'aria-label': 'Position in the book', oninput: () => jumpToProgress(Number(scrub.value) / 1000, { debounced: true }) });
  const progressText = h('span', { class: 'min-w-[3.5rem] whitespace-nowrap text-right text-sm tabular-nums text-muted' }, '0%');
  const bottombar = h('div', { class: 'chrome chrome-bottom', ...chromeHover }, chapterButton, scrub, progressText);

  const prevButton = h('button', { class: 'chrome edge-nav edge-nav-prev', type: 'button', 'aria-label': 'Previous page', onclick: () => view?.previous() }, icon('chevronLeft', 'size-6'));
  const nextButton = h('button', { class: 'chrome edge-nav edge-nav-next', type: 'button', 'aria-label': 'Next page', onclick: () => view?.next() }, icon('chevronRight', 'size-6'));

  const stage = h('div', { class: 'book-stage', id: 'bookStage', 'data-loading': 'true' });
  const overlay = h('div', { class: 'overlay' });

  const contentsPanel = h('div', { class: 'min-h-0 flex-1 overflow-y-auto' });
  const drawer = h(
    'aside',
    { class: 'drawer', 'aria-label': 'Contents', hidden: true },
    h(
      'div',
      { class: 'flex items-center justify-between gap-2 border-b border-line p-3' },
      h('h2', { class: 'px-1 font-display text-lg font-semibold' }, 'Contents'),
      h('div', { class: 'md:hidden' }, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close contents', onclick: () => setSidebar(false) }, icon('x'))),
    ),
    contentsPanel,
  );
  const backdrop = h('div', { class: 'drawer-backdrop', hidden: true, onclick: () => setSidebar(false) });

  const ui = h(
    'div',
    { class: 'reader', dataset: { chrome: 'shown', layout: 'book', flow: settings.get('bookFlow') } },
    backdrop,
    drawer,
    h('div', { class: 'reader-main' }, stage, topbar, bottombar, prevButton, nextButton, overlay),
  );
  root.replaceChildren(ui);
  renderThemeButton();
  renderFullscreenButton();
  syncOptionButtons();

  /* ================================================================ *
   * Overlay (loading and errors)
   * ================================================================ */

  function showLoading(text) {
    overlay.hidden = false;
    if (!loadingText) {
      loadingText = h('p', { class: 'text-sm text-muted', role: 'status' }, text);
      loadingTitle = h('p', { class: 'font-display text-lg' }, state.book?.title ?? 'Opening book');
      overlay.replaceChildren(h('div', { class: 'flex max-w-sm flex-col items-center gap-4 text-center' }, h('div', { class: 'spinner' }), loadingTitle, loadingText));
    } else {
      loadingText.textContent = text;
      if (state.book) loadingTitle.textContent = state.book.title;
    }
  }

  function hideOverlay() {
    overlay.hidden = true;
    loadingText = null;
    loadingTitle = null;
  }

  function showError({ kind, message }) {
    loadingText = null;
    loadingTitle = null;
    overlay.hidden = false;
    const actions = [];
    if (kind === 'auth') {
      actions.push(h('button', { class: 'btn btn-primary', type: 'button', onclick: reconnect }, icon('cloud', 'size-4'), 'Reconnect Google Drive'));
    } else if (!['missing', 'forbidden', 'invalid', 'unsupported', 'drm'].includes(kind)) {
      actions.push(h('button', { class: 'btn btn-primary', type: 'button', onclick: () => load() }, 'Try again'));
    }
    actions.push(h('a', { class: 'btn btn-quiet', href: '#/' }, 'Back to library'));
    overlay.replaceChildren(
      h(
        'div',
        { class: 'max-w-sm text-center' },
        h('div', { class: 'mx-auto mb-4 grid size-12 place-items-center rounded-full bg-ink/10 text-accent' }, icon('alert', 'size-6')),
        h('h2', { class: 'font-display text-xl font-semibold' }, ERROR_TITLES[kind] ?? 'Could not open this book'),
        h('p', { class: 'mt-2 text-muted' }, message),
        h('div', { class: 'mt-6 flex flex-wrap justify-center gap-3' }, actions),
      ),
    );
  }

  async function reconnect() {
    try {
      await connect();
    } catch (error) {
      toast(error?.message ?? 'Could not connect to Google Drive.', { kind: 'error' });
      return;
    }
    load();
  }

  /* ================================================================ *
   * Loading
   * ================================================================ */

  async function resolveBook() {
    const cached = bookCache.get(bookId);
    if (cached) return cached;
    if (source === 'local') {
      const record = await db.get('files', fileId);
      if (!record) throw Object.assign(new Error('This file is no longer stored in this browser.'), { name: 'MissingLocalFile' });
      return localBook(record);
    }
    return getFileMeta(fileId);
  }

  async function getBlob(book) {
    if (book.source === 'local') {
      const record = await db.get('files', book.fileId);
      if (!record) throw Object.assign(new Error('This file is no longer stored in this browser.'), { name: 'MissingLocalFile' });
      return record.blob;
    }
    downloadController = new AbortController();
    return downloadFile(book.fileId, {
      signal: downloadController.signal,
      expectedSize: book.size,
      onProgress: (fraction) => !destroyed && showLoading(fraction ? `Downloading ${Math.round(fraction * 100)}%` : 'Downloading'),
    });
  }

  async function load() {
    showLoading('Opening');
    try {
      state.saved = await getProgress(bookId);
      state.book = await resolveBook();
      if (destroyed) return;
      // The format saved when the book was last opened is the one that worked (a Drive file may have no extension).
      if (state.saved?.format && state.saved.format !== 'pdf') state.book.format = state.saved.format;
      titleEl.textContent = state.book.title;
      document.title = `${state.book.title} - Bookworm`;
      showLoading('Opening');

      const blob = await getBlob(state.book);
      if (destroyed) return;
      showLoading('Reading the book');
      state.ebook = await openEbook(blob, state.book.format, state.book.name);
      if (destroyed) return state.ebook.destroy();
      start();
    } catch (error) {
      if (destroyed || error?.name === 'AbortError') return;
      showError(describeError(error));
    }
  }

  async function start() {
    const { ebook } = state;
    state.weights = ebook.sections.map((section) => section.size);
    state.total = state.weights.reduce((sum, size) => sum + size, 0) || 1;
    state.outline = ebook.outline;
    renderContents();

    view = createBookView({
      host: stage,
      book: ebook,
      onRelocate,
      onLink: handleLink,
      onTap: handleTap,
      onKey: onKeydown,
      onActivity: showChrome,
    });
    view.setOptions(readOptions());

    const saved = state.saved?.loc;
    const index = saved && saved.i >= 0 && saved.i < ebook.sections.length ? saved.i : 0;
    try {
      await view.open(index, { fraction: saved && saved.i === index ? saved.f : 0 });
    } catch (error) {
      if (!destroyed) showError(describeError(error));
      return;
    }
    if (destroyed) return;
    state.ready = true;
    hideOverlay();
    saveNow(); // refreshes "last opened" so the shelf sorts by recent reading
    showChrome();
    view.focus();
    cacheCover();
  }

  /** A Drive book has no cover until it has been opened once; remember it for the shelf. */
  async function cacheCover() {
    if (state.book.source !== 'drive') return;
    try {
      if ((await db.get('covers', state.book.id))?.blob) return;
      const raw = await state.ebook.cover();
      const blob = raw ? await toCoverBlob(raw) : null;
      if (blob && !destroyed) await db.put('covers', { id: state.book.id, version: state.book.modified, blob });
    } catch {
      /* the shelf keeps its plain cover */
    }
  }

  /* ================================================================ *
   * Position, progress and chapters
   * ================================================================ */

  function overall(index, fraction, atEnd) {
    if (atEnd) return 1;
    const before = state.weights.slice(0, index).reduce((sum, size) => sum + size, 0);
    return clamp((before + fraction * state.weights[index]) / state.total, 0, 1);
  }

  function chapterFor(index) {
    let best = null;
    for (const node of state.outline.flat) if (node.target && node.target.index <= index) best = node;
    return best;
  }

  function onRelocate(info) {
    state.location = info;
    const { ebook } = state;
    const progress = overall(info.index, info.fraction, info.atEnd);
    const fixed = ebook.fixed;
    scrub.value = String(Math.round(progress * 1000));
    scrub.style.setProperty('--pct', `${progress * 100}%`);
    progressText.textContent = fixed ? `${info.index + 1} / ${ebook.sections.length}` : `${Math.round(progress * 100)}%`;
    scrub.setAttribute('aria-valuetext', fixed ? `Page ${info.index + 1} of ${ebook.sections.length}` : `${Math.round(progress * 100)} percent`);
    prevButton.disabled = info.atStart;
    nextButton.disabled = info.atEnd;

    const chapter = chapterFor(info.index);
    chapterButton.textContent = chapter?.title ?? '';
    outlineView?.setActive(chapter);
    if (state.ready) queueSave();
  }

  function jumpToProgress(progress, { debounced = false } = {}) {
    if (!view) return;
    const go = () => {
      const { ebook } = state;
      if (ebook.fixed) {
        view.open(clamp(Math.round(progress * (ebook.sections.length - 1)), 0, ebook.sections.length - 1), {}).catch(() => {});
        return;
      }
      let position = progress * state.total;
      let index = 0;
      while (index < state.weights.length - 1 && position >= state.weights[index]) {
        position -= state.weights[index];
        index++;
      }
      view.open(index, { fraction: clamp(position / state.weights[index], 0, 0.999) }).catch(() => {});
    };
    if (debounced) goLater(go);
    else go();
  }
  const goLater = debounce((fn) => fn(), 160);

  function goTo({ index, fragment }) {
    if (!view) return;
    if (index === view.index) {
      if (fragment) view.scrollToFragment(fragment);
      else view.open(index, {}).catch(() => {});
    } else {
      view.open(index, { fragment }).catch(() => {});
    }
  }

  function handleLink(link) {
    if (link.kind === 'external') {
      if (/^(https?:|mailto:|tel:)/i.test(link.url)) window.open(link.url, '_blank', 'noopener,noreferrer');
      return;
    }
    const target = resolveLink(state.ebook, link.from, link.path, link.fragment);
    if (target) goTo(target);
    else toast('That link points outside this book.');
  }

  /* ================================================================ *
   * Contents drawer
   * ================================================================ */

  function renderContents() {
    if (state.outline.flat.length) {
      outlineView = createOutlineView({ host: contentsPanel, outline: state.outline, onGo: goToNode });
    } else {
      contentsPanel.replaceChildren(h('div', { class: 'p-6 text-sm text-muted' }, h('p', null, 'This book has no table of contents. Use the slider at the bottom to move around.')));
    }
  }

  function goToNode(node) {
    if (node.target) goTo(node.target);
    if (!isDesktop()) setSidebar(false);
    view?.focus();
  }

  function setSidebar(open) {
    drawer.hidden = !open;
    backdrop.hidden = !open || isDesktop();
    contentsButton.setAttribute('aria-pressed', String(open));
    if (open) requestAnimationFrame(() => outlineView?.revealActive());
    else view?.focus();
  }

  /* ================================================================ *
   * Text settings and layout
   * ================================================================ */

  function readOptions() {
    return {
      flow: settings.get('bookFlow'),
      fontSize: settings.get('bookSize'),
      family: settings.get('bookFamily'),
      spacing: settings.get('bookSpacing'),
    };
  }

  function syncOptionButtons() {
    const options = readOptions();
    for (const button of flowButtons) button.setAttribute('aria-pressed', String(button.dataset.flow === options.flow));
    for (const button of familyButtons) button.setAttribute('aria-pressed', String(button.dataset.family === options.family));
    for (const button of spacingButtons) button.setAttribute('aria-pressed', String(button.dataset.spacing === options.spacing));
    sizeLabel.textContent = `${options.fontSize}%`;
    smaller.disabled = options.fontSize <= SIZES.min;
    larger.disabled = options.fontSize >= SIZES.max;
    ui.dataset.flow = options.flow;
  }

  function setOption(key, value, viewOptions) {
    settings.set(key, value);
    syncOptionButtons();
    view?.setOptions(viewOptions);
  }

  function changeSize(delta) {
    const next = clamp(settings.get('bookSize') + delta, SIZES.min, SIZES.max);
    setOption('bookSize', next, { fontSize: next });
  }

  function setFlow(flow) {
    if (flow === settings.get('bookFlow')) return;
    setOption('bookFlow', flow, { flow });
    view?.focus();
  }

  function setPanel(open) {
    panelOpen = open;
    textPanel.hidden = !open;
    textButton.setAttribute('aria-expanded', String(open));
    if (open) showChrome();
  }
  const onDocumentPointerDown = (event) => {
    if (panelOpen && !textHost.contains(event.target)) setPanel(false);
  };
  document.addEventListener('pointerdown', onDocumentPointerDown);

  /* ================================================================ *
   * Chrome that fades away while you read
   * ================================================================ */

  function showChrome() {
    ui.dataset.chrome = 'shown';
    clearTimeout(chromeTimer);
    chromeTimer = setTimeout(maybeHideChrome, 3200);
  }

  function maybeHideChrome() {
    const busy = hoveringChrome || panelOpen || ui.querySelector('.menu:not([hidden])') || !overlay.hidden;
    if (busy) {
      chromeTimer = setTimeout(maybeHideChrome, 1500);
      return;
    }
    ui.dataset.chrome = 'hidden';
  }

  ui.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse') showChrome();
  });

  function handleTap(zone) {
    if (panelOpen) {
      setPanel(false);
      return;
    }
    if (zone === 'left') view?.previous();
    else if (zone === 'right') view?.next();
    else if (matchMedia('(pointer: coarse)').matches) {
      if (ui.dataset.chrome === 'shown') {
        ui.dataset.chrome = 'hidden';
        clearTimeout(chromeTimer);
      } else showChrome();
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else ui.requestFullscreen?.().catch(() => {});
  }
  const onFullscreenChange = () => {
    renderFullscreenButton();
    view?.relayout();
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);

  const refit = debounce(() => view?.relayout(), 120);
  const resizeObserver = new ResizeObserver(refit);
  resizeObserver.observe(stage);

  /* ================================================================ *
   * Keyboard (also called for keys pressed inside the page frame)
   * ================================================================ */

  function onKeydown(event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName ?? '') && event.key !== 'Escape') return;
    showChrome();
    if (event.key === 'Escape') {
      if (panelOpen) setPanel(false);
      else if (!drawer.hidden && !isDesktop()) setSidebar(false);
      return;
    }
    if (!view || !state.ready) return;

    const act = (fn) => {
      event.preventDefault();
      fn();
    };
    const scrolling = settings.get('bookFlow') === 'scroll';
    switch (event.key) {
      case 'ArrowRight':
        return act(() => (scrolling ? view.open(Math.min(state.ebook.sections.length - 1, view.index + 1), {}) : view.next()));
      case 'ArrowLeft':
        return act(() => (scrolling ? view.open(Math.max(0, view.index - 1), {}) : view.previous()));
      case 'PageDown':
        return act(() => view.next());
      case 'PageUp':
        return act(() => view.previous());
      case ' ':
        return act(() => (event.shiftKey ? view.previous() : view.next()));
      case 'Home':
        return act(() => view.open(0, {}));
      case 'End':
        return act(() => view.open(state.ebook.sections.length - 1, { end: true }));
      case '+':
      case '=':
        return act(() => changeSize(SIZES.step));
      case '-':
      case '_':
        return act(() => changeSize(-SIZES.step));
      case 't':
      case 'T':
        return act(() => setSidebar(drawer.hidden));
      case 'f':
      case 'F':
        return act(toggleFullscreen);
    }
  }
  document.addEventListener('keydown', onKeydown);

  /* ================================================================ *
   * Reading progress
   * ================================================================ */

  function saveNow() {
    const info = state.location;
    if (!state.book || !state.ebook || !state.ready || !info) return;
    const fixed = state.ebook.fixed;
    const progress = overall(info.index, info.fraction, info.atEnd);
    saveProgress({
      id: state.book.id,
      source: state.book.source,
      fileId: state.book.fileId,
      name: state.book.name,
      size: state.book.size,
      format: state.book.format,
      unit: fixed ? 'page' : 'percent',
      fraction: progress,
      // `page` and `numPages` keep the shelf's "started" check and ribbon working.
      page: fixed ? info.index + 1 : 1 + Math.round(progress * 999),
      numPages: fixed ? state.ebook.sections.length : 1000,
      loc: { i: info.index, f: info.fraction },
      updatedAt: Date.now(),
    });
  }
  const queueSave = debounce(saveNow, 700);
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') saveNow();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', saveNow);

  load();

  return function destroy() {
    destroyed = true;
    downloadController?.abort();
    queueSave.cancel();
    goLater.cancel?.();
    refit.cancel?.();
    saveNow();
    clearTimeout(chromeTimer);
    resizeObserver.disconnect();
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('pointerdown', onDocumentPointerDown);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', saveNow);
    view?.destroy();
    state.ebook?.destroy();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    root.replaceChildren();
  };
}
