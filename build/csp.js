// Content-Security-Policy for the production build.
//
// The app keeps a short-lived Google access token in localStorage, so the
// main defence is making sure no foreign script can ever run on this origin.
// Only our own bundle, one hashed inline boot script (theme, avoids a flash of
// the wrong colours) and Google's sign-in library are allowed to execute.
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
    ],
    'frame-src': ['https://accounts.google.com/gsi/'],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'none'"],
  };

  return Object.entries(policy)
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');
}
