// "Add books" window: pick where the books come from (this device, Google Drive,
// Dropbox) or drop files on it. Also shows how much browser storage is left.

import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { ACCEPT } from '../lib/formats.js';
import { createStorageMeter } from './storageMeter.js';

/**
 * sources: { drive: true | 'soon' | false, dropbox: boolean }   ('soon' shows a disabled "Coming soon" tile)
 * handlers: { onFiles(files), onDrive(), onDropbox(), onDriveIntent(), onDropboxIntent() }
 *
 * The *Intent handlers fire when someone points at, focuses or presses a source's tile,
 * just before the click. They let a source warm up its third-party script in time for the
 * click without contacting Google or Dropbox for people who only add files from this device.
 */
export function openAddDialog({ sources, onFiles, onDrive, onDropbox, onDriveIntent, onDropboxIntent }) {
  const meter = createStorageMeter();
  const input = h('input', { type: 'file', accept: ACCEPT, multiple: true, class: 'hidden', 'aria-label': 'Choose book files from this device' });

  const dialog = h('dialog', { class: 'sheet', 'aria-labelledby': 'add-books-title' });
  const finish = (action) => {
    dialog.close();
    action();
  };

  const tile = (label, hint, iconName, onclick, id, onIntent) => {
    const el = h('button', { class: 'tile', type: 'button', 'data-source': id, onclick }, icon(iconName, 'size-7'), h('span', null, label), h('span', { class: 'tile-hint' }, hint));
    if (onIntent) for (const type of ['pointerenter', 'pointerdown', 'focus']) el.addEventListener(type, () => onIntent(), { passive: true });
    return el;
  };

  // A source that is not switched on yet: visible and focusable so people (and screen readers) can see it
  // is planned, but it does nothing, loads nothing and keeps the window open.
  const soonTile = (label, id) =>
    h(
      'button',
      { class: 'tile', type: 'button', 'data-source': id, 'aria-disabled': 'true', title: `${label} is coming soon`, onclick: (event) => event.preventDefault() },
      icon(id, 'size-7'),
      h('span', null, label),
      h('span', { class: 'tile-hint' }, 'Coming soon'),
    );

  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    if (files.length) finish(() => onFiles(files));
  });

  const dropzone = h(
    'div',
    { class: 'dropzone', 'data-over': 'false' },
    icon('upload', 'size-7'),
    h('p', { class: 'font-medium text-ink' }, 'Drop books here'),
    h('p', { class: 'text-sm' }, 'or choose where they are below'),
  );
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.dataset.over = 'true';
  });
  dropzone.addEventListener('dragleave', () => (dropzone.dataset.over = 'false'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.dataset.over = 'false';
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) finish(() => onFiles(files));
  });

  const tiles = h(
    'div',
    { class: 'tiles' },
    tile('This device', 'Files on this computer or phone', 'monitor', () => input.click(), 'device'),
    sources.drive === 'soon'
      ? soonTile('Google Drive', 'drive')
      : sources.drive
        ? tile('Google Drive', 'Pick books in Google\'s window', 'drive', () => finish(onDrive), 'drive', onDriveIntent)
        : null,
    sources.dropbox ? tile('Dropbox', 'Pick books, saved to this browser', 'dropbox', () => finish(onDropbox), 'dropbox', onDropboxIntent) : null,
  );

  const parts = [
    h(
      'div',
      { class: 'mb-4 flex items-center justify-between gap-4' },
      h('h2', { id: 'add-books-title', class: 'font-display text-2xl font-semibold tracking-tight' }, 'Add books'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, icon('x')),
    ),
    dropzone,
    h('p', { class: 'mb-2 mt-5 text-sm text-muted' }, 'Add from'),
    tiles,
    h('div', { class: 'mt-6 border-t border-line pt-4' }, meter.el),
    input,
  ];
  dialog.append(...parts.filter(Boolean)); // native append() would print a null as the word "null"

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close(); // click on the dimmed backdrop
  });
  dialog.addEventListener('close', () => {
    meter.destroy();
    dialog.remove();
  });

  document.body.append(dialog);
  dialog.showModal();
  meter.refresh();
  return dialog;
}
