// "Open from Google Drive": the Google Picker window. The user chooses PDFs in a
// Google-hosted dialog and the app receives access to exactly those files
// (scope `drive.file`), not the rest of the Drive.

import { getApiKey, getAppId } from '../config.js';

const LOADER_SRC = 'https://apis.google.com/js/api.js';
const PDF = 'application/pdf';

export class PickerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PickerError';
    this.code = code;
  }
}

let loading = null;

/** Loads Google's script and its Picker module once. Safe to call early to warm up. */
export function preloadPicker() {
  loading ??= new Promise((resolve, reject) => {
    const fail = (message) => {
      loading = null;
      reject(new PickerError(message, 'load'));
    };
    const loadModule = () =>
      window.gapi.load('picker', {
        callback: resolve,
        onerror: () => fail('Google Drive file picker could not start. Try again.'),
        timeout: 15_000,
        ontimeout: () => fail('Google Drive file picker took too long to start. Try again.'),
      });
    if (window.gapi?.load) return loadModule();
    const script = document.createElement('script');
    script.src = LOADER_SRC;
    script.async = true;
    script.onload = loadModule;
    script.onerror = () => {
      script.remove();
      fail('Could not load the Google Drive file picker. Check your connection or content blocker.');
    };
    document.head.append(script);
  });
  loading.catch(() => {});
  return loading;
}

const field = (doc, name, key) => doc?.[window.google.picker.Document?.[name] ?? key] ?? doc?.[key];

function toFile(doc) {
  const edited = Number(field(doc, 'LAST_EDITED_UTC', 'lastEditedUtc'));
  return {
    id: String(field(doc, 'ID', 'id')),
    name: String(field(doc, 'NAME', 'name') ?? 'Untitled.pdf'),
    mimeType: String(field(doc, 'MIME_TYPE', 'mimeType') ?? ''),
    size: Number(field(doc, 'SIZE_BYTES', 'sizeBytes')) || 0,
    modifiedTime: edited > 0 ? new Date(edited).toISOString() : null,
  };
}

/**
 * Opens the picker and resolves with the PDFs the user chose ([] if they
 * cancelled). `token` is a fresh `drive.file` access token.
 */
export async function pickPdfs({ token }) {
  const apiKey = getApiKey();
  if (!apiKey) throw new PickerError('Google Drive picking needs an API key. See the README.', 'no_api_key');
  await preloadPicker();
  const picker = window.google.picker;

  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS).setMimeTypes(PDF).setIncludeFolders(true);
    const builder = new picker.PickerBuilder()
      .addView(view)
      .setTitle('Choose PDFs')
      .setOAuthToken(token)
      .setDeveloperKey(apiKey)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setCallback((data) => {
        const action = data[picker.Response.ACTION];
        if (action === picker.Action.PICKED) {
          const docs = data[picker.Response.DOCUMENTS] ?? [];
          resolve(docs.map(toFile).filter((file) => file.id && file.mimeType === PDF));
        } else if (action === picker.Action.CANCEL) {
          resolve([]);
        }
      });
    const appId = getAppId();
    if (appId) builder.setAppId(appId);
    builder.build().setVisible(true);
  });
}
