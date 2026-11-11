// Content-Security-Policy for the production build.
//
// The app keeps a short-lived Google access token in localStorage, so the
// main defence is making sure no foreign script can ever run on this origin.
// Only our own bundle, one hashed inline boot script (theme, avoids a flash of
// the wrong colours), Google's sign-in library and Google's script loader (for the
// "Open from Google Drive" file picker) are allowed to execute.
//
// Shared by vite.config.js (production build) and the local test harness.

export function buildCsp({ scriptHashes = [] } = {}) {
  const policy = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      // PDF.js decodes JPEG 2000 / JBIG2 scans with WebAssembly.
      "'wasm-unsafe-eval'",
      ...scriptHashes,
      'https://accounts.google.com/gsi/client',
      // The Picker's loader fetches its parts from several paths on this host,
      // so the whole host is allowed. If the picker ever opens blank, look for
      // a "Content-Security-Policy" error in the browser console and loosen here.
      'https://apis.google.com',
      // Dropbox's Chooser script ("Dropbox" source, only used when an app key is set).
      'https://www.dropbox.com',
    ],
    'style-src': ["'self'", "'unsafe-inline'", 'https://accounts.google.com/gsi/style'],
    'img-src': ["'self'", 'data:', 'blob:', 'https://*.googleusercontent.com'],
    'font-src': ["'self'", 'data:'],
    'connect-src': [
      "'self'",
      'blob:',
      'data:',
      'https://www.googleapis.com',
      'https://accounts.google.com/gsi/',
      // Downloading the PDFs picked in Dropbox (links may redirect between these hosts).
      'https://www.dropbox.com',
      'https://*.dropboxusercontent.com',
    ],
    // docs.google.com is the picker window itself.
    'frame-src': ['https://accounts.google.com/gsi/', 'https://docs.google.com'],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'none'"],
  };

  return Object.entries(policy)
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');
}
