// "Add books" window: pick where the PDFs come from (this device, Google Drive,
// Dropbox) or drop files on it. Also shows how much browser storage is left.

import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { createStorageMeter } from './storageMeter.js';

/**
 * sources: { drive: boolean, dropbox: boolean }
 * handlers: { onFiles(files), onDrive(), onDropbox(), onOpen() }
 */
export function openAddDialog({ sources, onFiles, onDrive, onDropbox, onOpen }) {
  const meter = createStorageMeter();
  const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: true, class: 'hidden', 'aria-label': 'Choose PDF files from this device' });

  const dialog = h('dialog', { class: 'sheet', 'aria-labelledby': 'add-books-title' });
  const finish = (action) => {
    dialog.close();
    action();
  };

  const tile = (label, hint, iconName, onclick, id) =>
    h('button', { class: 'tile', type: 'button', 'data-source': id, onclick }, icon(iconName, 'size-7'), h('span', null, label), h('span', { class: 'tile-hint' }, hint));

  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    if (files.length) finish(() => onFiles(files));
  });

  const dropzone = h(
    'div',
    { class: 'dropzone', 'data-over': 'false' },
    icon('upload', 'size-7'),
    h('p', { class: 'font-medium text-ink' }, 'Drop PDFs here'),
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
    sources.drive ? tile('Google Drive', 'Pick PDFs in Google\'s window', 'drive', () => finish(onDrive), 'drive') : null,
    sources.dropbox ? tile('Dropbox', 'Pick PDFs, saved to this browser', 'dropbox', () => finish(onDropbox), 'dropbox') : null,
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
  onOpen?.();
  return dialog;
}
