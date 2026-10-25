import { icon } from './icons.js';

export const $ = (selector, root = document) => root.querySelector(selector);

function appendAll(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/**
 * Tiny hyperscript helper. Text is always inserted as text nodes (never HTML),
 * which matters because Drive file names are controlled by whoever shared the
 * file with you.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style' && typeof value === 'object') {
        for (const [prop, v] of Object.entries(value)) {
          if (prop.startsWith('--')) el.style.setProperty(prop, v);
          else el.style[prop] = v;
        }
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2), value);
      } else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  appendAll(el, children);
  return el;
}

export const clear = (el) => el.replaceChildren();
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export async function mapLimit(items, limit, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
}

export function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function formatRelative(timestamp) {
  const diff = timestamp - Date.now();
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (abs < minute) return 'just now';
  if (abs < hour) return relative.format(Math.round(diff / minute), 'minute');
  if (abs < day) return relative.format(Math.round(diff / hour), 'hour');
  if (abs < 30 * day) return relative.format(Math.round(diff / day), 'day');
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function toast(message, { kind = 'info', timeout = 5000 } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  host.append(el);
  setTimeout(() => el.remove(), timeout);
}

/**
 * Small popover menu anchored to a button. `host` must be position: relative
 * and contain the anchor. Items: { label, hint?, checked?, onSelect } or { separator: true }.
 */
export function createMenu({ anchor, host, getItems, align = 'end' }) {
  let el = null;

  function close({ restoreFocus = false } = {}) {
    if (!el) return;
    el.remove();
    el = null;
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    if (restoreFocus) anchor.focus();
  }

  function onOutside(event) {
    if (el && !el.contains(event.target) && !anchor.contains(event.target)) close();
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close({ restoreFocus: true });
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const buttons = [...el.querySelectorAll('button')];
      const at = buttons.indexOf(document.activeElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(at + step + buttons.length) % buttons.length]?.focus();
      event.preventDefault();
    }
  }

  function renderItem(item) {
    if (item.separator) return h('hr', { class: 'menu-sep' });
    if (item.note) return h('div', { class: 'menu-note' }, item.note);
    const radio = item.checked !== undefined;
    return h(
      'button',
      {
        type: 'button',
        class: 'menu-item',
        role: radio ? 'menuitemradio' : 'menuitem',
        'aria-checked': radio ? String(!!item.checked) : null,
        onclick: () => {
          close({ restoreFocus: true });
          item.onSelect();
        },
      },
      h('span', { class: 'menu-check' }, item.checked ? icon('check', 'size-4') : null),
      h('span', { class: 'grow truncate' }, item.label),
      item.hint ? h('span', { class: 'text-xs text-muted' }, item.hint) : null,
    );
  }

  function open() {
    close();
    el = h('div', { class: `menu menu-${align}`, role: 'menu' }, getItems().map(renderItem));
    host.append(el);
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    (el.querySelector('[aria-checked="true"]') ?? el.querySelector('button'))?.focus();
  }

  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'false');
  anchor.addEventListener('click', () => (el ? close() : open()));

  return { open, close, isOpen: () => el !== null };
}
