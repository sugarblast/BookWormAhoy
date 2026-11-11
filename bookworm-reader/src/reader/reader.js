// The reader: a PDF.js PDFViewer wrapped in a quiet, book-like interface.
//
//  * Layouts: single page, two-page spread, continuous scroll.
//  * A page-turn animation when flipping (skipped for reduced-motion users).
//  * Zoom with fit-page / fit-width presets that re-fit on resize.
//  * A drawer with the PDF's table of contents (current chapter highlighted)
//    and a lazy page-thumbnail grid.
//  * Last page remembered per book; chrome fades out while you read.

import { clamp, createMenu, debounce, h, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { THEME_LABELS, currentTheme, nextTheme, setTheme, settings } from '../lib/settings.js';
import { connect } from '../lib/auth.js';
import { getFileMeta } from '../lib/drive.js';
import { bookCache, localBook } from '../lib/books.js';
import { db } from '../lib/db.js';
import { getProgress, saveProgress } from '../lib/progress.js';
import { PasswordResponses, chapterFor, describeOpenError, loadOutline, loadViewerLib, openBook } from '../lib/pdfdoc.js';
import { createOutlineView } from './outline.js';
import { createThumbnails } from './thumbnails.js';

const LAYOUTS = [
  ['single', 'Page', 'page'],
  ['spread', 'Spread', 'spread'],
  ['continuous', 'Scroll', 'scroll'],
];
const THEME_ICONS = { light: 'sun', sepia: 'tone', dark: 'moon' };
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const ERROR_TITLES = {
  auth: 'Reconnect to keep reading',
  password: 'Password needed',
  invalid: 'This PDF cannot be opened',
  missing: 'File not found',
  forbidden: 'No access to this file',
  network: 'The download failed',
};

export function mountReader(root, { source, fileId }) {
  const bookId = `${source}:${fileId}`;
  const state = {
    book: null,
    pdf: null,
    task: null,
    outline: { tree: [], flat: [] },
    ready: false,
    flipAllowed: true,
    saved: null,
    passwordDeclined: false,
    modes: null,
  };
  let destroyed = false;
  let viewer = null;
  let linkService = null;
  let outlineView = null;
  let thumbs = null;
  let numPages = 0;
  let zoomMode = settings.get('zoom'); // a preset name, or a numeric string for a session-only zoom
  let hoveringChrome = false;
  let chromeTimer = 0;
  let firstRendered = false;
  let loadingText = null;
  let loadingTitle = null;

  const isPageMode = () => settings.get('layout') !== 'continuous';
  const isDesktop = () => window.innerWidth >= 768;
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ================================================================ *
   * Interface
   * ================================================================ */

  const backLink = h('a', { class: 'icon-btn', href: '#/', 'aria-label': 'Back to library', title: 'Back to library' }, icon('arrowLeft'));
  const contentsButton = h(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': 'Contents and pages', title: 'Contents and pages (T)', 'aria-pressed': 'false', onclick: () => setSidebar(drawer.hidden) },
    icon('list'),
  );
  const titleEl = h('h1', { class: 'min-w-0 flex-1 truncate px-1 font-display text-base font-semibold sm:text-lg' }, 'Opening book');

  const layoutButtons = LAYOUTS.map(([value, label, iconName]) =>
    h(
      'button',
      { type: 'button', 'aria-pressed': 'false', title: `${label} layout`, 'aria-label': `${label} layout`, dataset: { layout: value }, onclick: () => setLayout(value) },
      icon(iconName, 'size-4'),
      h('span', { class: 'hidden lg:inline' }, label),
    ),
  );
  const layoutSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Page layout' }, layoutButtons);

  const zoomLabel = h('button', { class: 'btn h-10 min-w-[4.25rem] px-2 text-sm tabular-nums hover:bg-ink/8', type: 'button', 'aria-label': 'Zoom options' }, 'Fit');
  const zoomHost = h('div', { class: 'relative' }, zoomLabel);
  createMenu({ anchor: zoomLabel, host: zoomHost, getItems: zoomMenuItems });
  const zoomGroup = h(
    'div',
    { class: 'hidden items-center sm:flex' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Zoom out', title: 'Zoom out (-)', onclick: () => viewer && zoomBy(1 / 1.15) }, icon('minus')),
    zoomHost,
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Zoom in', title: 'Zoom in (+)', onclick: () => viewer && zoomBy(1.15) }, icon('plus')),
  );

  const themeButton = h('button', { class: 'icon-btn', type: 'button', onclick: () => { setTheme(nextTheme()); renderThemeButton(); } });
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
    layoutSeg,
    zoomGroup,
    themeButton,
    h('div', { class: 'hidden sm:block' }, fullscreenButton),
  );

  const chapterButton = h('button', { type: 'button', class: 'hidden max-w-[34%] truncate text-left font-display text-sm text-muted hover:text-ink sm:block', title: 'Open contents', onclick: () => setSidebar(true, 'contents') });
  const scrub = h('input', { type: 'range', class: 'scrub', min: '1', max: '1', value: '1', step: '1', 'aria-label': 'Page', oninput: () => jumpTo(Number(scrub.value), { debounced: true }) });
  const pageInput = h('input', {
    type: 'number',
    class: 'page-input',
    min: '1',
    value: '1',
    inputmode: 'numeric',
    'aria-label': 'Page number',
    onfocus: () => pageInput.select(),
    onkeydown: (event) => {
      if (event.key === 'Enter') pageInput.blur();
    },
    onchange: () => {
      const wanted = clamp(parseInt(pageInput.value, 10) || 1, 1, numPages || 1);
      pageInput.value = String(wanted);
      jumpTo(wanted);
    },
  });
  const pageTotal = h('span', { class: 'whitespace-nowrap text-sm tabular-nums text-muted' }, '/ 1');
  const bottombar = h('div', { class: 'chrome chrome-bottom', ...chromeHover }, chapterButton, scrub, h('div', { class: 'flex items-center gap-2' }, pageInput, pageTotal));

  const prevButton = h('button', { class: 'chrome edge-nav edge-nav-prev', type: 'button', 'aria-label': 'Previous page', onclick: () => viewer?.previousPage() }, icon('chevronLeft', 'size-6'));
  const nextButton = h('button', { class: 'chrome edge-nav edge-nav-next', type: 'button', 'aria-label': 'Next page', onclick: () => viewer?.nextPage() }, icon('chevronRight', 'size-6'));

  const container = h('div', { class: 'viewer-container', id: 'viewerContainer', tabindex: '0', 'aria-label': 'Book pages' });
  const viewerEl = h('div', { class: 'pdfViewer', id: 'viewer' });
  container.append(viewerEl);

  const overlay = h('div', { class: 'overlay' });

  // Drawer: Contents / Pages
  const tabContents = h('button', { type: 'button', 'aria-pressed': 'true', onclick: () => showTab('contents') }, 'Contents');
  const tabPages = h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => showTab('pages') }, 'Pages');
  const contentsPanel = h('div', { class: 'min-h-0 flex-1 overflow-y-auto' });
  const pagesPanel = h('div', { class: 'min-h-0 flex-1 overflow-y-auto', hidden: true });
  const drawer = h(
    'aside',
    { class: 'drawer', 'aria-label': 'Contents and pages', hidden: true },
    h(
      'div',
      { class: 'flex items-center justify-between gap-2 border-b border-line p-3' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Sidebar section' }, tabContents, tabPages),
      h('div', { class: 'md:hidden' }, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close sidebar', onclick: () => setSidebar(false) }, icon('x'))),
    ),
    contentsPanel,
    pagesPanel,
  );
  const backdrop = h('div', { class: 'drawer-backdrop', hidden: true, onclick: () => setSidebar(false) });

  const ui = h(
    'div',
    { class: 'reader', dataset: { chrome: 'shown', layout: settings.get('layout') } },
    backdrop,
    drawer,
    h('div', { class: 'reader-main' }, container, topbar, bottombar, prevButton, nextButton, overlay),
  );
  root.replaceChildren(ui);
  renderThemeButton();
  renderFullscreenButton();
  syncLayoutButtons();

  /* ================================================================ *
   * Overlay (loading and errors)
   * ================================================================ */

  function showLoading(text) {
    overlay.hidden = false;
    if (!loadingText) {
      loadingText = h('p', { class: 'text-sm text-muted', role: 'status' }, text);
      loadingTitle = h('p', { class: 'font-display text-lg' }, state.book?.title ?? 'Opening book');
      overlay.replaceChildren(
        h('div', { class: 'flex max-w-sm flex-col items-center gap-4 text-center' }, h('div', { class: 'spinner' }), loadingTitle, loadingText),
      );
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
    } else if (!['missing', 'forbidden', 'invalid'].includes(kind)) {
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

  async function load() {
    showLoading('Opening');
    state.passwordDeclined = false;
    try {
      state.saved = await getProgress(bookId);
      state.book = await resolveBook();
      if (destroyed) return;
      titleEl.textContent = state.book.title;
      document.title = `${state.book.title} - Bookworm`;
      showLoading('Opening');

      const { pdf, task } = await openBook(state.book, {
        onProgress: ({ loaded, total }) => {
          if (total && !destroyed && !state.ready) showLoading(`Downloading ${Math.round((loaded / total) * 100)}%`);
        },
        onPassword: (update, reason, loadingTask) => {
          const message =
            reason === PasswordResponses.INCORRECT_PASSWORD
              ? 'That password was not accepted. Try again:'
              : 'This PDF is password-protected. Enter the password:';
          const entered = window.prompt(message);
          if (entered == null) {
            state.passwordDeclined = true;
            loadingTask.destroy();
          } else update(entered);
        },
      });
      if (destroyed) {
        task.destroy();
        return;
      }
      state.pdf = pdf;
      state.task = task;
      await startViewer();
    } catch (error) {
      if (destroyed) return;
      showError(state.passwordDeclined ? { kind: 'password', message: 'This PDF is password-protected and no password was entered.' } : describeOpenError(error));
    }
  }

  async function startViewer() {
    const lib = await loadViewerLib();
    if (destroyed) return;
    const { EventBus, PDFLinkService, PDFViewer, ScrollMode, SpreadMode, LinkTarget } = lib;
    state.modes = { ScrollMode, SpreadMode };

    const eventBus = new EventBus();
    linkService = new PDFLinkService({
      eventBus,
      externalLinkTarget: LinkTarget?.BLANK ?? 2,
      externalLinkRel: 'noopener noreferrer nofollow',
    });
    viewer = new PDFViewer({
      container,
      viewer: viewerEl,
      eventBus,
      linkService,
      removePageBorders: true,
      textLayerMode: 1,
    });
    linkService.setViewer(viewer);

    eventBus.on('pagesinit', onPagesInit);
    eventBus.on('pagechanging', onPageChanging);
    eventBus.on('scalechanging', onScaleChanging);
    eventBus.on('pagerendered', onPageRendered);

    numPages = state.pdf.numPages;
    scrub.max = String(numPages);
    pageInput.max = String(numPages);
    pageTotal.textContent = `/ ${numPages}`;

    applyLayoutModes(settings.get('layout'));
    viewer.setDocument(state.pdf);
    linkService.setDocument(state.pdf, null);
    loadSidebar();
  }

  function onPagesInit() {
    applyZoom();
    const saved = state.saved;
    if (saved && saved.page > 1 && saved.page <= numPages) viewer.currentPageNumber = saved.page;
    state.ready = true;
    updatePageUi(viewer.currentPageNumber);
    saveNow(); // refreshes "last opened" so the shelf sorts by recent reading
    container.focus({ preventScroll: true });
    showChrome();
  }

  function onPageRendered() {
    if (firstRendered) return;
    firstRendered = true;
    hideOverlay();
  }

  function onPageChanging({ pageNumber, previous }) {
    updatePageUi(pageNumber);
    if (!state.ready) return;
    queueSave();
    if (isPageMode() && state.flipAllowed && previous && previous !== pageNumber) flip(pageNumber > previous ? 1 : -1);
  }

  function onScaleChanging({ scale }) {
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  }

  /* ================================================================ *
   * Layout, zoom, page turning
   * ================================================================ */

  function applyLayoutModes(layout) {
    const { ScrollMode, SpreadMode } = state.modes;
    if (layout === 'continuous') {
      viewer.scrollMode = ScrollMode.VERTICAL;
      viewer.spreadMode = SpreadMode.NONE;
    } else if (layout === 'spread') {
      viewer.scrollMode = ScrollMode.PAGE;
      viewer.spreadMode = SpreadMode.EVEN; // cover alone, then facing pages 2-3, 4-5, like a printed book
    } else {
      viewer.scrollMode = ScrollMode.PAGE;
      viewer.spreadMode = SpreadMode.NONE;
    }
    ui.dataset.layout = layout;
    syncLayoutButtons();
  }

  function syncLayoutButtons() {
    const layout = settings.get('layout');
    for (const button of layoutButtons) button.setAttribute('aria-pressed', String(button.dataset.layout === layout));
  }

  function setLayout(layout) {
    if (layout === settings.get('layout')) return;
    settings.set('layout', layout);
    if (!viewer) {
      ui.dataset.layout = layout;
      syncLayoutButtons();
      return;
    }
    const page = viewer.currentPageNumber;
    state.flipAllowed = false;
    applyLayoutModes(layout);
    applyZoom();
    viewer.currentPageNumber = page;
    requestAnimationFrame(() => {
      viewer.scrollPageIntoView({ pageNumber: page });
      state.flipAllowed = true;
    });
  }

  const resolvedZoom = () =>
    zoomMode === 'smart' ? (settings.get('layout') === 'continuous' ? 'page-width' : 'page-fit') : zoomMode;

  function applyZoom() {
    if (viewer) viewer.currentScaleValue = resolvedZoom();
  }

  function setZoomPreset(value) {
    zoomMode = value;
    if (Number.isNaN(Number(value))) settings.set('zoom', value); // presets persist; exact zooms are per session
    applyZoom();
  }

  function zoomBy(factor) {
    const next = clamp(viewer.currentScale * factor, 0.25, 5);
    zoomMode = String(Number(next.toFixed(3)));
    applyZoom();
  }

  function zoomMenuItems() {
    const resolved = resolvedZoom();
    return [
      { label: 'Fit page', checked: resolved === 'page-fit', onSelect: () => setZoomPreset('page-fit') },
      { label: 'Fit width', checked: resolved === 'page-width', onSelect: () => setZoomPreset('page-width') },
      { separator: true },
      ...ZOOM_STEPS.map((step) => ({
        label: `${Math.round(step * 100)}%`,
        checked: resolved === String(step),
        onSelect: () => setZoomPreset(String(step)),
      })),
    ];
  }

  // Re-fit when the window or drawer changes the available space.
  const refit = debounce(() => {
    if (viewer && state.ready && Number.isNaN(Number(resolvedZoom()))) {
      applyZoom();
      viewer.update();
    }
  }, 100);
  const resizeObserver = new ResizeObserver(refit);
  resizeObserver.observe(container);

  function flip(direction) {
    if (reducedMotion() || !viewerEl.animate) return;
    viewerEl.animate(
      [
        { opacity: 0.1, transform: `perspective(1600px) translateX(${direction * 40}px) rotateY(${direction * -4}deg)` },
        { opacity: 1, transform: 'perspective(1600px) translateX(0px) rotateY(0deg)' },
      ],
      { duration: 260, easing: 'cubic-bezier(.2,.7,.2,1)' },
    );
  }

  const goTo = debounce((page) => {
    if (viewer) viewer.currentPageNumber = page;
  }, 40);
  function jumpTo(page, { debounced = false } = {}) {
    if (!viewer) return;
    if (debounced) goTo(clamp(page, 1, numPages));
    else viewer.currentPageNumber = clamp(page, 1, numPages);
  }

  /* ================================================================ *
   * Page indicators and chapter tracking
   * ================================================================ */

  function updatePageUi(page) {
    if (document.activeElement !== pageInput) pageInput.value = String(page);
    scrub.value = String(page);
    scrub.style.setProperty('--pct', `${numPages > 1 ? ((page - 1) / (numPages - 1)) * 100 : 0}%`);
    prevButton.disabled = page <= 1;
    nextButton.disabled = page >= numPages;

    const chapter = chapterFor(state.outline.flat, page);
    chapterButton.textContent = chapter?.title ?? '';
    outlineView?.setActive(chapter);
    thumbs?.setCurrent(page);
  }

  /* ================================================================ *
   * Sidebar: contents and page thumbnails
   * ================================================================ */

  async function loadSidebar() {
    try {
      state.outline = await loadOutline(state.pdf);
    } catch {
      state.outline = { tree: [], flat: [] };
    }
    if (destroyed) return;

    if (state.outline.flat.length) {
      outlineView = createOutlineView({ host: contentsPanel, outline: state.outline, onGo: goToNode });
    } else {
      contentsPanel.replaceChildren(
        h(
          'div',
          { class: 'p-6 text-sm text-muted' },
          h('p', null, 'This PDF has no table of contents.'),
          h('button', { class: 'btn btn-quiet mt-4', type: 'button', onclick: () => showTab('pages') }, 'Browse pages'),
        ),
      );
    }
    if (viewer) updatePageUi(viewer.currentPageNumber);

    try {
      thumbs = await createThumbnails({ pdf: state.pdf, host: pagesPanel, onGo: goToPage });
      if (destroyed) return thumbs.destroy();
      if (viewer) thumbs.setCurrent(viewer.currentPageNumber);
    } catch {
      /* thumbnails are optional */
    }
  }

  function goToNode(node) {
    if (node.dest) linkService.goToDestination(node.dest);
    else if (node.page) viewer.currentPageNumber = node.page;
    else if (node.url && /^https?:\/\//i.test(node.url)) window.open(node.url, '_blank', 'noopener,noreferrer');
    if (!isDesktop()) setSidebar(false);
    container.focus({ preventScroll: true });
  }

  function goToPage(page) {
    viewer.currentPageNumber = page;
    if (!isDesktop()) setSidebar(false);
    container.focus({ preventScroll: true });
  }

  function showTab(tab) {
    settings.set('sidebarTab', tab);
    tabContents.setAttribute('aria-pressed', String(tab === 'contents'));
    tabPages.setAttribute('aria-pressed', String(tab === 'pages'));
    contentsPanel.hidden = tab !== 'contents';
    pagesPanel.hidden = tab !== 'pages';
    requestAnimationFrame(() => (tab === 'contents' ? outlineView?.revealActive() : thumbs?.revealCurrent()));
  }

  function setSidebar(open, tab) {
    drawer.hidden = !open;
    backdrop.hidden = !open || isDesktop();
    contentsButton.setAttribute('aria-pressed', String(open));
    if (isDesktop()) settings.set('sidebar', open);
    if (open) showTab(tab ?? settings.get('sidebarTab'));
  }

  if (isDesktop() && settings.get('sidebar')) setSidebar(true);

  /* ================================================================ *
   * Chrome that fades away while you read
   * ================================================================ */

  function showChrome() {
    ui.dataset.chrome = 'shown';
    clearTimeout(chromeTimer);
    chromeTimer = setTimeout(maybeHideChrome, 3200);
  }

  function maybeHideChrome() {
    const busy = hoveringChrome || ui.querySelector('.menu') || document.activeElement === pageInput || !overlay.hidden;
    if (busy) {
      chromeTimer = setTimeout(maybeHideChrome, 1500);
      return;
    }
    ui.dataset.chrome = 'hidden';
  }

  ui.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse') showChrome();
  });
  container.addEventListener('click', () => {
    if (!matchMedia('(pointer: coarse)').matches) return;
    if (ui.dataset.chrome === 'shown') {
      ui.dataset.chrome = 'hidden';
      clearTimeout(chromeTimer);
    } else showChrome();
  });

  // Swipe to turn pages on touch screens (only when the page is not panned/zoomed).
  let swipe = null;
  container.addEventListener('pointerdown', (event) => {
    swipe = event.pointerType === 'touch' && event.isPrimary ? { x: event.clientX, y: event.clientY, t: performance.now() } : null;
  });
  container.addEventListener('pointercancel', () => (swipe = null));
  container.addEventListener('pointerup', (event) => {
    if (!swipe || !viewer || !isPageMode()) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    const dt = performance.now() - swipe.t;
    swipe = null;
    if (dt > 700 || Math.abs(dx) < 70 || Math.abs(dy) > 50) return;
    if (container.scrollWidth > container.clientWidth + 4) return;
    if (dx < 0) viewer.nextPage();
    else viewer.previousPage();
  });

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else ui.requestFullscreen?.().catch(() => {});
  }
  const onFullscreenChange = () => renderFullscreenButton();
  document.addEventListener('fullscreenchange', onFullscreenChange);

  /* ================================================================ *
   * Keyboard
   * ================================================================ */

  const canScrollVertically = () => container.scrollHeight > container.clientHeight + 4;

  function onKeydown(event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName ?? '') && event.key !== 'Escape') return;
    showChrome();
    if (event.key === 'Escape') {
      if (!drawer.hidden && !isDesktop()) setSidebar(false);
      return;
    }
    if (!viewer || !state.ready) return;

    const act = (fn) => {
      event.preventDefault();
      fn();
    };
    const paged = isPageMode();
    switch (event.key) {
      case 'ArrowRight':
        return act(() => viewer.nextPage());
      case 'ArrowLeft':
        return act(() => viewer.previousPage());
      case 'PageDown':
        if (paged && !canScrollVertically()) act(() => viewer.nextPage());
        return;
      case 'PageUp':
        if (paged && !canScrollVertically()) act(() => viewer.previousPage());
        return;
      case ' ':
        if (paged && !canScrollVertically()) act(() => (event.shiftKey ? viewer.previousPage() : viewer.nextPage()));
        return;
      case 'Home':
        return act(() => (viewer.currentPageNumber = 1));
      case 'End':
        return act(() => (viewer.currentPageNumber = numPages));
      case '+':
      case '=':
        return act(() => zoomBy(1.15));
      case '-':
      case '_':
        return act(() => zoomBy(1 / 1.15));
      case '0':
        return act(() => setZoomPreset(paged ? 'page-fit' : 'page-width'));
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
    if (!state.book || !viewer || !state.ready) return;
    saveProgress({
      id: state.book.id,
      source: state.book.source,
      fileId: state.book.fileId,
      name: state.book.name,
      size: state.book.size,
      page: viewer.currentPageNumber,
      numPages,
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
    queueSave.cancel();
    saveNow();
    clearTimeout(chromeTimer);
    resizeObserver.disconnect();
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', saveNow);
    thumbs?.destroy();
    try {
      viewer?.cleanup();
    } catch {
      /* viewer was never fully initialised */
    }
    state.task?.destroy();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    root.replaceChildren();
  };
}
