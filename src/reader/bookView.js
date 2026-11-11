// The page surface of the book reader.
//
// One chapter at a time is shown inside a sandboxed iframe (no scripts, same
// origin so this file can lay it out). It is laid out either as pages, using CSS
// columns that are scrolled sideways one viewport at a time, or as one long
// scroll. Text size, typeface, spacing and the theme colours are applied here,
// and the book's own colours and fonts were already stripped by lib/ebook/html.js.

const FAMILIES = {
  serif: '"Literata Variable", Charter, "Iowan Old Style", "Palatino Linotype", Georgia, serif',
  sans: '"Hanken Grotesk Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};
const LINE_HEIGHTS = { compact: 1.4, normal: 1.62, relaxed: 1.85 };
const BASE_PX = 18;

const escapeAttribute = (text = '') => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let fontFaces = null;
/** The page's own @font-face rules for the reading fonts, so the frame can use them too. */
function fontFaceCss() {
  if (fontFaces != null) return fontFaces;
  const rules = [];
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule.type === 5 && /Literata|Hanken/i.test(rule.style.getPropertyValue('font-family'))) rules.push(rule.cssText);
      }
    } catch {
      /* a cross-origin stylesheet: not ours */
    }
  }
  fontFaces = rules.join('\n');
  return fontFaces;
}

export function readTheme() {
  const styles = getComputedStyle(document.documentElement);
  const pick = (name) => styles.getPropertyValue(name).trim();
  return {
    bg: pick('--page-bg') || '#ffffff',
    fg: pick('--ink') || '#161d29',
    link: pick('--accent') || '#1b6b55',
    muted: pick('--muted') || '#5d6878',
    line: pick('--line') || '#d3d8de',
    scheme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  };
}

/**
 * @param {object} options
 * @param {HTMLElement} options.host         element the frame fills
 * @param {object} options.book              from lib/ebook (open, sections, load...)
 * @param {(info) => void} options.onRelocate  called whenever the position changes
 * @param {(link) => void} options.onLink      a link inside the book was clicked
 * @param {(zone) => void} options.onTap       'left' | 'right' | 'center'
 * @param {(event) => void} options.onKey      key presses that happen inside the frame
 * @param {() => void} options.onActivity      the mouse moved inside the frame (so the toolbars can reappear)
 */
