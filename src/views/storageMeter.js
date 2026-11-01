// "Storage" bar: how much of this site's browser space is used and how much is left.

import { formatBytes, h, toast } from '../lib/dom.js';

const size = (bytes) => formatBytes(bytes) || '0 B';
import { getStorage, requestPersistence } from '../lib/storage.js';

export function createStorageMeter() {
  const el = h('div', { class: 'storage', 'aria-label': 'Browser storage' });
  let destroyed = false;
  let version = 0;

  async function refresh() {
    const mine = ++version;
    const info = await getStorage();
    if (destroyed || mine !== version) return;
    if (!info.supported) {
      el.replaceChildren();
      return;
    }
    const used = info.quota ? info.usage / info.quota : 0;
    const percent = info.usage > 0 ? Math.max(1.5, used * 100) : 0;
    const ownTotal = info.own.books + info.own.covers;
    const lines = [
      `${info.own.bookCount} ${info.own.bookCount === 1 ? 'PDF is' : 'PDFs are'} saved in this browser (${size(info.own.books)}). Books from Google Drive are not copied here, only a small cover each.`,
    ];
    el.replaceChildren(
      h(
        'div',
        { class: 'flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1' },
        h('p', { class: 'text-sm font-medium' }, 'Storage in this browser'),
        h('p', { class: 'text-sm text-muted' }, `${size(info.free)} left of ${size(info.quota)}`),
      ),
      h(
        'div',
        {
          class: 'meter-track mt-2',
          role: 'progressbar',
          'aria-label': 'Browser storage used',
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': String(Math.round(used * 100)),
        },
        h('div', { class: 'meter-fill', 'data-warn': used > 0.8 ? 'true' : 'false', style: { width: `${percent}%` } }),
      ),
      h('p', { class: 'mt-2 text-xs text-muted' }, `Bookworm uses ${size(ownTotal)} of it. ${lines[0]}`),
      info.persisted
        ? h('p', { class: 'mt-1 text-xs text-muted' }, 'Protected: your browser will not clear these files on its own.')
        : h(
            'p',
            { class: 'mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted' },
            'If the disk fills up, your browser may clear these files.',
            h(
              'button',
              {
                class: 'font-medium text-ink underline underline-offset-2',
                type: 'button',
                onclick: async () => {
                  const granted = await requestPersistence();
                  toast(granted ? 'Done. Your browser will keep these files.' : 'Your browser did not agree. It decides based on how often you use the site.', { kind: granted ? 'info' : 'error' });
                  refresh();
                },
              },
              'Ask it to keep them',
            ),
          ),
    );
  }

  return {
    el,
    refresh,
    destroy() {
      destroyed = true;
    },
  };
}
