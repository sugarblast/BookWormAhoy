import { createHash } from 'node:crypto';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { buildCsp } from './build/csp.js';

// Adds a Content-Security-Policy <meta> to the production HTML only (the dev
// server needs inline HMR scripts that a strict policy would block). The one
// inline script in index.html is allowed by its SHA-256 hash.
function contentSecurityPolicy() {
  return {
    name: 'bookworm:csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const inline = html.match(/<script data-boot>([\s\S]*?)<\/script>/);
        const hashes = inline
          ? [`'sha256-${createHash('sha256').update(inline[1]).digest('base64')}'`]
          : [];
        const meta = `<meta http-equiv="Content-Security-Policy" content="${buildCsp({ scriptHashes: hashes })}" />`;
        return html.replace('<!--csp-->', meta);
      },
    },
  };
}

export default defineConfig({
  // Relative base so the same build works at https://<user>.github.io/<repo>/
  // and at a custom domain. Routing uses the URL hash, so no 404.html tricks.
  base: './',
  plugins: [tailwindcss(), contentSecurityPolicy()],
  build: {
    // pdfjs-dist uses modern syntax (top-level await, private fields).
    target: 'esnext',
    chunkSizeWarningLimit: 1500,
  },
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
  server: {
    // Must match an "Authorized JavaScript origin" in your Google OAuth client.
    port: 5173,
    strictPort: true,
  },
});
