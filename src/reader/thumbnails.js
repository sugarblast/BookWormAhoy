// The "Pages" drawer: a grid of page thumbnails, rendered lazily as they
// scroll into view (two at a time) so a 1,000-page book opens instantly.

import { h } from '../lib/dom.js';

export async function createThumbnails({ pdf, host, onGo }) {
  const first = await pdf.getPage(1);
  const natural = first.getViewport({ scale: 1 });
  const defaultRatio = `${natural.width} / ${natural.height}`;
  first.cleanup();

  const items = new Map();
  const grid = h('div', { class: 'thumbs' });
  for (let page = 1; page <= pdf.numPages; page++) {
    const canvas = h('canvas', { class: 'paper', 'aria-hidden': 'true' });
    const frame = h('span', { class: 'thumb-frame', style: { aspectRatio: defaultRatio } }, canvas);
    const button = h(
      'button',
      { class: 'thumb', type: 'button', 'aria-label': `Go to page ${page}`, dataset: { page }, onclick: () => onGo(page) },
      frame,
      h('span', { class: 'thumb-label' }, page),
    );
    items.set(page, { button, frame, canvas, status: 'idle', task: null });
    grid.append(button);
  }
  host.replaceChildren(grid);

  const queue = [];
  let running = 0;
  let destroyed = false;
  let current = null;

  async function renderOne(page) {
    const item = items.get(page);
    item.status = 'rendering';
    try {
      const pdfPage = await pdf.getPage(page);
      const size = pdfPage.getViewport({ scale: 1 });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = pdfPage.getViewport({ scale: (150 * ratio) / size.width });
      item.canvas.width = Math.floor(viewport.width);
      item.canvas.height = Math.floor(viewport.height);
      item.frame.style.aspectRatio = `${size.width} / ${size.height}`;
      item.task = pdfPage.render({ canvas: item.canvas, viewport });
      await item.task.promise;
      item.status = 'done';
      pdfPage.cleanup();
    } catch (error) {
      item.status = error?.name === 'RenderingCancelledException' ? 'idle' : 'failed';
    } finally {
      item.task = null;
    }
  }

  function pump() {
    while (running < 2 && queue.length && !destroyed) {
      const page = queue.shift();
      if (items.get(page).status !== 'queued') continue; // scrolled away before its turn
      running++;
      renderOne(page).finally(() => {
        running--;
        pump();
      });
    }
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const page = Number(entry.target.dataset.page);
        const item = items.get(page);
        if (entry.isIntersecting && item.status === 'idle') {
          item.status = 'queued';
          queue.push(page);
        } else if (!entry.isIntersecting && item.status === 'queued') {
          item.status = 'idle';
        }
      }
      pump();
    },
    { root: host, rootMargin: '600px 0px' },
  );
  for (const { button } of items.values()) observer.observe(button);

  return {
    setCurrent(page) {
      if (current === page) return;
      items.get(current)?.button.removeAttribute('aria-current');
      current = page;
      const item = items.get(page);
      if (!item) return;
      item.button.setAttribute('aria-current', 'page');
      if (host.offsetParent !== null) item.button.scrollIntoView({ block: 'nearest' });
    },
    revealCurrent() {
      items.get(current)?.button.scrollIntoView({ block: 'center' });
    },
    destroy() {
      destroyed = true;
      observer.disconnect();
      for (const item of items.values()) item.task?.cancel();
    },
  };
}