export function createBookView({ host, book, onRelocate, onLink, onTap, onKey, onActivity }) {
  const iframe = document.createElement('iframe');
  iframe.className = 'book-frame';
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.setAttribute('title', 'Book text');
  host.append(iframe);

  const state = {
    index: -1,
    chapter: null,
    doc: null,
    page: 0,
    pageCount: 1,
    loading: false,
    generation: 0,
    stamp: 0,
    geometry: null,
    options: { flow: 'paged', fontSize: 100, family: 'serif', spacing: 'normal' },
  };

  /* ---------------------------------------------------------------- *
   * Geometry and CSS
   * ---------------------------------------------------------------- */

  function computeGeometry() {
    const W = Math.max(200, host.clientWidth);
    const H = Math.max(200, host.clientHeight);
    const fontPx = (BASE_PX * state.options.fontSize) / 100;
    const minPad = W < 480 ? 20 : 32;
    const columns = state.options.flow === 'paged' && !book.fixed && W >= 1180 ? 2 : 1;
    const colW = Math.min(fontPx * 36, (W - 2 * minPad - (columns - 1) * 2 * minPad) / columns);
    const padH = (W - columns * colW) / (2 * columns);
    const padV = Math.round(Math.min(40, Math.max(20, H * 0.04)));
    return {
      W,
      H,
      fontPx,
      columns,
      colW,
      padH,
      padV,
      gap: 2 * padH,
      contentW: columns * colW + (columns - 1) * 2 * padH,
      contentH: H - 2 * padV,
      measure: Math.min(W - 2 * minPad, fontPx * 38),
      minPad,
    };
  }

  function baseCss(theme, geometry) {
    const { family, spacing } = state.options;
    return `
      ${fontFaceCss()}
      :root { color-scheme: ${theme.scheme}; }
      html { background: ${theme.bg}; color: ${theme.fg}; font-size: ${geometry.fontPx}px; -webkit-text-size-adjust: 100%; }
      body { margin: 0; font-family: ${FAMILIES[family]}; line-height: ${LINE_HEIGHTS[spacing]}; color: ${theme.fg};
        hyphens: auto; -webkit-hyphens: auto; overflow-wrap: break-word; text-rendering: optimizeLegibility; }
      p { margin: 0 0 0.85em; }
      h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.3em 0 0.6em; break-after: avoid; }
      a { color: ${theme.link}; }
      hr { border: 0; border-top: 1px solid ${theme.line}; margin: 1.5em 0; }
      blockquote { margin: 1em 1.5em; }
      ul, ol { padding-left: 1.6em; }
      table { border-collapse: collapse; max-width: 100%; }
      td, th { padding: 0.25em 0.5em; border: 1px solid ${theme.line}; }
      pre { white-space: pre-wrap; }
      ::selection { background: color-mix(in oklab, ${theme.link} 35%, transparent); }
    `;
  }

  function forceCss(theme, geometry) {
    const { W, H, padV, padH, gap, contentW, contentH, colW, measure, minPad } = geometry;
    const common = `
      html, body { background: ${theme.bg}; }
      img, svg, video { max-width: 100% !important; object-fit: contain; }
      a[data-bw] { cursor: pointer; }
      .bw-nav { display: block; margin: 2.5em auto 1.2em; padding: 0.65em 1.3em; border: 1px solid ${theme.line}; border-radius: 0.5rem;
        background: transparent; color: ${theme.link}; font: inherit; font-size: 0.9em; cursor: pointer; }
      .bw-nav:hover { background: color-mix(in oklab, ${theme.fg} 7%, transparent); }
    `;
    if (book.fixed) {
      return state.options.flow === 'paged'
        ? `${common}
          html { height: ${H}px; overflow: hidden; }
          body { width: ${W}px; height: ${H}px; display: flex; align-items: center; justify-content: center; }
          img.bw-page { max-width: ${W - 16}px !important; max-height: ${H - 16}px !important; display: block; }
          .bw-end, .bw-start { display: none; }`
        : `${common}
          html { overflow-y: auto; overflow-x: hidden; }
          body { max-width: ${Math.min(W, 1000)}px; margin: 0 auto; }
          img.bw-page { width: 100%; height: auto; display: block; }
          .bw-end, .bw-start { display: block; }`;
    }
    if (state.options.flow === 'paged') {
      return `${common}
        html { height: ${H}px; overflow: hidden; }
        body { box-sizing: content-box; width: ${contentW}px; height: ${contentH}px; padding: ${padV}px ${padH}px;
          column-width: ${colW}px; column-gap: ${gap}px; column-fill: auto; orphans: 2; widows: 2; }
        img, svg, video { max-height: ${contentH}px !important; }
        img, figure, tr { break-inside: avoid; }
        .bw-end, .bw-start { display: none; }`;
    }
    return `${common}
      html { overflow-y: auto; overflow-x: hidden; }
      body { max-width: ${measure}px; margin: 0 auto; padding: ${padV}px ${minPad}px ${padV * 2}px; }
      img, svg, video { height: auto; }
      .bw-end, .bw-start { display: block; }`;
  }

  function documentHtml(chapter, theme, geometry) {
    const lang = escapeAttribute(chapter.lang || book.metadata.language || '');
    const dir = chapter.dir === 'rtl' ? 'rtl' : 'ltr';
    const start = state.index > 0 ? '<div class="bw-start"><button class="bw-nav" type="button" data-bw-nav="prev">Previous section</button></div>' : '';
    const end = state.index < book.sections.length - 1 ? '<div class="bw-end"><button class="bw-nav" type="button" data-bw-nav="next">Next section</button></div>' : '';
    return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style id="bw-base">${baseCss(theme, geometry)}</style>
<style id="bw-book">${chapter.css || ''}</style>
<style id="bw-force">${forceCss(theme, geometry)}</style>
</head><body id="${escapeAttribute(chapter.bodyId)}" class="${escapeAttribute(chapter.bodyClass)}">${start}${chapter.bodyHtml}${end}<!-- ${++state.stamp} --></body></html>`;
  }

  function writeStyles() {
    const doc = state.doc;
    if (!doc) return;
    const theme = readTheme();
    const geometry = (state.geometry = computeGeometry());
    doc.getElementById('bw-base').textContent = baseCss(theme, geometry);
    doc.getElementById('bw-force').textContent = forceCss(theme, geometry);
  }

  /* ---------------------------------------------------------------- *
   * Position
   * ---------------------------------------------------------------- */

  const scroller = () => state.doc?.scrollingElement ?? state.doc?.documentElement;
  const paged = () => state.options.flow === 'paged';

  function fraction() {
    const el = scroller();
    if (!el) return 0;
    if (paged()) return state.page / state.pageCount;
    const room = el.scrollHeight - el.clientHeight;
    return room > 0 ? el.scrollTop / room : 0;
  }

  function measure() {
    const el = scroller();
    if (!el) return;
    if (paged()) {
      const step = state.geometry.W;
      state.pageCount = Math.max(1, Math.ceil((el.scrollWidth - 2) / step));
      state.page = Math.min(state.page, state.pageCount - 1);
    } else {
      state.pageCount = 1;
      state.page = 0;
    }
  }

  function applyPage() {
    const el = scroller();
    if (el && paged()) el.scrollLeft = state.page * state.geometry.W;
  }

  function emit() {
    if (!state.doc || state.loading) return;
    const el = scroller();
    const atTop = paged() ? state.page === 0 : el.scrollTop <= 1;
    const atBottom = paged() ? state.page >= state.pageCount - 1 : el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    onRelocate?.({
      index: state.index,
      fraction: fraction(),
      page: state.page,
      pageCount: state.pageCount,
      atStart: state.index === 0 && atTop,
      atEnd: state.index === book.sections.length - 1 && atBottom,
    });
  }

  function findElement(fragment) {
    if (!fragment) return null;
    const doc = state.doc;
    return doc.getElementById(fragment) ?? doc.getElementsByName(fragment)[0] ?? null;
  }

  function place({ fraction: wanted = 0, fragment = '', end = false } = {}) {
    const el = scroller();
    const target = fragment ? findElement(fragment) : null;
    if (paged()) {
      if (target) {
        const x = target.getBoundingClientRect().left + el.scrollLeft;
        state.page = Math.min(state.pageCount - 1, Math.max(0, Math.floor(x / state.geometry.W)));
      } else if (end) state.page = state.pageCount - 1;
      else state.page = Math.min(state.pageCount - 1, Math.max(0, Math.floor(wanted * state.pageCount + 1e-6)));
      applyPage();
    } else if (target) {
      target.scrollIntoView({ block: 'start' });
    } else if (end) {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTop = wanted * Math.max(0, el.scrollHeight - el.clientHeight);
    }
  }

  function setPage(page, direction = 0) {
    state.page = Math.min(state.pageCount - 1, Math.max(0, page));
    applyPage();
    if (direction && !reducedMotion() && iframe.animate) {
      iframe.animate(
        [
          { opacity: 0.35, transform: `translateX(${direction * 22}px)` },
          { opacity: 1, transform: 'translateX(0)' },
        ],
        { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' },
      );
    }
    emit();
  }

  /* ---------------------------------------------------------------- *
   * Loading chapters
   * ---------------------------------------------------------------- */

  function loadFrame(html) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 6000);
      iframe.addEventListener(
        'load',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      iframe.srcdoc = html;
    });
  }

  async function settle(doc) {
    const waits = [...doc.images].filter((image) => !image.complete).map((image) => new Promise((done) => {
      image.addEventListener('load', done, { once: true });
      image.addEventListener('error', done, { once: true });
    }));
    await Promise.race([Promise.all([...waits, doc.fonts?.ready ?? null]), new Promise((done) => setTimeout(done, 3500))]);
  }

  async function open(index, target = {}) {
    if (index < 0 || index >= book.sections.length) return false;
    const token = ++state.generation;
    state.loading = true;
    host.dataset.loading = 'true';
    let chapter;
    try {
      chapter = await book.load(index);
    } catch (error) {
      if (token === state.generation) {
        state.loading = false;
        host.dataset.loading = 'false';
      }
      throw error;
    }
    if (token !== state.generation) {
      chapter.revoke();
      return false;
    }
    const previous = state.chapter;
    const previousIndex = state.index;
    state.index = index;
    state.geometry = computeGeometry();
    await loadFrame(documentHtml(chapter, readTheme(), state.geometry));
    if (token !== state.generation) {
      chapter.revoke();
      state.index = previousIndex;
      return false;
    }
    previous?.revoke();
    state.chapter = chapter;
    state.doc = iframe.contentDocument;
    bind(state.doc);
    await settle(state.doc);
    if (token !== state.generation) return false;
    writeStyles();
    state.page = 0;
    measure();
    place(target);
    state.loading = false;
    host.dataset.loading = 'false';
    emit();
    state.doc.fonts?.ready?.then(() => token === state.generation && relayout());
    return true;
  }

  /** Re-lays out the current chapter (new size, text size or theme) and stays at the same place. */
  function relayout(keep = null) {
    if (!state.doc || state.loading) return;
    if (keep == null) keep = fraction();
    writeStyles();
    measure();
    place({ fraction: keep });
    emit();
  }

  /* ---------------------------------------------------------------- *
   * Moving
   * ---------------------------------------------------------------- */

  function next() {
    if (state.loading || !state.doc) return false;
    if (paged()) {
      if (state.page < state.pageCount - 1) {
        setPage(state.page + 1, 1);
        return true;
      }
    } else {
      const el = scroller();
      if (el.scrollTop + el.clientHeight < el.scrollHeight - 4) {
        el.scrollBy({ top: Math.round(el.clientHeight * 0.9) });
        return true;
      }
    }
    if (state.index >= book.sections.length - 1) return false;
    open(state.index + 1, {}).catch(() => {});
    return true;
  }

  function previous() {
    if (state.loading || !state.doc) return false;
    if (paged()) {
      if (state.page > 0) {
        setPage(state.page - 1, -1);
        return true;
      }
    } else {
      const el = scroller();
      if (el.scrollTop > 4) {
        el.scrollBy({ top: -Math.round(el.clientHeight * 0.9) });
        return true;
      }
    }
    if (state.index <= 0) return false;
    open(state.index - 1, { end: true }).catch(() => {});
    return true;
  }

  /* ---------------------------------------------------------------- *
   * Events from inside the frame
   * ---------------------------------------------------------------- */

  function bind(doc) {
    doc.addEventListener('click', (event) => {
      const nav = event.target.closest?.('[data-bw-nav]');
      if (nav) {
        event.preventDefault();
        if (nav.dataset.bwNav === 'next') open(state.index + 1, {}).catch(() => {});
        else open(state.index - 1, { end: true }).catch(() => {});
        return;
      }
      const link = event.target.closest?.('a[data-bw]');
      if (link) {
        event.preventDefault();
        onLink?.({
          kind: link.dataset.bw,
          url: link.dataset.url ?? '',
          path: link.dataset.path ?? '',
          fragment: link.dataset.frag ?? '',
          from: state.index,
        });
        return;
      }
      if (doc.getSelection()?.toString()) return; // the reader is selecting text
      const width = doc.documentElement.clientWidth || 1;
      const x = event.clientX / width;
      if (paged() && x < 0.28) onTap?.('left');
      else if (paged() && x > 0.72) onTap?.('right');
      else onTap?.('center');
    });
    doc.addEventListener('keydown', (event) => onKey?.(event));
    doc.addEventListener('pointermove', (event) => event.pointerType === 'mouse' && onActivity?.(), { passive: true });
    doc.addEventListener('scroll', () => !paged() && requestAnimationFrame(emit), { passive: true });

    let wheelAt = 0;
    doc.addEventListener(
      'wheel',
      (event) => {
        if (!paged() || event.ctrlKey) return;
        event.preventDefault();
        const now = performance.now();
        const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
        if (Math.abs(delta) < 12 || now - wheelAt < 320) return;
        wheelAt = now;
        if (delta > 0) next();
        else previous();
      },
      { passive: false },
    );

    let touch = null;
    doc.addEventListener('touchstart', (event) => {
      touch = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY, t: performance.now() } : null;
    }, { passive: true });
    doc.addEventListener('touchend', (event) => {
      if (!touch || !paged()) return;
      const end = event.changedTouches[0];
      const dx = end.clientX - touch.x;
      const dy = end.clientY - touch.y;
      const quick = performance.now() - touch.t < 700;
      touch = null;
      if (quick && Math.abs(dx) > 60 && Math.abs(dy) < 50) {
        if (dx < 0) next();
        else previous();
      }
    }, { passive: true });
  }

  return {
    open,
    next,
    previous,
    relayout: () => relayout(),
    setOptions(partial) {
      // Read the position under the old layout (pages or scroll) before it changes.
      const keep = state.doc && !state.loading ? fraction() : null;
      Object.assign(state.options, partial);
      relayout(keep);
    },
    get options() {
      return { ...state.options };
    },
    get index() {
      return state.index;
    },
    get loading() {
      return state.loading;
    },
    focus() {
      iframe.contentWindow?.focus();
    },
    scrollToFragment(fragment) {
      place({ fragment });
      emit();
    },
    destroy() {
      state.generation++;
      state.chapter?.revoke();
      iframe.remove();
    },
  };
}
